// @ts-check
/**
 * dsh-connect-sensenova-token-plan — Host half (thin router).
 *
 * Reads the SenseNova Token Plan quota through the platform's own console API
 * (the same endpoints the web console calls) and serves the result to the
 * Client panel over one read-only `/api` route.
 *
 * The heavy lifting lives in focused sibling modules so this file stays a
 * readable orchestrator:
 *
 *   - `host-config.js`    config contract + the `isAdmitted` trust fence
 *   - `routes.js`         the six HTTP route handlers (peer-free, wiring-injected)
 *   - `lifecycle.js`      mount seed / draw tool / vision step two / teardown
 *   - `console-client.js` console/catalog fetch with cache + single-flight
 *   - `parsers.js`        response normalization + shape-drift detection
 *   - `snapshot-aggregate.js` the snapshot body's data aggregation
 *   - `provider-publish.js`  the provider registration state machine
 *   - `state-store.js`    atomic state-file primitives for the three stores
 *   - `trace.js`          login-trace persistence (already sanitized upstream)
 *   - `util.js`           the small `str`/`num`/`obj` readers
 *
 * This file keeps the Cordis entry (`name`/`inject`/`apply`), the wiring
 * assembly, and the unmount effect — the parts that are about *this* plugin's
 * surface rather than reusable logic.
 *
 * @module dsh-connect-sensenova-token-plan
 */

import { createAuth } from "./sensenova-auth.js";
import { createTokenStore } from "./token-store.js";
import { createFileThrottleStore } from "./throttle-store.js";
import { createFileCatalogStore } from "./catalog-store.js";
import { createFileProviderStore } from "./provider-store.js";
import { createFileDrawStore } from "./draw-store.js";
import { createApiKeyStore } from "./api-key-store.js";
import { createProviderPublisher } from "./provider-publish.js";
import { registerRoutes } from "./routes.js";
import { startSideEffects, teardown } from "./lifecycle.js";
import { CODE } from "./codes.js";
import { writeLoginTrace } from "./trace.js";
import {
  resolveSettings,
  resolveAuthOverrides,
  CONFIG_DEFAULTS,
  isAdmitted,
  hostName,
  inject,
  name
} from "./host-config.js";
import { str } from "./util.js";

/**
 * The record address format, matching `@deepseek-ai/dsh-credentials`.
 *
 * The service exports `credentialKey` for this, but a plugin that imports it
 * statically cannot be exercised without that peer package present — which is
 * what kept the test suite from running on a clean checkout. The Host's
 * credentials service treats the plain `"scope/id"` string identically. Exported
 * so `test/config.test.mjs` can pin its LITERAL shape on every machine (a clean
 * checkout included), and `test/store.test.mjs` can assert it EQUALS the real
 * peer function where that peer resolves — together they close the gap the old
 * comment claimed was already closed but never actually tested.
 * @param {string} scope - the plugin's namespace.
 * @param {string} id - the record's name.
 * @returns {string} the record key.
 */
export const credentialKey = (scope, id) => `${scope}/${id}`;

/**
 * A cheap signature of the model set a provider registration would offer.
 *
 * Re-exported here so the snapshot route's quota branch keeps using the same
 * function the publisher uses — two copies of the signature would drift and
 * the poll would either churn the registration or skip a needed rebuild.
 */
export { catalogSignature } from "./provider-publish.js";

/**
 * Host body: assemble the wiring, register the six routes, run the mount
 * side effects, and hang the unmount effect. The route handlers live in
 * `routes.js`, the side effects in `lifecycle.js` — this function only
 * decides what they may touch.
 * @param ctx - host root context.
 * @param config - the row's raw patch config. There is no DSH Config schema, so
 *   values arrive unvalidated; the endpoint overrides are checked where they
 *   are consumed (`createAuth` throws on a malformed origin) and the failure
 *   is surfaced through the snapshot instead of crashing the route.
 * @param deps - test-only seams (the peer adapter / tools modules, a draw
 *   fetch replacement). The real Loader passes nothing.
 */
function apply(ctx, config = {}, deps = {}) {
  // A malformed row is reported through the snapshot rather than thrown out of
  // `apply`, which would take the whole plugin down at mount.
  const { settings, configError: rowError } = resolveSettings(config);
  let configError = rowError;
  // Build the auth instance once, at mount: after this every console call,
  // token renewal, and password seal uses the configured hosts. A malformed
  // override must fail loudly here rather than become a baffling network error
  // on the first poll.
  let auth = null;
  if (configError === null) {
    try {
      auth = createAuth(settings.auth);
    } catch (error) {
      configError = error instanceof Error ? error.message : String(error);
    }
  }
  // The inference API key (`sk-…`) is shared by the catalog poll and the
  // directly-registered LLM provider. It is held as the `SENSENOVA_API_KEY`
  // CREDENTIAL REFERENCE (owner-only credentials service), with the raw
  // process environment as a fallback — the value may live in
  // `~/.dsh/.credentials.yaml` alone, which a sibling shell never sees, so
  // reading `process.env` first is what left this panel blind on machines
  // where the key is stored there. The panel save/forget route below writes
  // the reference through the same store. Treated as optional: absent → the
  // model lists and provider degrade, the quota panel still works.
  const apiKeyStore = createApiKeyStore({
    credentials: () => ctx.get("credentials") ?? null
  });
  const resolveApiKey = async () => (await apiKeyStore.resolve()).value;
  /** @type {Map<string, import("./console-client.js").CacheEntry>} */
  const cache = new Map();
  /** One in-flight console fetch per URL, so concurrent polls share a call. */
  const inflight = new Map();

  // Step three's PRIVATE catalog file: the last `/v1/models` answer the key
  // fetched, plus the curated enabled-model allow-list. It lives under
  // `$DSH_HOME/state/<plugin>/catalog.json`, never in the settings row or the
  // patch layer — a catalog is operational state, not an operator decision.
  const catalogStore = createFileCatalogStore();
  // The panel's live provider switch (docs/PROVIDER-HOT-RELOAD.md). A value
  // saved from the panel overrides the patch's `registerProvider`; an untouched
  // state file falls back to it, so configuration-driven deployments keep
  // working unchanged.
  const providerStore = createFileProviderStore();
  // The panel's live draw-tool switch (docs/PROVIDER-HOT-RELOAD.md, same
  // "own state file beats the config default" discipline as the provider
  // switch). A value saved from the panel overrides the patch's
  // `drawEnabled`; an untouched state file falls back to it.
  const drawStore = createFileDrawStore();

  /** Read an optional service without throwing on a Host that lacks it. */
  const getService = (service) => {
    try {
      return ctx.get?.(service) ?? null;
    } catch {
      return null;
    }
  };

  // The directly-registered provider's live registration state now lives in
  // the peer-free `provider-publish.js` module: the `publishChain` that
  // serialises publishes, the `disposed` gate, the single-point `registerPair`
  // and the rollback path (PITFALLS §18 / §19). `index.js` drives it from the
  // mount seed, the catalog poll, the provider switch, the roster save and the
  // api-key forget, and reads its `state` for the snapshot's `llm` block.
  // `llm` is an OPTIONAL service (this plugin injects only `webServer`), read
  // through `ctx.get` like the other optional services: on a Host without an
  // LLM runtime the panel still works and `llm.providerRegistered` simply
  // stays false. Everything registration-related is wrapped so a peer that
  // fails to load degrades to "models absent", never "panel down".
  const loadAdapterModule = deps.loadAdapterModule ?? (() => import("./llm-adapter.js"));
  const publisher = createProviderPublisher({
    settings,
    panelSwitch: () => providerStore.enabled().catch(() => null),
    loadAdapterModule,
    getLlm: (service) => getService(service),
    resolveApiKey,
    emit: (event) => {
      try {
        ctx.emit?.(event);
      } catch {
        // A Host that refuses the event still has the registration; readers
        // refresh on their own cadence.
      }
    },
    logger: ctx.logger
  });
  const providerState = publisher.state;
  const publishProvider = (entries, enabledIds, unavailableModelIds = []) =>
    publisher.publish(entries, enabledIds, unavailableModelIds);
  const releaseProvider = () => publisher.release();

  // The credentials service is how the console token and account are held and
  // renewed. It is optional: a Host without one still gets a working panel,
  // with the account kept in memory for that process's lifetime rather than on
  // disk. Refusing to build a store at all would leave such a Host with no way
  // to sign in.
  const tokenStore = createTokenStore({
    // The configured auth instance; a malformed config already set configError
    // above, but the account route may still be reached, so fall back to a
    // defaults-built instance rather than a `null` that would disable login.
    auth: auth ?? createAuth(),
    // A resolver, not a snapshot: the credentials service may register after
    // this plugin mounts, and a one-time lookup would freeze a wrong
    // "ephemeral" claim into every later poll.
    credentials: () => ctx.get("credentials") ?? null,
    credentialKey,
    skewMs: settings.tokenSkewSeconds * 1000,
    // Explicit, because the store defaults to an in-memory throttle: a wait
    // that only this process knows about is no protection against a second
    // Host process walking into the lock this one is waiting out. This is the
    // one place that default is wrong.
    throttleStore: createFileThrottleStore(),
    // Every sign-in attempt (success or failure) leaves one sanitized trace
    // file behind: a "browser works but the panel does not" report is only
    // debuggable by diffing a working attempt against a failing one. The
    // failure half is named by its code; a success has none, so it says so.
    onTrace: (hops, error) => {
      void writeLoginTrace(hops, error === null ? "ok" : str(error?.code, CODE.AUTH_ERROR));
    }
  });
  // Vision step two (ARCHITECTURE.md §5.1): the settings-row writer the
  // snapshot route calls after it has computed the vision list. Filled in
  // by `startSideEffects`; until then it is a no-op, so a Host without a
  // settings service still answers polls.
  const visionPublish = { current: null };

  const wiring = {
    settings,
    configError,
    cache,
    inflight,
    tokenStore,
    apiKeyStore,
    catalogStore,
    providerStore,
    drawStore,
    publisher,
    providerState,
    publishProvider,
    releaseProvider,
    resolveApiKey,
    visionPublish,
    logger: ctx.logger
  };

  // The six route handlers (trust fence, method allowances, body ceilings,
  // trace writes, publish-after-save) — see routes.js.
  const offs = registerRoutes(ctx, wiring);
  // Mount-time side effects (persisted-catalog seed, draw tool, vision
  // step two) — see lifecycle.js. Fire-and-forget inside; never awaited.
  startSideEffects(ctx, wiring, {
    loadToolsModule: deps.loadToolsModule ?? (() => import("@deepseek-ai/dsh-tools")),
    drawFetch: deps.drawFetch ?? ((url, options) => fetch(url, options))
  });

  ctx.effect(() => {
    // The effect callback returns the unmount cleanup: Cordis runs it when
    // this fiber disposes, NOT at registration — a teardown that ran early
    // would unregister every route the moment they were created.
    return () => {
      teardown(wiring, offs);
    };
  }, `${name}: routes`);
}

export { apply, inject, name, resolveSettings, resolveAuthOverrides, CONFIG_DEFAULTS, hostName, isAdmitted };