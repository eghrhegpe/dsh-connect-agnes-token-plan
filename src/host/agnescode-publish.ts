/**
 * The AgnesCode provider's PUBLISH STATE MACHINE — the peer-free control plane
 * of the third upstream provider (ROADMAP §6.3).
 *
 * Deliberate BOUNDARY: this is an independent publisher. It shares NONE
 * of the Token Plan publisher's state (`provider-publish.ts`) — an AgnesCode
 * switch flip, re-harvest, or catalogue drift can never register, release, or
 * churn the Token Plan provider (§5.5 isolation). It carries the same three load-bearing
 * semantics, restated:
 *   - the publish chain queues a publish behind every one in flight;
 *   - the `disposed` gate stops a late publish registering into a withdrawn
 *     Host;
 *   - the single-point `registerPair` (factory-await + shape check, PITFALLS
 *     §19) serves both the publish and the rollback path.
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
import { str, redactSecrets } from "./util.ts";
import { name as pluginName } from "./host-config.ts";
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

  /** Set once the plugin is disposed; a later publish is a no-op. */
  let disposed = false;

  /** Resolve the peer-dependent adapter factory once and memoize it. */
  let adapterFactoryPromise;
  const resolveAdapterFactory = async () => {
    if (adapterFactoryPromise === undefined) {
      adapterFactoryPromise = Promise.resolve(effectiveLoadAdapterModule()).then((mod) => mod.createAgnescodeAdapter);
    }
    return adapterFactoryPromise;
  };

  /** Release the registered pair. Releases are idempotent in the Host. */
  const release = () => {
    const releaseFn = (fn) => {
      try {
        fn?.();
      } catch {
        // The service may already be gone during shutdown or rollback.
      }
    };
    releaseFn(state.releaseAdapter);
    releaseFn(state.releaseDirectory);
    state.releaseAdapter = null;
    state.releaseDirectory = null;
  };

  /**
   * Hand one built adapter to the llm service and record its release
   * functions onto `target` — defined ONCE, used by publish and rollback.
   */
  const registerPair = (llm, built, target) => {
    target.releaseAdapter = llm.registerAdapter(built.providerIds, built.adapter);
    target.releaseDirectory = typeof llm.registerConfigurableProviders === "function"
      ? llm.registerConfigurableProviders([{
          provider: AGNESCODE_PROVIDER_ID,
          displayName: AGNESCODE_DISPLAY_NAME,
          settingsNs: pluginName,
          settingsPath: [],
          declared: false
        }])
      : null;
  };

  /** Publishes are serialized through this chain (no lock object; a rejected
   *  link never poisons the ones behind it). */
  let publishChain = Promise.resolve();

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
  const publishProviderOnce = async (rows, bffBase = "") => {
    if (disposed) return { ok: false, skipped: true };
    const previousBuilt = state.built;
    const previousRows = state.rows;
    const previousBase = state.bffBase;
    state.rows = Array.isArray(rows) ? rows : [];
    state.bffBase = str(bffBase, "");
    state.signature = agnescodeSignature(state.rows, state.bffBase);

    const panelValue = await effectivePanelSwitch().catch(() => null);
    const registerWanted = panelValue === true;
    if (!registerWanted) {
      release();
      state.registered = false;
      state.built = null;
      state.error = null;
      return { ok: true, skipped: true };
    }

    const llm = effectiveGetLlm("llm");
    state.llmAvailable = llm !== null && typeof llm.registerAdapter === "function";
    if (!state.llmAvailable) {
      release();
      state.registered = false;
      state.error = "the Host exposes no llm registration service";
      return { ok: false, error: state.error };
    }

    const token = await effectiveResolveToken().catch(() => "");
    if (token === null || token === "" || state.bffBase === "") {
      release();
      state.registered = false;
      state.error = "not_configured";
      return { ok: true, skipped: true };
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
      if (built === null || typeof built !== "object"
        || !Array.isArray(built.providerIds) || built.adapter === undefined) {
        throw new Error("the adapter factory did not return { adapter, providerIds }");
      }
    } catch (error) {
      const note = redactSecrets(error instanceof Error ? error.message : String(error));
      state.error = note;
      effectiveLogger?.warn?.(
        `${pluginName}: cannot build the AgnesCode adapter: ${note}`
          + (error?.code === "ERR_MODULE_NOT_FOUND"
            ? " — the llm peer packages ship with the Host; install this plugin where they resolve"
            : "")
      );
      return { ok: false, error };
    }

    // Build first (it can throw); only then take down the old pair.
    release();
    try {
      registerPair(llm, built, state);
    } catch (error) {
      release();
      state.built = null;
      state.rows = previousRows;
      state.bffBase = previousBase;
      state.error = redactSecrets(error instanceof Error ? error.message : String(error));
      if (previousBuilt !== null) {
        try {
          registerPair(llm, previousBuilt, state);
          state.built = previousBuilt;
          state.registered = true;
        } catch {
          state.built = null;
          state.registered = false;
        }
      } else {
        state.registered = false;
      }
      return { ok: false, error };
    }
    state.built = built;
    state.registered = true;
    state.error = null;
    try {
      effectiveEmit("llm/adapters-updated");
    } catch {
      // A Host that refuses the event still has the registration; readers
      // refresh on their own cadence.
    }
    return { ok: true };
  };

  /** Publish, queued behind every other in-flight publish. */
  const publish = (rows, bffBase) => {
    const queued = publishChain.then(
      () => publishProviderOnce(rows, bffBase),
      () => publishProviderOnce(rows, bffBase)
    );
    publishChain = queued.then(() => undefined, () => undefined);
    return queued;
  };

  /** Mark the publisher disposed: any later publish is a no-op. */
  const dispose = () => {
    disposed = true;
  };

  return {
    state,
    publish,
    release,
    dispose,
    isDisposed: () => disposed
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
export function agnescodeSignature(rows, bffBase = "") {
  const models = (Array.isArray(rows) ? rows : [])
    .map((row) => `${str(row?.id, "")}:${row?.vision === true ? 1 : 0}`)
    .join(",");
  return `${str(bffBase, "")}|${models}`;
}
