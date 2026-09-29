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
import { createFileCatalogStore, normalizeEnabledIds } from "./catalog-store.js";
import { createFileProviderStore } from "./provider-store.js";
import { createApiKeyStore } from "./api-key-store.js";
import { defineDrawTool } from "./draw.js";
import { createProviderPublisher, catalogSignature, seedPublisherFromCatalog } from "./provider-publish.js";
import { buildSnapshotBody } from "./snapshot-aggregate.js";
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
import { writeLoginTrace } from "./trace.js";
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
/**
 * The model-roster route: which of this key's models the registered provider
 * actually offers (docs/API.md). It writes the curated allow-list into the
 * private catalog state file and republishes immediately — no restart. Same
 * trust fence and body ceiling as the account/api-key routes.
 */
const MODELS_PATH = `/api/${name}/models`;
/** Ceiling on a submitted account, so a hostile page cannot stream a body. */
const MAX_ACCOUNT_BODY_BYTES = 4096;
/**
 * Ceiling on the curated allow-list. The state file is small by design and a
 * catalogue this large would not fit any SenseNova plan; anything beyond is a
 * posting accident, not a curation.
 */
const MAX_ENABLED_MODEL_IDS = 500;
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
 * Lives in `provider-publish.js` alongside the publish state machine that
 * consumes it (the offered-set gate and the mount seed both call it);
 * re-exported here so the snapshot route's quota branch keeps using the same
 * function the publisher uses — two copies of the signature would drift and
 * the poll would either churn the registration or skip a needed rebuild.
 */
export { catalogSignature } from "./provider-publish.js";

/**
 * Host body: mount the snapshot route. The panel polls it; each poll reads
 * the console through a short-lived cache and a self-renewing token.
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
  // It lets the registered provider offer models before the first poll of a
  // restart, and survives with no console login at all.
  const catalogStore = createFileCatalogStore();
  // The panel's live provider switch (docs/PROVIDER-HOT-RELOAD.md). A value
  // saved from the panel overrides the patch's `registerProvider`; an untouched
  // state file falls back to it, so configuration-driven deployments keep
  // working unchanged.
  const providerStore = createFileProviderStore();

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

  // Seed the registration from the persisted catalog so a restarted Host
  // offers models before its first poll (and with no console login at all).
  // Fire-and-forget: a state dir that cannot be read just waits for the poll.
  void seedPublisherFromCatalog(
    publisher,
    () => catalogStore.list(),
    () => catalogStore.listEnabledIds(),
    catalogSignature
  );

  // Draw absorption (ARCHITECTURE.md §5.4, route B): the `sensenova_draw_image`
  // agent tool. Opt-in (`drawEnabled`, default off) and doubly degraded — a
  // Host with no tools service never sees it, and a peer that fails to load
  // leaves the panel and the provider untouched: the same "module absent,
  // panel works" shape as the provider without an `llm` service. The tool
  // itself is defined in the peer-free `draw.js` (structured `output_modalities`
  // identification, per-call key resolution, failed-draw cooldown); only this
  // import touches a peer, lazily, exactly like the adapter above.
  const loadToolsModule = deps.loadToolsModule ?? (() => import("@deepseek-ai/dsh-tools"));
  const drawFetch = deps.drawFetch ?? ((url, options) => fetch(url, options));
  void (async () => {
    if (configError !== null || settings.drawEnabled !== true) return;
    const tools = getService("tools") ?? ctx.tools ?? null;
    if (tools === null || typeof tools.register !== "function") return;
    let defineTool;
    try {
      const mod = await Promise.resolve(loadToolsModule());
      defineTool = mod?.defineTool ?? mod?.default?.defineTool ?? null;
    } catch {
      // No tools peer on this Host: the draw tool stays absent, nothing logs.
      return;
    }
    if (typeof defineTool !== "function") return;
    try {
      tools.register(
        defineDrawTool({
          defineTool,
          resolveApiKey,
          // The draw's discovery set is the catalog, NOT the LLM offer: the
          // picker's allow-list is a filter on what the picker OFFERS, and
          // silently binding the agent's image tools to that curation would
          // drop a draw model from the tool's world the moment a user trimmed
          // the picker. The full persisted catalog is read at call time
          // (after mount an empty read is a no-op — `catalog-store.list()` is
          // cached in memory), so a catalog refresh lands without re-registering.
          getEntries: async () => {
            const live = Array.isArray(providerState.entries) && providerState.entries.length > 0
              ? providerState.entries
              : await catalogStore.list().catch(() => []);
            return Array.isArray(live) ? live : [];
          },
          settings,
          fetchImpl: drawFetch,
          isDisposed: () => publisher.isDisposed()
        })
      );
    } catch {
      // A refusing registry degrades identically: tool absent, panel fine.
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
        // Step two (vision, ARCHITECTURE.md §5.1): publish the computed list to
        // this row's own settings namespace so a later LLM connect plugin can
        // read it. The aggregate needs to know the vision list before it builds
        // the body (it carries `visionModels`), so the caller computes it up
        // front and hands it in.
        const body = await buildSnapshotBody({
          settings,
          cache,
          inflight,
          tokenStore,
          apiKeyStore,
          publisher,
          catalogStore,
          panelSwitch: () => providerStore.enabled().catch(() => null)
        });
        if (body.visionModels !== undefined) {
          void visionPublish.current?.(body.visionModels, body.visionModels.map((entry) => entry.id)).catch(() => {});
        }
        writeJson(response, 200, body, { "cache-control": "no-store" });
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
          providerState.quotaSignature = "";
          await publishProvider([], [], []);
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
        await publishProvider(providerState.entries, providerState.enabledIds, providerState.unavailableIds ?? []);
      } catch (error) {
        await answer({ ok: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      await answer();
    }
  });

  const offModels = ctx.webServer.register({
    kind: "exact",
    path: MODELS_PATH,
    handler: async (request, response) => {
      // Same fence as the other routes: a foreign page must not be able to
      // decide which models this Host offers.
      if (!isAdmitted(request, settings.allowedHosts)) {
        writeJson(response, 403, { ok: false, error: "forbidden: origin mismatch" });
        return;
      }
      const method = request.method === undefined ? "POST" : request.method;
      if (method !== "POST") {
        writeJson(response, 405, { ok: false, error: "method not allowed" });
        return;
      }
      const body = await readJsonBody(request);
      if (!body.ok) {
        writeJson(response, 400, { ok: false, error: body.error }, { "cache-control": "no-store" });
        return;
      }
      // An absent field is refused rather than read as "all models": writing
      // that would silently widen the offer to every model in the catalogue.
      if (!Array.isArray(body.value.enabledModelIds)) {
        writeJson(response, 400, { ok: false, error: "expected { enabledModelIds: string[] }" },
          { "cache-control": "no-store" });
        return;
      }
      const ids = normalizeEnabledIds(body.value.enabledModelIds);
      if (ids.length > MAX_ENABLED_MODEL_IDS) {
        writeJson(response, 400,
          { ok: false, error: `enabledModelIds is too long (max ${MAX_ENABLED_MODEL_IDS})` },
          { "cache-control": "no-store" });
        return;
      }
      const answer = async (extra = {}) => {
        writeJson(response, 200, {
          ok: true,
          enabledModelIds: await catalogStore.listEnabledIds().catch(() => providerState.enabledIds),
          registerProvider:
            ((await providerStore.enabled().catch(() => null)) ?? settings.registerProvider) === true,
          providerRegistered: providerState.registered,
          ...(providerState.error !== null ? { providerError: providerState.error } : {}),
          ...extra
        }, { "cache-control": "no-store" });
      };
      try {
        await catalogStore.setEnabledIds(ids);
        // The next poll must not re-publish the same offer: adopt the signature
        // of what was just offered, or every poll would churn the registration.
        providerState.signature = catalogSignature(providerState.entries, ids);
        // Publish immediately with the CURRENT catalogue: the offer must not
        // wait for the next poll. A failed publish rolls back to the previous
        // pair inside publishProvider and surfaces its reason.
        await publishProvider(providerState.entries, ids, providerState.unavailableIds ?? []);
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
    publisher.dispose();
    // Stop offering the provider first, so a request cannot be routed to an
    // adapter whose Host services are already half gone.
    releaseProvider();
    for (const off of [offRoute, offAccount, offApiKey, offProvider, offModels]) {
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
