/**
 * The model catalogue's REFRESH and its effects — owned by the Host.
 *
 * ## Why this module exists (ADR-015)
 *
 * Both halves used to run inside the snapshot route: the panel's `GET` fetched
 * `/v1/models` as one of its five sources and, on a changed catalogue, persisted
 * it and re-registered the provider. That made the browser the Host's clock —
 * with no panel open and no conversation on an `agnes-*` model, nothing polled,
 * so a model the platform added stayed invisible for the life of the process.
 * The panel and the composer pill also poll independently, which meant two
 * clients could drive the same control-plane write.
 *
 * So the write half moves here and the Host owns the cadence: {@link start}
 * ticks at the rate the Host already declares to the panel (`pollSeconds`), and
 * `run` is the ONE place the catalogue is persisted and the provider rebuilt.
 * The route keeps calling `run` with the catalogue it fetched (a panel that is
 * open still refreshes immediately), and the single-flight chain below makes
 * "one writer at a time" true no matter how many callers there are.
 *
 * ## Why a tick at the panel's cadence costs nothing
 *
 * `refresh` returns immediately when the cached catalogue is still fresh
 * (`CATALOG_CACHE_MS`, the same hour the fetch has always used): one `Map`
 * lookup, no key resolution, no request, no disk. A tick only becomes work when
 * the cache has expired — so the cadence can be the panel's without turning the
 * Host into a poller of its own.
 *
 * Two shapes the cache cannot answer for, and neither may become "retry at the
 * tick rate":
 *
 *   - "no key configured" — nothing is ever cached, so the check never exits;
 *     memoized for {@link NO_KEY_RETRY_MS} so it cannot turn into a credentials
 *     read every interval.
 *   - "the gateway refused" — `sharedFetch` writes the cache only on SUCCESS,
 *     so a failing fetch leaves the entry as stale as it was and every tick
 *     retries. At the default cadence that is 120 requests an hour, 2,880 a day,
 *     forever, against a gateway that is already saying no. {@link retryDelayMs}
 *     backs that off to a handful per hour and caps the wait at
 *     {@link CATALOG_RETRY_MAX_MS}; the first failure of a streak is logged, so
 *     the backoff is visible instead of looking like a quiet Host.
 *
 * ## What this module deliberately does NOT do
 *
 * It never reads the console. Quota needs the account token and carries the
 * lockout discipline (`token-store.ts`); the catalogue needs only the inference
 * key and is served by the gateway. Keeping them apart is what makes a
 * background refresh safe to run with nobody watching.
 *
 * Peer-free: no Host package is imported, and `fetchCatalog` is injectable so
 * the offline suites drive every branch without a network.
 *
 * @module dsh-connect-agnes-token-plan/catalog-refresh
 */
import { fetchModelCatalog } from "./console-client.ts";
import { catalogSignature } from "./provider-publish.ts";
import { num } from "./util.ts";
import type { CacheMap, InflightMap, Settings } from "./types.ts";
import type { createApiKeyStore } from "./api-key-store.ts";
import type { createFileCatalogStore } from "./catalog-store.ts";
import type { createProviderPublisher } from "./provider-publish.ts";
import type { PublisherLogger } from "./publish-core.ts";

/**
 * How long a fetched catalogue stays usable.
 *
 * The same hour `fetchModelCatalog` has been called with since it shipped —
 * named here because the tick now READS this number to decide whether it has
 * anything to do, and a second literal would let the two drift into a tick that
 * refetches what the cache would have answered.
 */
export const CATALOG_CACHE_MS = 3600_000;

/**
 * How long "there is no inference key" is trusted before asking again.
 *
 * Without this the no-key case is the one shape that makes the tick expensive:
 * no key means no catalogue is ever cached, so the cache check can never take
 * the cheap exit and every tick would ask the credentials service again — 2,880
 * reads a day on a Host that simply has not been set up yet. A minute is short
 * enough that a key saved in the panel is picked up by the tick soon after, and
 * the panel's own poll does not wait for it at all (a save triggers a snapshot,
 * which fetches and applies the catalogue directly).
 */
const NO_KEY_RETRY_MS = 60_000;

/**
 * The first wait after a failed catalogue fetch, and the ceiling it doubles to.
 *
 * The number to beat is the tick itself: a failure that is retried on the next
 * tick is not a retry policy, it is the tick rate wearing a policy. From 30 s
 * the waits are 30, 60, 120, 240, 480, 900, 900 … — about five attempts in the
 * first hour instead of 120, settling at four an hour. The ceiling is what keeps
 * a transient blip from parking discovery for an hour: a Host whose gateway
 * comes back is back within fifteen minutes even with nobody watching, and the
 * panel's own poll does not wait for the tick at all (a `GET /snapshot` fetches
 * and applies the catalogue directly).
 */
export const CATALOG_RETRY_BASE_MS = 30_000;
export const CATALOG_RETRY_MAX_MS = 900_000;

/**
 * The wait before attempt `failures + 1` — exponential from
 * {@link CATALOG_RETRY_BASE_MS}, capped at {@link CATALOG_RETRY_MAX_MS}.
 *
 * Pure and exported so the schedule is pinnable without a clock: the tick's
 * cost is this function, and "how long does a dead gateway cost us" should be
 * answerable by reading one line rather than by running an hour of fake time.
 * @param {number} failures - consecutive failures so far (≥ 1).
 * @returns {number} the delay in ms.
 */
export function retryDelayMs(failures: number) {
  const steps = Math.max(1, Math.floor(num(failures, 1)));
  // Cap the EXPONENT before shifting: `2 ** 31` overflows to Infinity, and a
  // delay of Infinity would stop the tick for the life of the process.
  const exponent = Math.min(steps - 1, 20);
  return Math.min(CATALOG_RETRY_BASE_MS * 2 ** exponent, CATALOG_RETRY_MAX_MS);
}

/**
 * The floor on the tick interval.
 *
 * The tick re-reads a `Map`; the floor is not about its cost but about not
 * letting a misconfigured `pollSeconds` turn into a busy loop (that number is
 * clamped at 5 s already, and this keeps the background path independent of a
 * future relaxation of that clamp).
 */
const MIN_TICK_MS = 1_000;

/** The effect surface `buildSnapshotBody` and the tick share. */
export interface CatalogEffects {
  /**
   * Persist a fresh catalogue and rebuild the registration when the offered set
   * changed. Serialized: concurrent callers queue, so the signature check and
   * the write it guards cannot interleave.
   * @param catalog - the raw `/v1/models` answer.
   * @param enabledIds - the curated allow-list (empty = no filter), or
   *   `undefined` for "whatever the panel last saved" — which is what every
   *   background caller passes, because a refresh must not overwrite a save it
   *   did not make.
   * @param unavailableModelIds - the blocked set (always empty today).
   * @returns the entries to offer and whether the catalogue branch published.
   */
  run(catalog: unknown, enabledIds: string[] | undefined, unavailableModelIds: string[]): Promise<{ offered: unknown; catalogChanged: boolean }>;
  /**
   * Fetch the catalogue from upstream and apply it — or do nothing at all when
   * the cached copy is still fresh or no inference key is configured.
   */
  refresh(): Promise<void>;
  /**
   * Run `refresh` every `intervalMs`; returns the stop function.
   *
   * The first tick is DELAYED by one interval on purpose: `apply()` currently
   * reaches the network for nothing at mount (the seed reads disk), and a Host
   * that starts and stops inside 30 s should not leave a gateway request
   * behind. A panel that is open drives the first fetch immediately anyway.
   *
   * The timer is `unref`'d where the platform allows it, so a Host that is
   * otherwise idle can still exit.
   */
  start(intervalMs: number): () => void;
}

/** Everything the refresh needs, resolved once at mount. */
export interface CatalogEffectsDeps {
  settings: Settings;
  cache: CacheMap;
  inflight: InflightMap;
  apiKeyStore: ReturnType<typeof createApiKeyStore>;
  catalogStore: ReturnType<typeof createFileCatalogStore>;
  publisher: ReturnType<typeof createProviderPublisher>;
  logger?: PublisherLogger | null;
  /** Test seam: the catalogue fetch (defaults to the real gateway call). */
  fetchCatalog?: typeof fetchModelCatalog | undefined;
}

/**
 * Build the catalogue's single writer.
 * @param deps - see {@link CatalogEffectsDeps}.
 * @returns the effect surface (see {@link CatalogEffects}).
 */
export function createCatalogEffects(deps: CatalogEffectsDeps): CatalogEffects {
  const { settings, cache, inflight, apiKeyStore, catalogStore, publisher, logger } = deps;
  const fetchCatalog = deps.fetchCatalog ?? fetchModelCatalog;
  const providerState = publisher.state;
  // The ONE serializer for the write half. `publisher.publish` already queues
  // internally, but the signature READ that decides whether to publish does
  // not: two callers arriving together would both see a changed signature and
  // both persist + publish. Chaining the whole unit closes that window.
  let chain: Promise<unknown> = Promise.resolve();
  /** When the last "no inference key" answer was seen (0 = none, or a key exists). */
  let noKeyAt = 0;
  /** Consecutive failed fetches; 0 means the last attempt worked (or none yet). */
  let failures = 0;
  /** Epoch ms before which no retry is attempted (0 = no backoff pending). */
  let retryAt = 0;

  /**
   * Count one failed fetch and set the next attempt's deadline.
   *
   * Logged only on the FIRST failure of a streak: the whole point is that a
   * dead gateway stops costing 120 requests an hour, and a line per attempt
   * would trade a request flood for a log flood. The message names the wait so
   * an operator reading the log knows the tick is still alive and backing off
   * rather than wedged.
   * @param {string} reason - why the attempt failed (already redacted upstream).
   */
  function recordFailure(reason: string) {
    failures += 1;
    const delay = retryDelayMs(failures);
    retryAt = Date.now() + delay;
    if (failures === 1) {
      logger?.warn?.(`catalog refresh failed (${reason}); backing off, next attempt in ${Math.round(delay / 1000)}s`);
    }
  }

  async function runNow(catalog: unknown, enabledIds: string[] | undefined, unavailableModelIds: string[]) {
    let offered: unknown = providerState.entries;
    let catalogChanged = false;
    if (Array.isArray(catalog)) {
      // The ids the signature is computed from, read INSIDE the chain because
      // they are the ones this write is about. A caller that has no curation to
      // assert (the tick, the snapshot route) passes `undefined`, which
      // `replace` reads as "keep the stored list" — so a background refresh can
      // never overwrite a save it did not make, and the read-modify-write stays
      // where the store already does it.
      const ids = enabledIds ?? await catalogStore.listEnabledIds().catch(() => providerState.enabledIds);
      const freshSignature = catalogSignature(catalog, ids);
      if (freshSignature !== providerState.signature) {
        catalogChanged = true;
        // `replace()` swallows a write failure (a read-only Home must not break
        // the panel). The signature's ONLY job is "equal → skip publish", so it
        // must describe what the disk holds: advancing it past a failed write
        // would make the next poll — serving the same catalog from cache — skip
        // the write that would fix it, and the disk would keep the old catalog
        // until a restart re-seeds it (PITFALLS §40). Not persisted → retry next
        // tick, which is the abnormal case anyway.
        const persisted = await catalogStore.replace(catalog, enabledIds);
        if (persisted) providerState.signature = freshSignature;
        await publisher.publish(catalog, ids, unavailableModelIds);
      }
      offered = catalog;
    }
    // The unavailable set can flip without the catalogue changing. When it does,
    // rebuild the registration so the picker drops/restores the affected models —
    // `PiAiAdapter` memoizes the profiles snapshot on Map identity, so only a
    // fresh registration can change the offered set (ROADMAP.md §3.3). Skip when
    // the catalogue branch already published this exact set a moment ago.
    const quotaSig = [...unavailableModelIds].sort().join(",");
    if (quotaSig !== providerState.quotaSignature) {
      providerState.quotaSignature = quotaSig;
      if (!catalogChanged) {
        await publisher.publish(providerState.entries, providerState.enabledIds, unavailableModelIds);
      }
    }
    return { offered, catalogChanged };
  }

  function run(catalog: unknown, enabledIds: string[] | undefined, unavailableModelIds: string[]) {
    const next = chain.then(() => runNow(catalog, enabledIds, unavailableModelIds));
    // Keep the chain alive after a rejection: one failed write must not poison
    // every later refresh (the same rule `publish-core`'s queue follows).
    chain = next.catch(() => undefined);
    return next;
  }

  async function refresh() {
    // The cheap exit FIRST: a fresh cache means there is nothing to fetch, so
    // no key resolution and no disk read happen on the ~119 ticks out of 120
    // that have nothing to do.
    const cached = cache.get(`${settings.apiBase}/models`);
    if (cached !== undefined && Date.now() - cached.at < CATALOG_CACHE_MS) {
      // Somebody else (the panel's own poll) refreshed it for us: the streak is
      // over. Silently — crediting the tick with a recovery it did not perform
      // would put a line in the log for work the panel did.
      if (failures > 0) {
        failures = 0;
        retryAt = 0;
      }
      return;
    }
    // A refused gateway is NOT retried at the tick rate: `sharedFetch` only
    // caches successes, so without this line the stale entry above would never
    // start answering and every tick would be a request. See `retryDelayMs`.
    if (retryAt !== 0 && Date.now() < retryAt) return;
    // No inference key → no catalogue. This is the fresh-install case, and it
    // must stay silent: the panel says "no key yet", and a background refresh
    // that logged here would repeat that every tick. The memo keeps the tick
    // from re-asking the credentials service every interval — the no-key shape
    // is exactly the one that can never populate the cache and therefore never
    // reaches the exit above.
    if (noKeyAt !== 0 && Date.now() - noKeyAt < NO_KEY_RETRY_MS) return;
    const apiKey = await apiKeyStore.resolve().then((resolved) => resolved.value).catch(() => "");
    if (apiKey === "") {
      noKeyAt = Date.now();
      return;
    }
    noKeyAt = 0;
    let failure = "";
    const catalog = await fetchCatalog(settings, CATALOG_CACHE_MS, cache, inflight, apiKey).catch((error: unknown) => {
      failure = error instanceof Error ? error.message : String(error);
      return null;
    });
    if (!Array.isArray(catalog)) {
      // A non-array answer is a failure too: the gateway said 200 and something
      // that is not a catalogue. Treating it as "no news" would retry it at the
      // tick rate exactly like a refusal.
      recordFailure(failure === "" ? "unexpected catalogue shape" : failure);
      return;
    }
    if (failures > 0) {
      logger?.warn?.(`catalog refresh recovered after ${failures} failed attempt(s)`);
      failures = 0;
      retryAt = 0;
    }
    // `undefined`, not a list read here: a background refresh has no curation of
    // its own to assert, and passing a list it read earlier is how a save that
    // landed in between gets overwritten by a stale copy.
    await run(catalog, undefined, []);
  }

  function start(intervalMs: number) {
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      void refresh().catch((error) => {
        // A background refresh must never take the Host down or spam the log:
        // one line per failed tick, and only when a logger is there.
        logger?.warn?.(`catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    };
    // No immediate `tick()`: see {@link CatalogEffects.start} — mount stays
    // network-free, and an open panel is what drives the first fetch.
    const timer = setInterval(tick, Math.max(MIN_TICK_MS, intervalMs));
    // An idle Host must still be able to exit: without this, a 30 s interval
    // keeps the event loop alive forever.
    (timer as { unref?: () => void }).unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  return { run, refresh, start };
}
