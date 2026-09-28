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
 *   - `host-config.js`   config contract + the `isAdmitted` trust fence
 *   - `console-client.js` console/catalog fetch with cache + single-flight
 *   - `parsers.js`        response normalization + shape-drift detection
 *   - `trace.js`          login-trace persistence (already sanitized upstream)
 *   - `util.js`           the small `str`/`num`/`obj` readers
 *
 * This file keeps the Cordis entry (`name`/`inject`/`apply`), the two route
 * handlers, and the HTTP helpers — the parts that are about *this* plugin's
 * surface rather than reusable logic.
 *
 * @module dsh-connect-sensenova-token-plan
 */

import { createAuth } from "./sensenova-auth.js";
import { createTokenStore } from "./token-store.js";
import { createFileThrottleStore } from "./throttle-store.js";
import { createFileCatalogStore } from "./catalog-store.js";
import { createFileProviderStore } from "./provider-store.js";
import { createApiKeyStore } from "./api-key-store.js";
import { summarizeCatalog, LLM_PROVIDER_ID, LLM_DISPLAY_NAME } from "./llm-models.js";
import { CODE, isAuthFailure } from "./codes.js";
import {
  resolveSettings,
  resolveAuthOverrides,
  CONFIG_DEFAULTS,
  isAdmitted,
  hostName,
  inject,
  name
} from "./host-config.js";
import { fetchConsole, fetchModelCatalog } from "./console-client.js";
import { parsePools, parseTrend, checkShape, identifyVisionModel } from "./parsers.js";
import { writeLoginTrace } from "./trace.js";
import { str, redactSecrets } from "./util.js";

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

/** The one read-only route the Client panel polls. */
const SNAPSHOT_PATH = `/api/${name}/snapshot`;
/**
 * The account route, so the panel can configure itself without the user
 * editing `.env` by hand.
 *
 * This is the plugin's only state-changing route, and it is reachable only
 * from a page the Host itself served: the same-origin fence below rejects any
 * request announcing a foreign `Origin`, which is what stops a random website
 * from planting a SenseNova account into the user's panel.
 */
const ACCOUNT_PATH = `/api/${name}/account`;
/**
 * The inference API-key route (`sk-…`), step three of the one-stop plan.
 *
 * The key authenticates BOTH the `/v1/models` catalog poll and the directly
 * registered LLM provider. It is held as the `SENSENOVA_API_KEY` credential
 * reference (never written to this plugin's directory, never echoed back),
 * with the raw process environment kept as a fallback. Same trust fence and
 * body ceiling as the account route.
 */
const API_KEY_PATH = `/api/${name}/api-key`;
/**
 * The provider-registration switch route: the panel's live on/off for the
 * directly-registered LLM provider. State lives in the plugin's own state
 * file (`provider-store.js`), so flipping it takes effect on the request
 * that carries it — no config edit, no Host restart. Same trust fence and
 * body ceiling as the account/api-key routes. See docs/PROVIDER-HOT-RELOAD.md.
 */
const PROVIDER_PATH = `/api/${name}/provider`;
/** Ceiling on a submitted account, so a hostile page cannot stream a body. */
const MAX_ACCOUNT_BODY_BYTES = 4096;
/** Family default response headers for a JSON route. */
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer"
};

/** Write one JSON response with the family headers. */
function writeJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, ...headers });
  res.end(payload);
}

/**
 * Read a small JSON request body, refusing anything oversized.
 *
 * The account form is the only thing that posts here, so the ceiling is tiny
 * and the reader is deliberately dull: no content-type negotiation, no
 * streaming, just a bounded collect and a parse.
 * @param request - the incoming HTTP request.
 * @param limit - the byte ceiling.
 * @returns {Promise<{ok: true, value: object} | {ok: false, error: string}>}
 */
async function readJsonBody(request, limit = MAX_ACCOUNT_BODY_BYTES) {
  const chunks = [];
  let received = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.byteLength;
      if (received > limit) return { ok: false, error: "request body is too large" };
      chunks.push(buffer);
    }
  } catch {
    return { ok: false, error: "could not read the request body" };
  }
  if (chunks.length === 0) return { ok: false, error: "a JSON body is required" };
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "the body must be a JSON object" };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, error: "the body is not valid JSON" };
  }
}

/**
 * Map a thrown console/auth error to the one code the panel branches on.
 *
 * A raw error message carries no intent, so the panel keys its guidance off
 * this taxonomy instead: `not_configured` (the user can fix it) and
 * `jwt_expired` (renewal already failed) pass through verbatim because the
 * panel words them differently from every other case; an auth-shaped failure
 * becomes `auth_error`; anything else is a console failure, which usually
 * self-heals on the next poll.
 * @param {unknown} error - the error a fetch or parse threw.
 * @returns {string} the panel-facing code.
 */
function failureCode(error) {
  if (error?.code === CODE.NOT_CONFIGURED || error?.code === CODE.JWT_EXPIRED) return error.code;
  return isAuthFailure(error) ? CODE.AUTH_ERROR : CODE.CONSOLE_ERROR;
}

/**
 * A cheap signature of the model set a provider registration would offer.
 *
 * It only has to answer "would rebuilding change anything?": the model ids in
 * catalog order, each tagged with the SAME vision decision the descriptors
 * use (an id whose modality flipped must rebuild even though the id list did
 * not change), plus the curated allow-list. Anything else changing in a
 * catalog entry does not affect the registered offer.
 * @param {object[]} entries - the normalized catalog entries.
 * @param {string[]} enabledIds - the allow-list (empty = all).
 * @returns {string}
 */
function catalogSignature(entries, enabledIds) {
  const models = (Array.isArray(entries) ? entries : [])
    .map((entry) => `${str(entry?.id, "")}:${identifyVisionModel(entry).vision === true ? 1 : 0}`)
    .join(",");
  return `${models}|${(Array.isArray(enabledIds) ? enabledIds : []).join(",")}`;
}

/**
 * Host body: mount the snapshot route. The panel polls it; each poll reads
 * the console through a short-lived cache and a self-renewing token.
 * @param ctx - host root context.
 * @param config - the row's raw patch config. There is no DSH Config schema, so
 *   values arrive unvalidated; the endpoint overrides are checked where they
 *   are consumed (`createAuth` throws on a malformed origin) and the failure
 *   is surfaced through the snapshot instead of crashing the route.
 */
function apply(ctx, config = {}, deps = {}) {
  // The peer-dependent adapter is loaded LAZILY and only when the opt-in is
  // actually on: `llm-adapter.js` imports Host-shipped peers (`pi-ai`,
  // `dsh-llm-pi-ai`) which are not resolvable from a bare plugin checkout, so
  // a static import would take down every offline suite that mounts this file.
  // The real Host loader resolves the sibling fine at runtime; the optional
  // `deps.loadAdapterModule` seam lets the wiring suite inject a fake factory
  // (the real peer assembly is covered end-to-end by test/e2e.mjs).
  const loadAdapterModule = deps.loadAdapterModule ?? (() => import("./llm-adapter.js"));
  let adapterFactoryPromise;
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
  // It lets the registered provider offer models before the first poll of a
  // restart, and survives with no console login at all.
  const catalogStore = createFileCatalogStore();
  // The panel's live provider switch (docs/PROVIDER-HOT-RELOAD.md). A value
  // saved from the panel overrides the patch's `registerProvider`; an untouched
  // state file falls back to it, so configuration-driven deployments keep
  // working unchanged.
  const providerStore = createFileProviderStore();

  // The directly-registered provider's live registration state.
  // `llm` is an OPTIONAL service (this plugin injects only `webServer`), read
  // through `ctx.get` like the other optional services: on a Host without an
  // LLM runtime the panel still works and `llm.providerRegistered` simply
  // stays false. Everything registration-related is wrapped so a peer that
  // fails to load degrades to "models absent", never "panel down".
  const providerState = {
    /** The catalog entries the current registration was built from. */
    entries: [],
    /** The curated allow-list at registration time (empty = all models). */
    enabledIds: [],
    /** A cheap signature that only changes when the offered set changes. */
    signature: "",
    /** Whether an `llm` service answering `registerAdapter` is present. */
    llmAvailable: false,
    /** Whether our provider pair is currently registered without error. */
    registered: false,
    /** The last registration error, surfaced secret-free in the snapshot. */
    error: null,
    releaseAdapter: null,
    releaseDirectory: null,
    /** The built adapter the active release functions belong to. */
    built: null
  };

  /**
   * Set once the plugin is disposed.
   *
   * The mount seed publishes fire-and-forget, so nothing was stopping a publish
   * that was still queued from registering a provider AFTER the plugin was
   * unmounted — a provider no one owns and no one can release, left behind by
   * a plugin the Host already forgot. Every publish checks this first.
   */
  let disposed = false;

  /** Read an optional service without throwing on a Host that lacks it. */
  const getService = (service) => {
    try {
      return ctx.get?.(service) ?? null;
    } catch {
      return null;
    }
  };

  /** Release the registered pair. Releases are idempotent in the Host. */
  const releaseProvider = () => {
    const release = (fn) => {
      try {
        fn?.();
      } catch {
        // The service may already be gone during shutdown or rollback.
      }
    };
    release(providerState.releaseAdapter);
    release(providerState.releaseDirectory);
    providerState.releaseAdapter = null;
    providerState.releaseDirectory = null;
  };

  /** Resolve (and memoize) the peer-dependent adapter factory. */
  const resolveAdapterFactory = async () => {
    if (adapterFactoryPromise === undefined) {
      adapterFactoryPromise = Promise.resolve(loadAdapterModule()).then((mod) => mod.createSensenovaAdapter);
    }
    return adapterFactoryPromise;
  };

  /**
   * Hand one built adapter to the llm service and record its release functions.
   *
   * Defined once because the publish path and the rollback path both register a
   * pair, and two copies will drift: a change to the directory row (a new
   * field, a different `settingsNs`) made in one place and not the other leaves
   * the ROLLBACK registering a provider the publish path would never have
   * built — and a rollback only runs once something has already gone wrong,
   * which is the worst possible moment to discover it.
   *
   * The releases are written straight onto `target` rather than returned: if
   * the directory call throws after the adapter was registered, the adapter's
   * release must still be reachable, or `releaseProvider()` cannot undo it and
   * the adapter outlives the plugin.
   * @param {object} llm - the registration service.
   * @param {{providerIds: string[], adapter: unknown}} built - what to register.
   * @param {object} target - where the release functions are recorded.
   * @returns {void}
   */
  const registerPair = (llm, built, target) => {
    target.releaseAdapter = llm.registerAdapter(built.providerIds, built.adapter);
    // `registerConfigurableProviders` is how a provider gains its row on the
    // models settings page; an older runtime without it still gets models
    // through the adapter registration above.
    target.releaseDirectory = typeof llm.registerConfigurableProviders === "function"
      ? llm.registerConfigurableProviders([{
          provider: LLM_PROVIDER_ID,
          displayName: LLM_DISPLAY_NAME,
          // This plugin's OWN row namespace; declared:false because the row
          // exists as a patch already, not as a provider-declared schema.
          settingsNs: name,
          settingsPath: [],
          declared: false
        }])
      : null;
  };

  /**
   * Publishes are serialized through this chain.
   *
   * Concurrent publishes are not hypothetical: the mount seed below runs
   * fire-and-forget and can still be mid-flight when the first panel poll
   * publishes the catalog it just fetched, and an api-key forget or a provider
   * switch can land on top of either. Two publishes interleaving means the
   * SLOWER one wins — it releases the pair the faster one just registered and
   * then registers its own — so the Host ends up serving a stale (possibly
   * empty) catalog while the snapshot reports the fresh one, and the panel's
   * model counts describe something that is not what is registered.
   *
   * The chain is the same shape `token-store.js` uses for `getToken`: no lock
   * object, and a rejected link never poisons the ones behind it.
   */
  let publishChain = Promise.resolve();

  /**
   * (Re)build and register the provider for one catalog/allow-list snapshot.
   *
   * Rebuild-and-reregister rather than mutate: `PiAiAdapter` memoizes its
   * profiles snapshot internally, so only a fresh registration can change the
   * offered model list. On a failed registration the PREVIOUS pair is restored,
   * so a bad publish can never take down models that were already serving.
   * @param {object[]} entries - the normalized catalog entries.
   * @param {string[]} enabledIds - the curated allow-list (empty = all).
   * @returns {Promise<{ok: boolean, skipped?: boolean, error?: unknown}>}
   */
  const publishProviderOnce = async (entries, enabledIds) => {
    // A publish that arrives after the plugin was disposed registers a
    // provider into a Host that has already withdrawn this plugin: no owner,
    // no release, and nothing on screen saying where it came from.
    if (disposed) return { ok: false, skipped: true };
    const previousBuilt = providerState.built;
    const previousEntries = providerState.entries;
    const previousEnabledIds = providerState.enabledIds;
    providerState.entries = Array.isArray(entries) ? entries : [];
    providerState.enabledIds = Array.isArray(enabledIds) ? enabledIds : [];
    // Opt-in: with the switch off there must be no registration left behind
    // from a row that flipped it after mounting. The EFFECTIVE switch is
    // panel-first (`provider-store.js`), falling back to the patch value —
    // re-read here on every publish, so a flip applies without a restart.
    const panelSwitch = await providerStore.enabled().catch(() => null);
    const registerWanted = panelSwitch ?? settings.registerProvider === true;
    if (!registerWanted) {
      releaseProvider();
      providerState.registered = false;
      providerState.built = null;
      providerState.error = null;
      return { ok: true, skipped: true };
    }
    const llm = getService("llm");
    providerState.llmAvailable = llm !== null && typeof llm.registerAdapter === "function";
    if (!providerState.llmAvailable) {
      releaseProvider();
      providerState.registered = false;
      providerState.error = "the Host exposes no llm registration service";
      return { ok: false, error: providerState.error };
    }
    let createSensenovaAdapter;
    let built;
    try {
      createSensenovaAdapter = await resolveAdapterFactory();
      // Awaited, not assumed synchronous: a factory that ever becomes async
      // would otherwise hand a Promise to `registerAdapter`, and the Host
      // would be offered a provider whose adapter is `undefined` — a failure
      // that surfaces as broken model routing, nowhere near its cause.
      built = await createSensenovaAdapter({
        entries: providerState.entries,
        enabledIds: providerState.enabledIds,
        baseUrl: settings.apiBase,
        resolveApiKey,
        get: getService
      });
      // The same reason, stated: an adapter is registered Host-wide, so a
      // factory that returns anything else must fail here rather than publish
      // a provider that cannot serve a request.
      if (built === null || typeof built !== "object"
        || !Array.isArray(built.providerIds) || built.adapter === undefined) {
        throw new Error("the adapter factory did not return { adapter, providerIds }");
      }
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      // A credential never reaches the panel or a log. The failure a reader
      // cannot diagnose from the message alone: the LLM
      // peer packages ship INSIDE the Host, so a plugin directory the Host's
      // node_modules cannot be reached from — a dev checkout symlinked into
      // the profile, say — has no way to import them. Say so, with the remedy,
      // because the panel can only report "provider absent".
      const note = redactSecrets(why);
      providerState.error = note;
      ctx.logger?.warn?.(
        `${name}: cannot build the SenseNova adapter: ${note}` +
          (error?.code === "ERR_MODULE_NOT_FOUND"
            ? " — the llm peer packages ship with the Host; install this plugin where they resolve" +
              " (or link them into its own node_modules)"
            : "")
      );
      return { ok: false, error };
    }
    // Build first (it can throw); only then take down the old pair.
    releaseProvider();
    try {
      registerPair(llm, built, providerState);
    } catch (error) {
      releaseProvider();
      providerState.built = null;
      // The snapshot's `offered` set must describe what is really serving, so
      // a failed re-registration restores the previous pair's identity too.
      providerState.entries = previousEntries;
      providerState.enabledIds = previousEnabledIds;
      // Restore the pair that was serving, if any.
      if (previousBuilt !== null) {
        try {
          registerPair(llm, previousBuilt, providerState);
          providerState.built = previousBuilt;
          providerState.registered = true;
        } catch {
          providerState.built = null;
          providerState.registered = false;
        }
      } else {
        providerState.registered = false;
      }
      providerState.error = redactSecrets(error instanceof Error ? error.message : String(error));
      return { ok: false, error };
    }
    providerState.built = built;
    providerState.registered = true;
    providerState.error = null;
    try {
      ctx.emit?.("llm/adapters-updated");
    } catch {
      // A Host that refuses the event still has the registration; readers
      // refresh on their own cadence.
    }
    return { ok: true };
  };

  /**
   * Publish, queued behind every other publish in flight.
   *
   * The wrapper exists so no caller has to remember the queue: the mount seed,
   * a catalog poll, an api-key forget and a provider switch all reach the same
   * critical section, and any one of them racing another is the bug above.
   * @param {object[]} entries - the normalized catalog entries.
   * @param {string[]} enabledIds - the curated allow-list (empty = all).
   * @returns {Promise<{ok: boolean, skipped?: boolean, error?: unknown}>}
   */
  const publishProvider = (entries, enabledIds) => {
    const queued = publishChain.then(
      () => publishProviderOnce(entries, enabledIds),
      () => publishProviderOnce(entries, enabledIds)
    );
    publishChain = queued.then(() => undefined, () => undefined);
    return queued;
  };

  // Seed the registration from the persisted catalog so a restarted Host
  // offers models before its first poll (and with no console login at all).
  // Fire-and-forget: a state dir that cannot be read just waits for the poll.
  void (async () => {
    try {
      const [stored, storedEnabled] = await Promise.all([
        catalogStore.list(),
        catalogStore.listEnabledIds()
      ]);
      providerState.signature = catalogSignature(stored, storedEnabled);
      await publishProvider(stored, storedEnabled);
    } catch {
      // No seed catalog: the first successful poll publishes.
    }
  })();

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
  // by the `ctx.inject(["settings"], ...)` block below; until then it is a
  // no-op, so a Host without a settings service still answers polls.
  const visionPublish = { current: null };

  const offRoute = ctx.webServer.register({
    kind: "exact",
    path: SNAPSHOT_PATH,
    handler: async (request, response) => {
      if (!isAdmitted(request, settings.allowedHosts)) {
        writeJson(response, 403, { ok: false, error: "forbidden: origin mismatch" });
        return;
      }
      if (request.method !== undefined && request.method !== "GET" && request.method !== "HEAD") {
        writeJson(response, 405, { ok: false, error: "method not allowed" });
        return;
      }
      if (configError !== null) {
        // The panel maps this code to its own line, so the operator sees the
        // misconfiguration instead of a generic network failure.
        writeJson(response, 200, {
          ok: false,
          code: CODE.CONFIG_ERROR,
          error: configError,
          auth: await tokenStore.state().catch(() => null)
        }, { "cache-control": "no-store" });
        return;
      }
      try {
        const now = Math.floor(Date.now() / 1000);
        // Snap the window to the granularity boundary so that two polls inside
        // the same hour/day bucket build an identical URL and the long-lived
        // trend cache (5 min) actually hits, instead of re-fetching the console
        // on every poll. The window length is unchanged — only shifted to align
        // with the bucket edges; the console returns bucket-aggregated series
        // anyway, so the panel shows complete buckets rather than a partial one.
        const bucketSeconds = settings.trendHours <= 72 ? 3600 : 86400;
        const endBucket = Math.floor(now / bucketSeconds) * bucketSeconds;
        const start = endBucket - settings.trendHours * 3600;
        const granularity = settings.trendHours <= 72
          ? "TOKEN_PLAN_CREDIT_TREND_GRANULARITY_HOUR"
          : "TOKEN_PLAN_CREDIT_TREND_GRANULARITY_DAY";
        const [poolBody, trendBody, catalog] = await Promise.all([
          fetchConsole(settings, "/lite/console/v1/tokenplan/pool-usage", undefined, settings.cacheSeconds * 1000, cache, inflight, tokenStore),
          fetchConsole(
            settings,
            "/lite/console/v1/tokenplan/credit-usage-trend",
            { start_time: String(start), end_time: String(endBucket), granularity },
            Math.max(settings.cacheSeconds, 300) * 1000,
            cache,
            inflight,
            tokenStore
          ),
          // Optional: a missing API key degrades the model lists, not the
          // quota. Resolved per poll (not at mount) so a key stored in the
          // credentials service that arrives after this plugin mounted still
          // lights the model lists on the next poll.
          (async () => {
            const apiKey = await resolveApiKey();
            return apiKey === "" ? null : fetchModelCatalog(settings, 3600_000, cache, inflight, apiKey).catch(() => null);
          })()
        ]);
        const pools = parsePools(poolBody);
        const trend = parseTrend(trendBody, settings.trendHours);
        // A shape drift does not fail the poll — the parsers still return what
        // they understood — but it must reach the panel, or a renamed field
        // would read as "no usage" forever.
        const shapeWarnings = [
          ...checkShape(poolBody, "pool-usage").missing.map((key) => ({ api: "pool-usage", missing: key })),
          ...checkShape(trendBody, "credit-usage-trend").missing.map((key) => ({ api: "credit-usage-trend", missing: key }))
        ];
        // Split each pool's advertised coverage into what this key can call
        // and what the plan lists but the key has no permission for yet.
        const catalogIds = Array.isArray(catalog) ? catalog.map((entry) => entry.id) : [];
        if (Array.isArray(catalog)) {
          const available = new Set(catalogIds);
          pools.pools = pools.pools.map((pool) => {
            const callable = pool.modelIds.filter((model) => available.has(model));
            const locked = pool.modelIds.filter((model) => !available.has(model));
            return { ...pool, callableModels: callable, lockedModels: locked };
          });
        } else {
          pools.pools = pools.pools.map((pool) => ({
            ...pool,
            callableModels: pool.modelIds,
            lockedModels: []
          }));
        }
        // Which of the callable models can take image input — step one of the
        // vision plan (ARCHITECTURE.md §5.1): the info, not the execution.
        // Absent API key → no catalog → the list is simply undeclared, not "none".
        const visionModels = Array.isArray(catalog)
          ? catalog
              .map((entry) => identifyVisionModel(entry))
              .filter((entry) => entry.vision)
          : undefined;
        // Step two: publish the list to this row's own settings namespace so a
        // later LLM connect plugin can read it. Opt-in, idempotent, and
        // fire-and-forget — a refused write never fails the poll.
        if (visionModels !== undefined) {
          void visionPublish.current?.(visionModels, visionModels.map((entry) => entry.id)).catch(() => {});
        }
        // Step three: persist the fetched catalog to the PRIVATE state file
        // and rebuild the registered provider, but ONLY when the offered set
        // actually changed — the catalog fetch is cached for an hour while the
        // panel polls every 30 s, so a write/re-register per poll would be pure
        // churn. The reported model counts come from the fresh catalog when
        // one arrived, else from whatever the mount seed had stored.
        let llmStatus;
        {
          const keyState = await apiKeyStore
            .state()
            .catch(() => ({ hasApiKey: false, keySource: null, ephemeral: false }));
          // The effective switch: a panel-saved value beats the patch default.
          // Both are reported so the panel can say which side is in charge.
          const panelSwitch = await providerStore.enabled().catch(() => null);
          let offered = providerState.entries;
          let enabledIds = providerState.enabledIds;
          if (Array.isArray(catalog)) {
            enabledIds = await catalogStore.listEnabledIds().catch(() => providerState.enabledIds);
            const signature = catalogSignature(catalog, enabledIds);
            if (signature !== providerState.signature) {
              providerState.signature = signature;
              await catalogStore.replace(catalog, enabledIds).catch(() => {});
              await publishProvider(catalog, enabledIds);
            }
            offered = catalog;
          }
          const summary = summarizeCatalog(offered);
          // Secret-free by construction: the store reports booleans/source
          // only, never the key value.
          llmStatus = {
            ...keyState,
            registerProvider: (panelSwitch ?? settings.registerProvider) === true,
            registerSource: panelSwitch === null ? "config" : "panel",
            llmAvailable: providerState.llmAvailable,
            providerRegistered: providerState.registered,
            providerId: LLM_PROVIDER_ID,
            modelCount: summary.modelCount,
            visionCount: summary.visionCount,
            ...(providerState.error !== null ? { providerError: providerState.error } : {})
          };
        }
        writeJson(response, 200, {
          ok: true,
          now: Date.now(),
          consoleBase: settings.consoleBase,
          // The panel polls on the Host's cadence and quotes the Host's cache
          // age, so neither number is written down twice. A panel that guessed
          // them would keep guessing after the operator changed either.
          cacheSeconds: settings.cacheSeconds,
          pollSeconds: settings.pollSeconds,
          // Token state, with no secret in it: the panel uses this to say
          // whether the token renews itself or is waiting on an account.
          auth: await tokenStore.state(),
          catalogAvailable: Array.isArray(catalog),
          catalogModels: catalogIds,
          // `undefined` (no API key) vs `[]` (key present, no vision models) —
          // the panel must not say "no vision models" when it simply never asked.
          ...(visionModels !== undefined ? { visionModels } : {}),
          uncountedModels: Array.isArray(catalog)
            ? catalogIds.filter((model) => !pools.pools.some((pool) => pool.modelIds.includes(model)))
            : [],
          // Step three status: key presence/source, opt-in, registration
          // state, and model/vision counts — never the key itself.
          llm: llmStatus,
          pools,
          trend,
          shapeWarnings
        }, { "cache-control": "no-store" });
      } catch (error) {
        // Distinguish "we cannot get a token" from "the console call failed":
        // the first is fixed by logging in, the second is usually transient.
        writeJson(response, 200, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          code: failureCode(error),
          auth: await tokenStore.state().catch(() => null)
        }, { "cache-control": "no-store" });
      }
    }
  });

  const offAccount = ctx.webServer.register({
    kind: "exact",
    path: ACCOUNT_PATH,
    handler: async (request, response) => {
      // The same fence as the snapshot route: without it, any page the
      // browser visits could post an account into this panel.
      if (!isAdmitted(request, settings.allowedHosts)) {
        writeJson(response, 403, { ok: false, error: "forbidden: origin mismatch" });
        return;
      }
      const method = request.method === undefined ? "POST" : request.method;
      if (method === "GET") {
        // The form needs to know whether an account is already stored, and
        // must never be told the password.
        writeJson(response, 200, { ok: true, ...(await tokenStore.state()) }, { "cache-control": "no-store" });
        return;
      }
      if (method !== "POST") {
        writeJson(response, 405, { ok: false, error: "method not allowed" });
        return;
      }
      const body = await readJsonBody(request);
      if (!body.ok) {
        writeJson(response, 400, { ok: false, error: body.error }, { "cache-control": "no-store" });
        return;
      }
      // `forget: true` clears the account without logging in again; the grant
      // survives on its refresh token until it needs the password again.
      if (body.value.forget === true) {
        try {
          await tokenStore.forgetAccount();
        } catch (error) {
          // The state is spread FIRST: it carries its own `error` field, and
          // spreading it after this one would overwrite the real reason with
          // whatever the store last saw.
          writeJson(response, 200, {
            ...(await tokenStore.state().catch(() => null)),
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          }, { "cache-control": "no-store" });
          return;
        }
        // The grant that just cleared answers the very next poll, so the cached
        // console responses from the previous account must not survive it.
        // (saveAccount does the same on its success path.)
        cache.clear();
        writeJson(response, 200, { ...(await tokenStore.state()), ok: true }, { "cache-control": "no-store" });
        return;
      }
      try {
        await tokenStore.saveAccount({ username: body.value.username, password: body.value.password });
        // The success trace is persisted through `onTrace`; no path is owed
        // to the panel for a sign-in that worked.
      } catch (error) {
        // A rejected password is the common case, and it is the user's to
        // correct: report the reason and leave the panel usable.
        const traceFile = await writeLoginTrace(error?.trace, str(error?.code, CODE.AUTH_ERROR));
        writeJson(response, 200, {
          ...(await tokenStore.state().catch(() => null)),
          ok: false,
          code: str(error?.code, CODE.AUTH_ERROR),
          error: error instanceof Error ? error.message : String(error),
          // The platform's own words ride along so the panel can show them
          // beneath the classified line.
          ...(error?.detail === undefined ? {} : { detail: String(error.detail) }),
          // The sanitized hop-by-hop record of this attempt: the panel links
          // to it, and a support question becomes answerable.
          ...(traceFile !== null ? { traceFile } : {}),
          // When the platform names a wait, the panel greys the form out for
          // that long: retrying inside the window is what extends a lockout.
          ...(typeof error?.retryAfterMs === "number" ? { retryAfterMs: error.retryAfterMs } : {})
        }, { "cache-control": "no-store" });
        return;
      }
      // The grant that just landed answers the very next poll, so the cached
      // console responses from the previous account must not survive it.
      cache.clear();
      writeJson(response, 200, { ...(await tokenStore.state()), ok: true }, { "cache-control": "no-store" });
    }
  });

  const offApiKey = ctx.webServer.register({
    kind: "exact",
    path: API_KEY_PATH,
    handler: async (request, response) => {
      // Same trust fence as the other two routes: a foreign page must not be
      // able to plant or wipe an inference key.
      if (!isAdmitted(request, settings.allowedHosts)) {
        writeJson(response, 403, { ok: false, error: "forbidden: origin mismatch" });
        return;
      }
      const method = request.method === undefined ? "GET" : request.method;
      // The secret-free state is all the form ever gets: present or not, and
      // whether it came from the credentials service or the environment.
      const answer = async (extra = {}) =>
        writeJson(
          response,
          200,
          { ok: true, ...(await apiKeyStore.state().catch(() => ({
            hasApiKey: false,
            keySource: null,
            ephemeral: false
          }))), ...extra },
          { "cache-control": "no-store" }
        );
      if (method === "GET") {
        await answer();
        return;
      }
      if (method !== "POST") {
        writeJson(response, 405, { ok: false, error: "method not allowed" });
        return;
      }
      const body = await readJsonBody(request);
      if (!body.ok) {
        writeJson(response, 400, { ok: false, error: body.error }, { "cache-control": "no-store" });
        return;
      }
      // Forget: drop the panel-saved REFERENCE only. An environment value is
      // deliberately left standing (forget cannot delete an operator's .env),
      // and the cached catalog answers the old key until the poll after.
      if (body.value.forget === true) {
        try {
          await apiKeyStore.forget();
          await catalogStore.clear().catch(() => {});
          cache.clear();
          providerState.signature = "";
          await publishProvider([], []);
          await answer();
        } catch (error) {
          await answer({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      try {
        await apiKeyStore.save(body.value.apiKey);
      } catch (error) {
        await answer({ ok: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      // The next poll fetches the catalog with the new key; a stale catalog
      // cached under a previous key must not survive it. The key itself is
      // resolved per REQUEST by the adapter, so no provider rebuild is needed.
      cache.clear();
      await answer();
    }
  });

  const offProvider = ctx.webServer.register({
    kind: "exact",
    path: PROVIDER_PATH,
    handler: async (request, response) => {
      // Same trust fence as the other three routes: a foreign page must not be
      // able to flip model routing for the whole Host.
      if (!isAdmitted(request, settings.allowedHosts)) {
        writeJson(response, 403, { ok: false, error: "forbidden: origin mismatch" });
        return;
      }
      const method = request.method === undefined ? "GET" : request.method;
      // Secret-free by construction: the effective switch, where it came from,
      // and whether a provider is registered right now.
      const answer = async (extra = {}) => {
        const panelSwitch = await providerStore.enabled().catch(() => null);
        writeJson(
          response,
          200,
          {
            ok: true,
            registerProvider: (panelSwitch ?? settings.registerProvider) === true,
            registerSource: panelSwitch === null ? "config" : "panel",
            providerRegistered: providerState.registered,
            ...(providerState.error !== null ? { providerError: providerState.error } : {}),
            ...extra
          },
          { "cache-control": "no-store" }
        );
      };
      if (method === "GET") {
        await answer();
        return;
      }
      if (method !== "POST") {
        writeJson(response, 405, { ok: false, error: "method not allowed" });
        return;
      }
      const body = await readJsonBody(request);
      if (!body.ok) {
        writeJson(response, 400, { ok: false, error: body.error }, { "cache-control": "no-store" });
        return;
      }
      if (typeof body.value.enabled !== "boolean") {
        writeJson(response, 400, { ok: false, error: "expected { enabled: boolean }" }, { "cache-control": "no-store" });
        return;
      }
      try {
        await providerStore.save(body.value.enabled);
        // Publish immediately with the CURRENT catalog: the switch decides
        // whether the models are offered at all, not what they are. A failed
        // publish rolls back to the previous pair inside publishProvider and
        // surfaces its reason in providerState.error.
        await publishProvider(providerState.entries, providerState.enabledIds);
      } catch (error) {
        await answer({ ok: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      await answer();
    }
  });

  ctx.effect(() => () => {
    // Before anything else: a publish still in flight (the mount seed's, or a
    // poll's) must not register into a Host that is letting this plugin go.
    disposed = true;
    // Stop offering the provider first, so a request cannot be routed to an
    // adapter whose Host services are already half gone.
    releaseProvider();
    for (const off of [offRoute, offAccount, offApiKey, offProvider]) {
      try {
        off();
      } catch {
        // The web server may already be gone during shutdown.
      }
    }
  }, `${name}: routes`);

  // ------------------------------------------------------------------
  // Vision step two (ARCHITECTURE.md §5.1): publish which of this key's
  // models take image input into THIS row's own settings namespace, for
  // a later LLM connect plugin (dsh-provider-sensenova, etc.) to read.
  //
  // The write goes to this plugin's settings row ONLY - never another
  // provider's `imageModelIds` - so a miscalculated model list can only
  // affect the panel, not DSH's model routing. It is opt-in
  // (`writeImageModelIds`), off by default, and idempotent: a no-change
  // pass costs one revision read and no write.
  //
  // `visionPublish.current` is filled in here from `ctx.get("settings")`
  // (the resolver-not-snapshot pattern: the service may register after
  // this plugin mounts); a Host without one leaves it null and the
  // publish simply never runs.
  // ------------------------------------------------------------------
  {
    const settingsService = ctx.get("settings") ?? null;
    if (settingsService !== null && typeof settingsService.update === "function") {
      const descriptorOf = () => {
        try {
          const view = settingsService.describe?.({ redactSecrets: true });
          const rows = Array.isArray(view) ? view : view?.entries ?? [];
          return rows.find((candidate) => candidate?.ns === name) ?? null;
        } catch {
          return null;
        }
      };
      let publishing = false;
      let lastPublishedIds = settings.imageModelIds.slice();
      visionPublish.current = async (visionEntries, ids) => {
        if (settings.writeImageModelIds !== true) return;
        if (publishing) return;
        if (JSON.stringify(lastPublishedIds) === JSON.stringify(ids)) return;
        const descriptor = descriptorOf();
        if (descriptor === null) return;
        publishing = true;
        try {
          await settingsService.update(name, {
            imageModelIds: ids,
            visionModels: visionEntries
          }, descriptor.revision);
          lastPublishedIds = ids.slice();
        } catch (error) {
          ctx.logger?.warn?.(`${name}: vision publish refused: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          publishing = false;
        }
      };
    }
  }
}

export { apply, inject, name, resolveSettings, resolveAuthOverrides, CONFIG_DEFAULTS, hostName, isAdmitted };
