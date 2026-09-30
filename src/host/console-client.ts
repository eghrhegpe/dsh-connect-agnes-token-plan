/**
 * The Host half's console and model-catalog fetches: caching plus single-flight.
 *
 * Both endpoints share one in-flight map per URL, so several open panels (or
 * tabs) polling at once issue a single console request instead of N — which is
 * also how the Host stays off the platform's own rate limiter. Cached responses
 * age out on their own TTL, and a safety sweep drops anything older than the
 * longest TTL so the map never grows without bound.
 * @module dsh-connect-agnes-token-plan/console-client
 */

import { CODE } from "./codes.ts";
import { str, obj } from "./util.ts";

/**
 * One cached console response: the body plus the epoch millis it was fetched.
 * @typedef {{body: unknown, at: number}} CacheEntry
 */

/** Longest TTL any caller uses; entries older than this are swept. */
const MAX_CACHE_AGE_MS = 3600_000;

/** Drop entries older than the longest TTL so the map stays bounded. */
function sweepCache(cache) {
  const nowMs = Date.now();
  for (const [key, entry] of cache) {
    if (nowMs - entry.at > MAX_CACHE_AGE_MS) cache.delete(key);
  }
}

/**
 * Fetch one console endpoint with a bearer token, caching the result.
 *
 * A 401/403 means the token the console saw is no longer good, so the store is
 * invalidated and the call retried exactly once with a fresh token. Without
 * the retry a token that expires mid-poll would leave the panel stuck on an
 * error until the next manual re-login; with it, the panel heals itself.
 *
 * @param settings - resolved plugin settings.
 * @param path - the console path, e.g. `/lite/console/v1/tokenplan/pool-usage`.
 * @param params - optional query parameters.
 * @param cacheMs - how long to keep the response.
 * @param cache - the cache map to use.
 * @param inflight - the in-flight map to share requests through.
 * @param tokenStore - the credentials-backed token store.
 * @returns {Promise<unknown>} the parsed console body.
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
    const send = async (token) => fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(settings.consoleTimeoutMs)
    });

    let token = await tokenStore.getToken();
    let response = await send(token);
    if (response.status === 401 || response.status === 403) {
      // The console rejected this exact token: mark it refused so the store
      // renews, then try once more. Naming the token matters because a poll
      // issues several requests at once, each of which may be holding a
      // different one.
      tokenStore.invalidate(token);
      token = await tokenStore.getToken();
      response = await send(token);
    }
    if (response.status === 401 || response.status === 403) {
      const error = new Error(`console rejected the token (HTTP ${response.status})`) as import("./types.ts").PluginError;
      error.code = CODE.JWT_EXPIRED;
      throw error;
    }
    if (!response.ok) {
      throw new Error(`console returned HTTP ${response.status}`);
    }
    const body = await response.json();
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
 * This is a free, read-only `GET /v1/models` — it spends no credits and
 * consumes no inference quota. It is the same list the DSH Models page shows
 * in "选择要添加的模型", and it is deliberately kept separate from the
 * console's `pool-usage` `model_ids`, which is the PLAN's advertised
 * coverage (it lists models this key has no permission for).
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
