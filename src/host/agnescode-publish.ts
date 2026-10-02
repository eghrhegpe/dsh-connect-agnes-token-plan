/**
 * The AgnesCode provider's PUBLISH STATE MACHINE — the peer-free control plane
 * of the third upstream provider (ROADMAP §6.3).
 *
 * Deliberate BOUNDARY: this is an independent publisher. It shares NONE of the
 * Token Plan publisher's STATE (`provider-publish.ts`) — an AgnesCode switch
 * flip, re-harvest, or catalogue drift can never register, release, or churn
 * the Token Plan provider (§5.5 isolation). What it does share is the
 * MECHANISM: the publish chain, the `disposed` gate and the single-point
 * `registerPair` live in `publish-core.ts`, one copy for both publishers.
 * Isolation is about separate state instances, not about duplicated code —
 * and this file used to say its semantics were "restated", which is the
 * honest word for copied (and how its "no credential" branch drifted into
 * leaving a stale `built` behind).
 *
 * The difference that shapes the publish: the offered set is driven by THREE
 * facts — "is the switch on?", "is there a (harvested) credential?", and the
 * credential's per-account BFF base — and the offered-set signature includes
 * that base, so a re-harvest that lands on a different base rebuilds.
 *
 * Peer-free: the adapter factory is injected (`loadAdapterModule`, defaulting
 * to `import("./agnescode-llm-adapter.ts")`), so the offline suites substitute
 * a fake factory without touching the Host's node_modules.
 *
 * @module dsh-connect-agnes-token-plan/agnescode-publish
 */

import { AGNESCODE_PROVIDER_ID, AGNESCODE_DISPLAY_NAME } from "./agnescode-models.ts";
import { str } from "./util.ts";
import { readPanelValue, resolveSwitchEnabled } from "./switch-precedence.ts";
import {
  createPublishQueue,
  createPairReleaser,
  createAdapterFactoryResolver,
  registerProviderPair,
  isBuiltAdapter,
  BAD_FACTORY_SHAPE_ERROR,
  describeBuildFailure,
  warnBuildFailure,
  swapRegistration,
  resolveRegistrationService,
  unregister
} from "./publish-core.ts";
import type { AgnescodePublisherDeps } from "./types.ts";

/**
 * The AgnesCode provider publisher.
 *
 * @param {object} [deps]
 * @param {() => Promise<boolean|null>} [deps.panelSwitch] - the panel-saved
 *   value (`agnescode-switch-store.enabled()`); `null` when the state file is
 *   untouched (in which case the provider stays off — opt-in default OFF).
 * @param {() => Promise<string>} [deps.resolveToken] - resolves the live
 *   AgnesCode JWT per request (`agnescode-store` seam); empty when no
 *   credential has been harvested.
 * @param {(service: string) => object|null} [deps.getLlm] - optional-service
 *   resolver for the `llm` registration service.
 * @param {() => Promise<{createAgnescodeAdapter: Function}>} [deps.loadAdapterModule] -
 *   the peer-dependent adapter factory module; defaults to the real
 *   `agnescode-llm-adapter.ts`.
 * @param {(event: string) => void} [deps.emit] - `ctx.emit` for the adapter
 *   update event.
 * @param {object} [deps.logger] - `ctx.logger` for the build-failure warning.
 * @returns {{
 *   state: object,
 *   publish: (rows: object[], bffBase: string) => Promise<object>,
 *   release: () => void,
 *   dispose: () => void,
 *   isDisposed: () => boolean
 * }}
 */
export function createAgnescodePublisher(deps: AgnescodePublisherDeps = {}) {
  const {
    panelSwitch,
    resolveToken,
    getLlm,
    loadAdapterModule,
    emit,
    logger
  } = deps;
  const effectivePanelSwitch = panelSwitch ?? (async () => null);
  const effectiveResolveToken = resolveToken ?? (async () => "");
  const effectiveLoadAdapterModule = loadAdapterModule ?? (() => import("./agnescode-llm-adapter.ts"));
  const effectiveGetLlm = getLlm ?? (() => null);
  const effectiveEmit = emit ?? (() => {});
  const effectiveLogger = logger ?? { warn: () => {} };

  /** The live AgnesCode registration state. */
  const state = {
    /** The roster the current registration was built from. */
    rows: [] as unknown[],
    /** The per-account BFF base the current registration addresses. */
    bffBase: "",
    /** A cheap signature of the offered roster (ids + vision bits + base). */
    signature: "",
    /** Whether an `llm` service answering `registerAdapter` is present. */
    llmAvailable: false,
    /** Whether the AgnesCode provider pair is registered without error. */
    registered: false,
    /** The last registration error, surfaced secret-free in the snapshot. */
    error: null as string | null,
    releaseAdapter: null as (() => void) | null,
    releaseDirectory: null as (() => void) | null,
    /** The built adapter the active release functions belong to. */
    built: null as any
  };

  /** The publish queue and the `disposed` gate — shared with the Token Plan
   *  publisher (`publish-core.ts`), so the two cannot drift apart. */
  const queue = createPublishQueue();

  /** Resolve the peer-dependent adapter factory once and memoize it. */
  const resolveAdapterFactory = createAdapterFactoryResolver(
    effectiveLoadAdapterModule,
    "createAgnescodeAdapter"
  );

  /** Release the registered pair. Releases are idempotent in the Host. */
  const release = createPairReleaser(state);

  /**
   * Hand one built adapter to the llm service and record its release
   * functions onto `target` — the shared single-point registrar (PITFALLS
   * §19), used by both the publish and the rollback path.
   */
  const registerPair = (llm: any, built: any, target: any) => registerProviderPair(llm, built, target, {
    providerId: AGNESCODE_PROVIDER_ID,
    displayName: AGNESCODE_DISPLAY_NAME
  });

  /**
   * (Re)build and register the AgnesCode provider for one roster snapshot.
   *
   * The publish decision is a three-way gate:
   *   - switch OFF              → release, no registration (opt-in default);
   *   - switch ON, no token     → release, `error: not_configured` (the
   *                               panel's「重新检测」affordance says so);
   *   - switch ON, token + base → build + register the roster.
   * On a failed registration the PREVIOUS pair is restored.
   * @param {object[]} rows - the roster rows (`agnescodeRoster`).
   * @param {string} bffBase - the credential's pinned per-account BFF base.
   * @returns {Promise<{ok: boolean, skipped?: boolean, error?: unknown}>}
   */
  const publishProviderOnce = async (rows: readonly any[], bffBase = "") => {
    if (queue.isDisposed()) return { ok: false, skipped: true };
    const previousBuilt = state.built;
    const previousRows = state.rows;
    const previousBase = state.bffBase;
    state.rows = Array.isArray(rows) ? rows : [];
    state.bffBase = str(bffBase, "");
    state.signature = agnescodeSignature(state.rows, state.bffBase);

    // No config default (AgnesCode has no `Settings` key), so an unset panel
    // value means off — never a fallback nobody declared.
    const registerWanted = resolveSwitchEnabled(await readPanelValue(effectivePanelSwitch)).enabled;
    if (!registerWanted) return unregister({ state, release });

    const llm = resolveRegistrationService({ state, getLlm: effectiveGetLlm, release });
    if (llm === null) return { ok: false, error: state.error };

    const token = await effectiveResolveToken().catch(() => "");
    if (token === null || token === "" || state.bffBase === "") {
      return unregister({ state, release, error: "not_configured" });
    }

    let createAgnescodeAdapter;
    let built;
    try {
      createAgnescodeAdapter = await resolveAdapterFactory();
      // Awaited, not assumed synchronous: an async factory that returns a
      // Promise to `registerAdapter` would hand the Host an `undefined`
      // adapter — a failure that surfaces as broken model routing.
      built = await createAgnescodeAdapter({
        rows: state.rows,
        bffBase: state.bffBase,
        resolveToken: effectiveResolveToken,
        get: effectiveGetLlm
      });
      if (!isBuiltAdapter(built)) throw new Error(BAD_FACTORY_SHAPE_ERROR);
    } catch (error) {
      // Shared with the Token Plan publisher: redaction and the
      // ERR_MODULE_NOT_FOUND remedy live in `publish-core.ts`, so a fix to
      // that diagnosis reaches both upstreams at once.
      const described = describeBuildFailure(error);
      state.error = described.note;
      warnBuildFailure(effectiveLogger, "AgnesCode", described);
      return { ok: false, error: described.error };
    }

    // The swap (and the rollback behind it) is the shared mechanism; what is
    // restored on THIS side is the roster identity and its per-account base.
    return swapRegistration({
      llm,
      built,
      previousBuilt,
      state,
      release,
      registerPair,
      emit: effectiveEmit,
      onRollback: () => {
        state.rows = previousRows;
        state.bffBase = previousBase;
      }
    });
  };

  /** Publish, queued behind every other in-flight publish. */
  const publish = (rows: readonly any[], bffBase: string) => queue.enqueue(() => publishProviderOnce(rows, bffBase));

  /** Mark the publisher disposed: any later publish is a no-op. */
  const dispose = () => queue.dispose();

  return {
    state,
    publish,
    release,
    dispose,
    isDisposed: () => queue.isDisposed()
  };
}

/**
 * A cheap signature of the AgnesCode offered roster: the model ids, each
 * tagged with the vision bit, over the per-account base — an id whose
 * modality flipped OR a re-harvest that landed on another base must rebuild
 * even though the id list did not change.
 * @param {object[]} rows - the `agnescodeRoster` result.
 * @param {string} bffBase - the pinned per-account base.
 * @returns {string}
 */
export function agnescodeSignature(rows: readonly any[], bffBase = "") {
  const models = (Array.isArray(rows) ? rows : [])
    .map((row) => `${str(row?.id, "")}:${row?.vision === true ? 1 : 0}`)
    .join(",");
  return `${str(bffBase, "")}|${models}`;
}
