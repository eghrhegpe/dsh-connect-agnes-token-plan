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
 * Host body: mount the snapshot route. The panel polls it; each poll reads
 * the console through a short-lived cache and a self-renewing token.
 * @param ctx - host root context.
 * @param config - the row's raw patch config. There is no DSH Config schema, so
 *   values arrive unvalidated; the endpoint overrides are checked where they
 *   are consumed (`createAuth` throws on a malformed origin) and the failure
 *   is surfaced through the snapshot instead of crashing the route.
 */
function apply(ctx, config = {}) {
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
  // The API key is the same one the LLM provider route uses. DSH's providers
  // resolve it through the credentials service's reference layer (the
  // "user-level environment" the panel's read-only input points at) and only
  // fall back to the raw process environment — the value may live in
  // `~/.dsh/.credentials.yaml` alone, which a sibling shell never sees, so
  // reading `process.env` first is what left this panel blind on machines
  // where the key is stored there. Treated as optional: absent → the model
  // lists degrade, the quota panel still works.
  const resolveApiKey = async () => {
    try {
      const credentials = ctx.get("credentials") ?? null;
      if (credentials && typeof credentials.resolve === "function") {
        const resolved = await credentials.resolve("SENSENOVA_API_KEY");
        const value = resolved?.value;
        if (typeof value === "string" && value.trim() !== "") return value;
      }
    } catch {
      // No credentials service or the reference absent: fall through.
    }
    return str(process.env.SENSENOVA_API_KEY, "");
  };
  /** @type {Map<string, import("./console-client.js").CacheEntry>} */
  const cache = new Map();
  /** One in-flight console fetch per URL, so concurrent polls share a call. */
  const inflight = new Map();

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

  ctx.effect(() => () => {
    for (const off of [offRoute, offAccount]) {
      try {
        off();
      } catch {
        // The web server may already be gone during shutdown.
      }
    }
  }, `${name}: routes`);
}

export { apply, inject, name, resolveSettings, resolveAuthOverrides, CONFIG_DEFAULTS, hostName, isAdmitted };
