/**
 * The Host half's console and model-catalog fetches: envelope handling, caching
 * plus single-flight.
 *
 * Every Agnes backend answer is wrapped in `{code, message, data}` — the body
 * of a 200 can still be a refusal, and a dead session answers `code: 401`
 * `"Not logged in or invalid token"`. Unwrapping happens HERE, once, so no
 * caller has to remember the envelope and no parser has to look one level down.
 *
 * Both authenticated endpoints share one in-flight map per URL, so several
 * open panels (or tabs) polling at once issue a single console request instead
 * of N — which is also how the Host stays off the platform's own rate limiter.
 * Cached responses age out on their own TTL, and a safety sweep drops anything
 * older than the longest TTL so the map never grows without bound.
 * @module dsh-connect-agnes-token-plan/console-client
 */

import { CODE } from "./codes.ts";
import { str, obj } from "./util.ts";

/** Longest TTL any caller uses; entries older than this are swept. */
const MAX_CACHE_AGE_MS = 3600_000;

/** The envelope's success code. Anything else is a refusal, even on HTTP 200. */
const ENVELOPE_OK = 200;

/** The plan catalogue path. The `/cn/` segment is required — without it: 404. */
export const PLANS_PATH = "/api/cn/user/subscription/plans";

/** Drop entries older than the longest TTL so the map stays bounded. */
function sweepCache(cache) {
  const nowMs = Date.now();
  for (const [key, entry] of cache) {
    if (nowMs - entry.at > MAX_CACHE_AGE_MS) cache.delete(key);
  }
}

/**
 * Whether an envelope code means "the token is no longer good".
 *
 * Agnes reports an expired session as `code: 401` inside an HTTP 401, but the
 * same code can ride a 200 on a route that answers before it authenticates, so
 * both layers are checked. 403 is included because a revoked token answers
 * that way on some routes and the recovery is identical.
 * @param {unknown} code - the envelope's `code` field.
 * @returns {boolean} true when the caller should renew and retry once.
 */
export function isAuthRefusal(code) {
  return Number(code) === 401 || Number(code) === 403;
}

/**
 * Build the Error for a stated non-200 envelope code.
 *
 * The platform's own `message` is the only text that explains a refusal
 * ("Not logged in or invalid token" vs "plan not found"), so it is carried
 * verbatim rather than replaced by a code table.
 * @param {unknown} body - the parsed response body.
 * @param {string} label - the endpoint, for context when `message` is empty.
 * @returns {import("./types.ts").PluginError} the error to throw.
 */
function refusalError(body, label) {
  const source = obj(body);
  const code = Number(source.code);
  const message = str(source.message, "");
  const error = new Error(
    message === "" ? `${label} refused with code ${code}` : `${label}: ${message}`
  ) as import("./types.ts").PluginError;
  error.code = isAuthRefusal(code) ? CODE.JWT_EXPIRED : CODE.CONSOLE_ERROR;
  return error;
}

/**
 * Unwrap the platform's `{code, message, data}` envelope.
 *
 * A body that carries no `code` at all is returned as-is rather than refused:
 * a route that answers a bare object (or an array) is still a valid answer,
 * and inventing a refusal for it would turn a working call into a permanent
 * error. Only a STATED non-200 code is a refusal.
 *
 * @param {unknown} body - the parsed response body.
 * @param {string} label - the endpoint, for the error message.
 * @returns {unknown} the envelope's `data`, or the body itself when unwrapped.
 * @throws {import("./types.ts").PluginError} when the envelope states a non-200 code.
 */
export function unwrapEnvelope(body, label) {
  const source = obj(body);
  const code = source.code;
  if (code === undefined || code === null) return body;
  if (Number(code) === ENVELOPE_OK) return source.data;
  throw refusalError(body, label);
}

/**
 * Fetch one authenticated console endpoint with a bearer token, caching the
 * unwrapped `data`.
 *
 * A 401/403 — at the HTTP layer OR in the envelope — means the token the
 * console saw is no longer good, so the store is invalidated and the call
 * retried exactly once with a fresh token. Without the retry a token that
 * expires mid-poll would leave the panel stuck on an error until the next
 * manual re-login; with it, the panel heals itself. The retry is not
 * recursive: a token minted a moment ago that is ALSO refused means the
 * account, not the token, is the problem — and retrying harder is how an
 * account gets locked.
 *
 * @param settings - resolved plugin settings.
 * @param path - the console path, e.g. `/api/usage/overview`.
 * @param params - optional query parameters.
 * @param cacheMs - how long to keep the response.
 * @param cache - the cache map to use.
 * @param inflight - the in-flight map to share requests through.
 * @param tokenStore - the credentials-backed token store.
 * @returns {Promise<unknown>} the unwrapped console `data`.
 */
export async function fetchConsole(settings, path, params, cacheMs, cache, inflight, tokenStore) {
  const query = params && Object.keys(params).length > 0
    ? `?${new URLSearchParams(params).toString()}`
    : "";
  const url = `${settings.consoleBase}${path}${query}`;
  const cached = cache.get(url);
  if (cached !== undefined && Date.now() - cached.at < cacheMs) return cached.body;

  // One in-flight fetch per URL: many open panels (or tabs) polling at once
  // must not each hammer the console. The same request is shared until it
  // resolves, which also keeps the host off the platform's own rate limiter.
  const pending = inflight.get(url);
  if (pending !== undefined) return pending;

  const run = async () => {
    /** One attempt: `{data}` on success, `{authRefused: true}` when renewing helps. */
    const attempt = async (token) => {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(settings.consoleTimeoutMs)
      });
      if (response.status === 401 || response.status === 403) return { authRefused: true };
      if (!response.ok) throw new Error(`console returned HTTP ${response.status} on ${path}`);
      const body = await response.json();
      const code = obj(body).code;
      if (code !== undefined && code !== null && Number(code) !== ENVELOPE_OK) {
        if (isAuthRefusal(code)) return { authRefused: true };
        throw refusalError(body, path);
      }
      return { data: code === undefined || code === null ? body : obj(body).data };
    };

    let token = await tokenStore.getToken();
    let result = await attempt(token);
    if (result.authRefused) {
      // The console rejected this exact token: mark it refused so the store
      // renews, then try once more. Naming the token matters because a poll
      // issues several requests at once, each of which may be holding a
      // different one.
      tokenStore.invalidate(token);
      token = await tokenStore.getToken();
      result = await attempt(token);
    }
    if (result.authRefused) {
      const error = new Error(`console rejected the token (${path})`) as import("./types.ts").PluginError;
      error.code = CODE.JWT_EXPIRED;
      throw error;
    }
    // Cached only after the envelope was read: caching a refusal would make one
    // transient 401 stick for the whole TTL, and the panel would keep showing
    // "not signed in" long after the store had healed.
    cache.set(url, { body: result.data, at: Date.now() });
    sweepCache(cache);
    return result.data;
  };

  const flight = run().finally(() => { inflight.delete(url); });
  inflight.set(url, flight);
  return flight;
}

/**
 * Fetch the public plan catalogue — the only quota source that needs no login.
 *
 * `GET /api/cn/user/subscription/plans` answers 200 to an anonymous request
 * (verified 2026-10-01: six plans, `入门版`/`专业版`/`高级版` × monthly/yearly).
 * Two things follow from that: the panel can show what upgrading buys without
 * ever asking for a credential, and this is the one quota source that survives
 * a partial failure of the authenticated half.
 *
 * @param settings - resolved plugin settings.
 * @param cacheMs - how long to keep the response (long: the catalogue is stable).
 * @param cache - the cache map to use.
 * @param inflight - the in-flight map to share requests through.
 * @returns {Promise<unknown>} the unwrapped `data` array, or `null` on failure.
 */
export async function fetchPlans(settings, cacheMs, cache, inflight) {
  const url = `${settings.consoleBase}${PLANS_PATH}`;
  const cached = cache.get(url);
  if (cached !== undefined && Date.now() - cached.at < cacheMs) return cached.body;

  const pending = inflight.get(url);
  if (pending !== undefined) return pending;

  const run = async () => {
    // No `authorization` header at all — sending an empty Bearer turns a
    // public endpoint into a refused one on this gateway.
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(settings.consoleTimeoutMs)
    });
    if (!response.ok) throw new Error(`${PLANS_PATH} returned HTTP ${response.status}`);
    const body = unwrapEnvelope(await response.json(), PLANS_PATH);
    cache.set(url, { body, at: Date.now() });
    sweepCache(cache);
    return body;
  };

  const flight = run().finally(() => { inflight.delete(url); });
  inflight.set(url, flight);
  return flight;
}

/**
 * Fetch the API-key model catalog: the models this key can actually call.
 *
 * This is a free, read-only `GET /v1/models` — it spends no quota and consumes
 * no inference allowance. It is the same list the DSH Models page shows in
 * "选择要添加的模型", and it is the ONLY per-model availability signal Agnes
 * offers: the platform has no per-model quota, so "can this model be called"
 * is answered by the key's own catalogue rather than by any pool.
 *
 * @param settings - resolved plugin settings.
 * @param cacheMs - how long to keep the response (long: the catalog is stable).
 * @param cache - the cache map to use.
 * @param inflight - the in-flight map to share requests through.
 * @param apiKey - the Agnes API key.
 */
export async function fetchModelCatalog(settings, cacheMs, cache, inflight, apiKey) {
  const url = `${settings.apiBase}/models`;
  const cached = cache.get(url);
  if (cached !== undefined && Date.now() - cached.at < cacheMs) return cached.body;

  // Same single-flight treatment as fetchConsole: an open panel and a Models
  // page both poll `/v1/models`, and they should share one call.
  const pending = inflight.get(url);
  if (pending !== undefined) return pending;

  const run = async () => {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      // The catalog is a console call on the same footing as any other, so it
      // takes the console deadline rather than a number of its own.
      signal: AbortSignal.timeout(settings.consoleTimeoutMs)
    });
    if (!response.ok) throw new Error(`/v1/models returned HTTP ${response.status}`);
    const body = await response.json();
    // The OpenAI shape is NOT enveloped — this is the gateway, not the console,
    // so `unwrapEnvelope` is deliberately not used here.
    // Keep the WHOLE entry, not just the id: vision identification may read
    // structured fields (input_modalities etc.) that a bare id list throws
    // away. `id` is normalized; unknown fields ride along untouched so a
    // platform adding `input_modalities` needs no parser change here.
    const models = Array.isArray(body?.data)
      ? body.data
          .map((entry) => {
            const source = obj(entry);
            return { id: str(source.id, ""), ...source };
          })
          .filter((entry) => entry.id !== "")
      : [];
    cache.set(url, { body: models, at: Date.now() });
    sweepCache(cache);
    return models;
  };

  const flight = run().finally(() => { inflight.delete(url); });
  inflight.set(url, flight);
  return flight;
}
