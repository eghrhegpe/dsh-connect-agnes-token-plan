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
import { str } from "./util.ts";
import { readPanelValue, resolveSwitchEnabled } from "./switch-precedence.ts";

/** How long a failed re-harvest blocks further re-harvest attempts. */
export const AGNESCODE_REHARVEST_BACKOFF_MS = 60_000;

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
 * @param {(service: string) => object|null} options.getLlm - the optional
 *   `llm` service resolver.
 * @param {() => Promise<object>} [options.loadAdapterModule] - the lazy peer
 *   adapter module loader; defaults to `import("./agnescode-llm-adapter.ts")`.
 * @param {(event: string) => void} [options.emit] - `ctx.emit` for adapter
 *   update events.
 * @param {object} [options.logger] - `ctx.logger`.
 * @returns {{publisher: object, seed: () => Promise<void>}} the publisher and
 *   its mount-seed function.
 */
export function wireAgnescodePublisher({ store, panelSwitch, getLlm, loadAdapterModule, emit, logger }: {
  store: {
    resolve: () => Promise<{ credential: { accessToken: string; bffBase?: string } | null }>;
    isExpired: () => Promise<boolean>;
    save: (credential: Record<string, unknown>) => Promise<unknown>;
  };
  panelSwitch?: () => Promise<boolean | null>;
  getLlm: (service: string) => object | null;
  loadAdapterModule?: () => Promise<{ createAgnescodeAdapter: (...args: any[]) => any }>;
  emit?: (event: string) => void;
  logger?: any;
}) {
  // Single-flight + backoff state shared across all resolveToken calls for
  // this wiring instance (the equivalent of the closure variables the old
  // inline version held in apply()'s scope).
  const harvest: { inFlight: Promise<unknown> | null; blockedUntil: number } = { inFlight: null, blockedUntil: 0 };

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
              await pub.publish(AGNESCODE_FALLBACK_MODELS, walk.session.bffBase).catch(() => {});
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
   * fallback roster + the stored credential's per-account base. Fire-and-
   * forget safe: a state dir that cannot be read just waits for the first
   * switch/harvest action.
   * @returns {Promise<void>}
   */
  const seed = async () => {
    try {
      // Panel-only switch: no config default, so "unset" is off.
      if (resolveSwitchEnabled(await readPanelValue(panelSwitch)).enabled) {
        const { credential } = await store.resolve().catch(() => ({ credential: null }));
        await publisher.publish(AGNESCODE_FALLBACK_MODELS, credential?.bffBase ?? "");
      }
    } catch {
      // No seed: the first switch/harvest publishes.
    }
  };

  return { publisher, seed };
}

export { AGNESCODE_FALLBACK_MODELS };
