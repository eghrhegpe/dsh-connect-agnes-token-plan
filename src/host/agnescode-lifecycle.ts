/**
 * The AgnesCode desktop-app upstream's re-harvest wiring (ROADMAP §6.3).
 *
 * Extracted from `index.ts`'s `apply()` so the mount seam stays a thin router
 * (its own discipline: "the heavy lifting lives in focused sibling modules").
 *
 * What this module owns:
 *   - the single-flighted re-harvest walk (`harvestAgnescodeLocalSession`):
 *     one PowerShell spawn at a time, a failed walk buys a 60 s backoff
 *     window during which nobody retries;
 *   - the cross-account bffBase rebuild: a re-harvest that landed on another
 *     account/base must re-publish, or B's token rides to A's base;
 *   - the mount seed: if the switch survived a restart, re-register from the
 *     fallback roster + the stored credential's per-account base.
 *
 * Peer-free: imports no Host peer. The lazy adapter load and the emit are
 * injected by the caller (`apply`), matching the provider publisher's
 * injection contract.
 *
 * @module dsh-connect-agnes-token-plan/agnescode-lifecycle
 */

import {
  harvestAgnescodeLocalSession,
  decodeAgnescodeJwtExpMs,
  AGNESCODE_FALLBACK_MODELS
} from "./agnescode.ts";
import { createAgnescodePublisher } from "./agnescode-publish.ts";
import { filterAgnescodeRows } from "./agnescode-models.ts";
import { str, retryBounded } from "./util.ts";
import { readPanelValue, resolveSwitchEnabled } from "./switch-precedence.ts";

/** How long a failed re-harvest blocks further re-harvest attempts. */
export const AGNESCODE_REHARVEST_BACKOFF_MS = 60_000;

/** How many times the mount seed retries before giving up. */
export const AGNESCODE_SEED_ATTEMPTS = 6;
/** Backoff base for the mount seed (linear: delayMs × attempt index). */
export const AGNESCODE_SEED_DELAY_MS = 300;

/**
 * Wire the AgnesCode publisher with its full single-flight + backoff +
 * cross-base-rebuild `resolveToken` seam.
 *
 * The credential is re-harvested from the desktop App's os_crypt session file
 * when it expires (there is NO refresh endpoint, ROADMAP §6.3). The walk runs
 * a PowerShell command, so a per-request storm of it is the price of an
 * expiring credential with the App gone: one walk at a time, and a failed
 * walk buys a short window where nobody retries — the request rides the
 * stored token and surfaces the 401 upstream, where the panel can see it,
 * instead of every call paying the harvest cost forever.
 *
 * The single-flight and backoff state must live for the lifetime of the
 * wiring (across many `resolveToken` calls), so it is held on a shared
 * `harvest` object rather than in a per-call closure.
 *
 * @param {object} options - wiring.
 * @param {object} options.store - the `createAgnescodeStore` instance.
 * @param {() => Promise<boolean|null>} options.panelSwitch - the panel's live
 *   switch (`agnescode-switch-store.enabled()`); null when no switch file.
 * @param {() => Promise<string[]>} [options.enabledIds] - the panel's curated
 *   model ids (`agnescode-models-store.listEnabledIds()`); empty = no curation.
 * @param {(service: string) => object|null} options.getLlm - the optional
 *   `llm` service resolver.
 * @param {() => Promise<object>} [options.loadAdapterModule] - the lazy peer
 *   adapter module loader; defaults to `import("./agnescode-llm-adapter.ts")`.
 * @param {(event: string) => void} [options.emit] - `ctx.emit` for adapter
 *   update events.
 * @param {object} [options.logger] - `ctx.logger`.
 * @param {{attempts?: number, delayMs?: number}} [options.seedOptions] - the
 *   mount seed's retry window; overridable so a test can shrink it.
 * @returns {{publisher: object, seed: () => Promise<void>}} the publisher and
 *   its mount-seed function.
 */
export function wireAgnescodePublisher({ store, panelSwitch, enabledIds, getLlm, loadAdapterModule, emit, logger, seedOptions = {} }: {
  store: {
    resolve: () => Promise<{ credential: { accessToken: string; bffBase?: string } | null }>;
    isExpired: () => Promise<boolean>;
    save: (credential: Record<string, unknown>) => Promise<unknown>;
  };
  panelSwitch?: () => Promise<boolean | null>;
  enabledIds?: () => Promise<string[]>;
  getLlm: (service: string) => object | null;
  loadAdapterModule?: () => Promise<{ createAgnescodeAdapter: (...args: any[]) => any }>;
  emit?: (event: string) => void;
  logger?: any;
  seedOptions?: { attempts?: number; delayMs?: number };
}) {
  // Single-flight + backoff state shared across all resolveToken calls for
  // this wiring instance (the equivalent of the closure variables the old
  // inline version held in apply()'s scope).
  const harvest: { inFlight: Promise<unknown> | null; blockedUntil: number } = { inFlight: null, blockedUntil: 0 };

  /**
   * The panel's curation, resolved fresh at each publish so a save between
   * publishes is honoured without any extra plumbing. An unreadable store is
   * "no curation" — the roster rides whole, never to nothing.
   * @returns {Promise<string[]>} the curated ids.
   */
  const curated = async (): Promise<string[]> => {
    if (enabledIds === undefined) return [];
    return enabledIds().catch(() => []);
  };

  // The cross-base rebuild reads the live publisher's `state.bffBase`, so the
  // resolveToken closure must be built AFTER the publisher exists. A deferred
  // holder breaks the circular construction: the publisher's options carry
  // the holder, the holder's fill happens one line after the constructor
  // returns.
  const holder: { current: ReturnType<typeof createAgnescodePublisher> | null } = { current: null };

  const resolveToken = async () => {
    const { credential } = await store.resolve();
    if (credential === null) return "";
    if (await store.isExpired().catch(() => false)) {
      if (harvest.inFlight === null && Date.now() >= harvest.blockedUntil) {
        harvest.inFlight = harvestAgnescodeLocalSession()
          .then(async (walk) => {
            harvest.inFlight = null;
            if (walk?.ok !== true) {
              harvest.blockedUntil = Date.now() + AGNESCODE_REHARVEST_BACKOFF_MS;
              logger?.warn?.(`agnescode: re-harvest found no usable session (${walk?.attempts?.length ?? 0} probed files); riding the stored token until ${new Date(harvest.blockedUntil).toISOString()}`);
              return null;
            }
            const expMs = decodeAgnescodeJwtExpMs(walk.session.accessToken);
            await store.save({
              ...walk.session,
              ...(expMs !== undefined ? { expiresAtMs: expMs } : {})
            }).catch((why: unknown) => {
              logger?.warn?.(`agnescode: re-harvest succeeded but the store refused it: ${str((why as { message?: unknown })?.message ?? why, "unknown")}`);
            });
            const pub = holder.current;
            if (pub && walk.session.bffBase !== pub.state.bffBase) {
              await pub.publish(filterAgnescodeRows(AGNESCODE_FALLBACK_MODELS, await curated()), walk.session.bffBase).catch(() => {});
            }
            return walk;
          })
          .catch(() => {
            harvest.inFlight = null;
            harvest.blockedUntil = Date.now() + AGNESCODE_REHARVEST_BACKOFF_MS;
            return null;
          });
      }
      await Promise.resolve(harvest.inFlight).catch(() => null);
    }
    const { credential: live } = await store.resolve();
    return live?.accessToken ?? "";
  };

  const publisher = createAgnescodePublisher({
    panelSwitch: panelSwitch ?? (async () => null),
    resolveToken,
    getLlm,
    loadAdapterModule: loadAdapterModule ?? (() => import("./agnescode-llm-adapter.ts")),
    emit: emit ?? (() => {}),
    logger
  });
  holder.current = publisher;

  /**
   * The mount seed: if the switch survived a restart, re-register from the
   * fallback roster + the stored credential's per-account base.
   *
   * It retries INSIDE a bounded window rather than running once, because the
   * two things it needs can register AFTER this plugin mounts: the
   * `credentials` service (the credential is read through it, and a Host early
   * in its boot resolves nothing) and the `llm` registration service (without
   * it the publish gates off with `no llm registration service`). A one-shot
   * seed that missed either left the picker empty for the whole session while
   * the tab said "logged in" — nothing elsewhere re-ran the publish, so the
   * panel's entry GET was the only repair. Every attempt re-reads both, and
   * the loop stops as soon as `state.registered` flips.
   *
   * Fire-and-forget safe: a state dir that cannot be read just waits for the
   * first switch/harvest action, and a deployment that never enabled the
   * switch stays pristine (the switch is re-read each attempt, so a concurrent
   * panel flip to OFF is honoured instead of being raced).
   * @returns {Promise<void>}
   */
  const seed = async () => {
    const attempts = seedOptions.attempts ?? AGNESCODE_SEED_ATTEMPTS;
    const delayMs = seedOptions.delayMs ?? AGNESCODE_SEED_DELAY_MS;
    try {
      await retryBounded({
        attempts,
        delayMs,
        run: async () => {
          if (publisher.isDisposed()) return true;
          // Panel-only switch: no config default, so "unset" is off.
          if (!resolveSwitchEnabled(await readPanelValue(panelSwitch)).enabled) return true;
          const { credential } = await store.resolve().catch(() => ({ credential: null }));
          // No credential yet — most likely the credentials service has not
          // registered at this point in the mount. Keep trying inside the
          // window rather than giving up on the first read.
          if (!credential?.accessToken || !credential?.bffBase) return false;
          await publisher.publish(filterAgnescodeRows(AGNESCODE_FALLBACK_MODELS, await curated()), credential.bffBase).catch(() => {});
          if (publisher.state.registered === true) return true;
          if (publisher.isDisposed()) return true;
          // Still unregistered: the `llm` service may not be resolvable yet, or
          // a peer module is still loading. Back off and try the whole build
          // again — publish is idempotent. A permanent failure fails fast after
          // the window and stays visible on the tab.
          return false;
        }
      });
    } catch {
      // No seed: the first switch/harvest publishes.
    }
  };

  return { publisher, seed };
}

export { AGNESCODE_FALLBACK_MODELS };
