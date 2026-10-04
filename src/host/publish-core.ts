/**
 * The shared bones of a provider publisher — the parts that MUST NOT differ
 * between upstreams, factored out so they cannot drift.
 *
 * Both publishers (`provider-publish.ts` for the Token Plan provider,
 * `agnescode-publish.ts` for the desktop-app upstream) run the same control
 * plane: a publish queue, a `disposed` gate, and a single-point pair
 * registration that doubles as the rollback path. Those three are load-bearing
 * and pinned by tests (PITFALLS §18 for the queue, §19 for the register shape)
 * — and the rollback is the worst place to discover a divergence, because it
 * only runs once something has already failed. They used to be written twice,
 * with `agnescode-publish.ts` saying its semantics were "restated" — which is
 * the honest word for copied — and keeping the copies in sync relied on
 * comments in one file pointing at the other. Here there is one copy.
 *
 * What is deliberately NOT shared: the publish GATE and the state shape. The
 * Token Plan side decides from "switch on?" plus a persisted catalog and an
 * allow-list, and restores `entries`/`enabledIds`/quota ids on a rollback; the
 * AgnesCode side decides from "switch on?" plus "is there a harvested
 * credential?" plus that credential's per-account BFF base, and restores its
 * roster and base. That difference is real domain difference, and folding it
 * into one parameterized state machine would make a publish unreadable —
 * every reader would have to read the configuration to know what one does.
 *
 * Peer-free: touches no runtime peer, only `host-config.ts` and `util.ts`, so
 * the offline suites drive every branch with fakes.
 *
 * @module dsh-connect-agnes-token-plan/publish-core
 */

import { redactSecrets } from "./util.ts";
import { name as pluginName } from "./host-config.ts";

/** The event a successful (re)registration emits so readers refresh. */
export const ADAPTERS_UPDATED_EVENT = "llm/adapters-updated";

/** The error a publisher reports when the Host exposes no `llm` service. */
export const NO_LLM_SERVICE_ERROR = "the Host exposes no llm registration service";

/** The shape check both publishers raise on a bad factory result. */
export const BAD_FACTORY_SHAPE_ERROR = "the adapter factory did not return { adapter, providerIds }";

/** What a built adapter must look like before it is registered Host-wide. */
export interface BuiltAdapter {
  providerIds: string[];
  adapter: unknown;
}

/**
 * The slice of a publisher's state the shared control plane touches.
 *
 * Both publishers' state objects carry MORE than this (the Token Plan side
 * also keeps its catalog/allow-list/quota identity, the AgnesCode side its
 * roster and base); this is only what the shared mechanism reads and writes,
 * which is exactly what keeps those extra fields free to differ.
 */
export interface PublisherState {
  /** Whether an `llm` service answering `registerAdapter` is present. */
  llmAvailable: boolean;
  /** Whether the provider pair is currently registered without error. */
  registered: boolean;
  /** The last registration error, surfaced secret-free in the snapshot. */
  error: string | null;
  releaseAdapter: (() => void) | null;
  releaseDirectory: (() => void) | null;
  /**
   * The built adapter the active release functions belong to — the rollback
   * target for the NEXT publish.
   */
  built: BuiltAdapter | null;
}

/**
 * A publisher's `ctx.logger`. Loose on the extra parameters because the peer
 * packages ship no declarations here; the message is the part both callers
 * agree on.
 */
export interface PublisherLogger {
  warn?: (message: string, ...rest: unknown[]) => void;
}

/** A publisher's own row on the models settings page. */
export interface ProviderIdentity {
  providerId: string;
  displayName: string;
}

/** The redacted failure note, the optional remedy, and the original value. */
export interface DescribedBuildFailure {
  note: string;
  hint: string;
  error: unknown;
}

/** The shared publish queue plus the `disposed` gate it carries. */
export interface PublishQueue {
  /** Queue `task` behind everything in flight and resolve with its result. */
  enqueue<T>(task: () => Promise<T>): Promise<T>;
  /** Whether the publisher has been disposed. */
  isDisposed(): boolean;
  /** Mark the publisher disposed; every later publish becomes a no-op. */
  dispose(): void;
}

/**
 * A publish queue: every publish runs after all the ones in flight.
 *
 * Concurrent publishes are not hypothetical — a mount seed can still be
 * mid-flight when the first panel poll publishes the catalog it just fetched,
 * and a switch flip or a forget can land on top of either. Two publishes
 * interleaving means the SLOWER one wins: it releases the pair the faster one
 * registered and then registers its own, so the Host serves a stale (possibly
 * empty) set while the snapshot reports the fresh one (PITFALLS §18).
 *
 * The chain is the same shape `token-store.ts` uses for `getToken`: no lock
 * object, and a rejected link never poisons the ones behind it.
 * @returns {PublishQueue} the queue and the disposal gate.
 */
export function createPublishQueue(): PublishQueue {
  let publishChain: Promise<unknown> = Promise.resolve();
  let disposed = false;
  return {
    enqueue(task) {
      const queued = publishChain.then(task, task);
      publishChain = queued.then(() => undefined, () => undefined);
      return queued;
    },
    isDisposed: () => disposed,
    dispose() {
      disposed = true;
    }
  };
}

/**
 * Build the releaser for one publisher's `state`.
 *
 * Releases are idempotent in the Host, and a release that throws must not
 * abort the one behind it — during shutdown or a rollback the service may
 * already be gone.
 * @param {PublisherState} state - the publisher state holding the release functions.
 * @returns {() => void} release, safe to call any number of times.
 */
export function createPairReleaser(state: PublisherState): () => void {
  return () => {
    const releaseFn = (fn: (() => void) | null) => {
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
}

/**
 * Hand one built adapter to the `llm` service and record its release
 * functions onto `target`.
 *
 * Defined ONCE because the publish path and the rollback path both register a
 * pair, and two copies drift: a change to the directory row made in one place
 * and not the other leaves the ROLLBACK registering a provider the publish
 * path would never have built — and a rollback only runs once something has
 * already gone wrong, which is the worst possible moment to find out
 * (PITFALLS §19).
 *
 * The releases are written straight onto `target` rather than returned: if the
 * directory call throws AFTER the adapter was registered, the adapter's
 * release must still be reachable, or `release()` cannot undo it and the
 * adapter outlives the plugin.
 * @param {object} llm - the registration service (peer-typed: loose).
 * @param {BuiltAdapter} built - what to register.
 * @param {PublisherState} target - where the release functions are recorded.
 * @param {ProviderIdentity} identity - the provider's row on the models settings page.
 * @returns {void}
 */
export function registerProviderPair(
  llm: any,
  built: BuiltAdapter,
  target: PublisherState,
  { providerId, displayName }: ProviderIdentity
): void {
  target.releaseAdapter = llm.registerAdapter(built.providerIds, built.adapter);
  // `registerConfigurableProviders` is how a provider gains its row on the
  // models settings page; an older runtime without it still gets models
  // through the adapter registration above.
  target.releaseDirectory = typeof llm.registerConfigurableProviders === "function"
    ? llm.registerConfigurableProviders([{
        provider: providerId,
        displayName,
        // This plugin's OWN row namespace; declared:false because the row
        // exists as a patch already, not as a provider-declared schema.
        settingsNs: pluginName,
        settingsPath: [],
        declared: false
      }])
    : null;
}

/**
 * Memoize the peer-dependent adapter factory for one publisher.
 *
 * The module is loaded once and the factory is read off it once, so a Host
 * whose peers resolve slowly pays that cost one time, not per publish.
 * @param {() => Promise<unknown>} loadModule - resolves the adapter module.
 * @param {string} exportName - the factory export to read off the module.
 * @returns {() => Promise<any>} the memoized factory resolver.
 */
export function createAdapterFactoryResolver(
  loadModule: () => Promise<unknown>,
  exportName: string
): () => Promise<any> {
  let adapterFactoryPromise: Promise<any> | undefined;
  return async () => {
    if (adapterFactoryPromise === undefined) {
      adapterFactoryPromise = Promise.resolve(loadModule())
        .then((mod) => (mod as Record<string, unknown> | undefined)?.[exportName]);
    }
    return adapterFactoryPromise;
  };
}

/**
 * Verify a built adapter is really one before it is registered Host-wide.
 *
 * An adapter is registered Host-wide, so a factory that returns anything else
 * must fail here rather than publish a provider that cannot serve a request.
 * @param {unknown} built - what the factory returned.
 * @returns {boolean} whether it is `{ adapter, providerIds }`.
 */
export function isBuiltAdapter(built: unknown): built is BuiltAdapter {
  return built !== null && typeof built === "object"
    && Array.isArray((built as BuiltAdapter).providerIds)
    && (built as BuiltAdapter).adapter !== undefined;
}

/**
 * Turn a build failure into a secret-free note plus a hint.
 *
 * A credential never reaches the panel or a log. The failure a reader cannot
 * diagnose from the message alone: the llm peer packages ship INSIDE the Host,
 * so a plugin directory the Host's `node_modules` cannot be reached from — a
 * dev checkout symlinked into the profile, say — has no way to import them.
 * Say so, with the remedy, because the panel can only report "provider absent".
 * @param {unknown} error - the thrown value (may not be an Error at all).
 * @returns {DescribedBuildFailure} the redacted message, the optional remedy
 *   suffix, and the original value for re-raising.
 */
export function describeBuildFailure(error: unknown): DescribedBuildFailure {
  const why = error instanceof Error ? error.message : String(error);
  return {
    note: redactSecrets(why),
    hint: (error as { code?: unknown } | null | undefined)?.code === "ERR_MODULE_NOT_FOUND"
      ? " — the llm peer packages ship with the Host; install this plugin where they resolve" +
        " (or link them into its own node_modules)"
      : "",
    error
  };
}

/**
 * Log one build failure the way both publishers log it.
 * @param {PublisherLogger} [logger] - `ctx.logger`.
 * @param {string} label - the upstream's name for the message ("Agnes").
 * @param {DescribedBuildFailure} described - from `describeBuildFailure`.
 * @returns {void}
 */
export function warnBuildFailure(
  logger: PublisherLogger | null | undefined,
  label: string,
  described: DescribedBuildFailure
): void {
  // The note/hint already went through `describeBuildFailure`, which reads the
  // thrown message — and this is a LOG EXIT, so it is redacted here too rather
  // than trusting the describer to have covered every credential shape an
  // adapter factory can embed (its error may carry the baseUrl or the key it
  // was built with).
  logger?.warn?.(`${pluginName}: cannot build the ${label} adapter: ${redactSecrets(`${described.note}${described.hint}`)}`);
}

/**
 * Resolve the `llm` registration service, or bail out with the pair released.
 *
 * Both upstreams answer the same question the same way, and the answer is a
 * fact about the Host — not about the provider — so it is one copy: a Host
 * with no `llm` service gets no registration and a stated reason, never a
 * half-built one.
 *
 * The teardown goes through `unregister` rather than a bare `release()`, which
 * (also) clears `state.built`. That matters more here than anywhere else: the
 * Host losing its `llm` service is exactly the moment the previous pair's
 * release has been called, so leaving a stale `built` behind hands the NEXT
 * publish a rollback target that is already dead.
 * @param {object} job
 * @param {PublisherState} job.state - the publisher state.
 * @param {(service: string) => any} job.getLlm - the service resolver.
 * @param {() => void} job.release - the publisher's releaser.
 * @returns {any} the service, or null when it cannot register.
 */
export function resolveRegistrationService({ state, getLlm, release }: {
  state: PublisherState;
  getLlm: (service: string) => any;
  release: () => void;
}): any {
  const llm = getLlm("llm");
  state.llmAvailable = llm !== null && typeof llm.registerAdapter === "function";
  if (!state.llmAvailable) {
    unregister({ state, release, error: NO_LLM_SERVICE_ERROR });
    return null;
  }
  return llm;
}

/**
 * Take the registration down and record why it is gone.
 *
 * `state.built` is cleared along with it, and that matters: a stale `built`
 * survives into the NEXT publish as its rollback target, so a later failed
 * publish would re-register an adapter whose release has already been called.
 * That is why every "there must be no registration" branch routes through
 * here — switch off, credential gone, and (through
 * `resolveRegistrationService`) no `llm` service at all.
 * @param {object} job
 * @param {PublisherState} job.state - the publisher state.
 * @param {() => void} job.release - the publisher's releaser.
 * @param {string|null} [job.error] - why nothing is registered; null when the
 *   absence is the wanted state (switch off).
 * @returns {{ok: boolean, skipped: boolean}} the publish outcome.
 */
export function unregister({ state, release, error = null }: {
  state: PublisherState;
  release: () => void;
  error?: string | null;
}): { ok: boolean; skipped: boolean } {
  release();
  state.registered = false;
  state.built = null;
  state.error = error;
  return { ok: true, skipped: true };
}

/** What `swapRegistration` needs to take down, re-register, and roll back. */
export interface SwapRegistrationJob {
  /** The registration service (peer-typed: loose). */
  llm: any;
  /** The pair to register now. */
  built: BuiltAdapter;
  /** The pair that was serving, or null. */
  previousBuilt: BuiltAdapter | null;
  /** The publisher state to record onto. */
  state: PublisherState;
  /** The publisher's releaser. */
  release: () => void;
  /** The single-point registrar (from `registerProviderPair`). */
  registerPair: (llm: any, built: BuiltAdapter, target: PublisherState) => void;
  /** `ctx.emit`. */
  emit: (event: string) => void;
  /** Restore the domain snapshot fields (`entries`/`enabledIds`, or the roster
   *  and base) to what is really serving. */
  onRollback?: () => void;
}

/**
 * Swap the registered pair: take down the old one, register the new one, and
 * restore the OLD one if the new registration throws.
 *
 * This is the other half of PITFALLS §19, and the reason it is shared: the
 * rollback is the path that only runs once something has already gone wrong.
 * A registration that fails AFTER the old pair was released must put the
 * previous one back, or a bad publish takes down models that were already
 * serving. Written twice, the two copies drift; written once, a fix to the
 * rollback reaches both upstreams.
 * @param {SwapRegistrationJob} job - see the interface.
 * @returns {{ok: boolean, error?: unknown}} the publish outcome.
 */
export function swapRegistration({
  llm,
  built,
  previousBuilt,
  state,
  release,
  registerPair,
  emit,
  onRollback
}: SwapRegistrationJob): { ok: boolean; error?: unknown } {
  // Build first (it can throw); only then take down the old pair.
  release();
  try {
    registerPair(llm, built, state);
  } catch (error) {
    release();
    state.built = null;
    // The snapshot's `offered` set must describe what is really serving, so a
    // failed re-registration restores the previous pair's identity too.
    onRollback?.();
    state.error = redactSecrets(error instanceof Error ? error.message : String(error));
    // Restore the pair that was serving, if any.
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
  emitAdaptersUpdated(emit);
  return { ok: true };
}

/**
 * Emit the adapter-update event, tolerating a Host that refuses it.
 *
 * A Host that refuses the event still has the registration; readers refresh on
 * their own cadence.
 * @param {(event: string) => void} emit - `ctx.emit`.
 * @returns {void}
 */
export function emitAdaptersUpdated(emit: (event: string) => void): void {
  try {
    emit(ADAPTERS_UPDATED_EVENT);
  } catch {
    // Deliberately swallowed; see the note above.
  }
}
