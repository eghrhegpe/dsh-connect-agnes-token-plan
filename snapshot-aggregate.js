// @ts-check
/**
 * The snapshot route's DATA AGGREGATION — the peer-free pure half.
 *
 * Extracted from `index.js` so the router keeps only the HTTP surface (route
 * registration, the trust fence, body reading, the `writeJson` responses)
 * while the polling-side decisions — fetching through the cache, parsing
 * pools/trend/catalog, computing shape warnings, splitting a pool's coverage
 * into callable vs locked models, marking quota-exhausted models, identifying
 * vision models, building the `llm` status block — live here as one testable
 * function.
 *
 * Pure by design: it takes the resolved `settings`, the shared `cache` /
 * `inflight` maps, the `tokenStore`, the `apiKeyStore`, the `publisher`
 * (from `provider-publish.js`) and the `catalogStore`, and returns the exact
 * snapshot body the route writes. No HTTP surface, no filesystem writes, no
 * module-level state — so `test/routes.test.mjs` can pin every branch (the
 * 14-key snapshot contract, the vision-vs-catalog distinction, the
 * quota-flip re-registration) without mounting the full container.
 *
 * @module dsh-connect-sensenova-token-plan/snapshot-aggregate
 */

import { fetchConsole, fetchModelCatalog } from "./console-client.js";
import { parsePools, parseTrend, checkShape, identifyVisionModel } from "./parsers.js";
import { summarizeCatalog, filterByEnabled, rosterWithAvailability, exhaustedModelIds, LLM_PROVIDER_ID } from "./llm-models.js";
import { catalogSignature } from "./provider-publish.js";

/**
 * Fetch the three console sources in parallel and aggregate them into the
 * snapshot body the route writes.
 *
 * The console sources are fetched through the shared `cache` + `inflight`
 * maps (a single-flight per URL so concurrent polls share one call) and the
 * `tokenStore` (so a 401 triggers one renewal before the call). The model
 * catalog is optional: a missing API key degrades the model lists, not the
 * quota — resolved per poll so a key that arrives after the plugin mounted
 * still lights the lists on the next poll.
 *
 * @param {object} context
 * @param {object} context.settings - the resolved settings row.
 * @param {Map} context.cache - the console-response cache (shared across polls).
 * @param {Map} context.inflight - the single-flight map (shared across polls).
 * @param {object} context.tokenStore - the `createTokenStore` instance.
 * @param {object} context.apiKeyStore - the `createApiKeyStore` instance.
 * @param {object} context.publisher - the `createProviderPublisher` instance.
 * @param {object} context.catalogStore - the `createFileCatalogStore` instance.
 * @param {() => Promise<boolean|null>} context.panelSwitch - the panel-saved
 *   provider switch (`provider-store.enabled()`); null when untouched.
 * @returns {Promise<object>} the snapshot body (`{ ok, now, ..., pools, trend, ... }`).
 */
export async function buildSnapshotBody({
  settings,
  cache,
  inflight,
  tokenStore,
  apiKeyStore,
  publisher,
  catalogStore,
  panelSwitch
}) {
  const providerState = publisher.state;
  const resolveApiKey = async () => (await apiKeyStore.resolve()).value;

  const now = Math.floor(Date.now() / 1000);
  // Snap the window to the granularity boundary so that two polls inside the
  // same hour/day bucket build an identical URL and the long-lived trend
  // cache (5 min) actually hits, instead of re-fetching the console on every
  // poll. The window length is unchanged — only shifted to align with the
  // bucket edges; the console returns bucket-aggregated series anyway, so the
  // panel shows complete buckets rather than a partial one.
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
    // Optional: a missing API key degrades the model lists, not the quota.
    (async () => {
      const apiKey = await resolveApiKey();
      return apiKey === "" ? null : fetchModelCatalog(settings, 3600_000, cache, inflight, apiKey).catch(() => null);
    })()
  ]);
  const pools = parsePools(poolBody);
  const trend = parseTrend(trendBody, settings.trendHours);
  // A shape drift does not fail the poll — the parsers still return what they
  // understood — but it must reach the panel, or a renamed field would read
  // as "no usage" forever.
  const shapeWarnings = [
    ...checkShape(poolBody, "pool-usage").missing.map((key) => ({ api: "pool-usage", missing: key })),
    ...checkShape(trendBody, "credit-usage-trend").missing.map((key) => ({ api: "credit-usage-trend", missing: key }))
  ];
  // Split each pool's advertised coverage into what this key can call and
  // what the plan lists but the key has no permission for yet.
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
  // Models whose quota pool is exhausted would answer every chat request with
  // `429 quota_exceeded`. The picker must not offer them (the adapter drops
  // them via `unavailableModelIds`), and the panel greys them (via
  // `rosterWithAvailability`). The set also drives a re-registration when it
  // flips between catalogue polls.
  const unavailableModelIds = exhaustedModelIds(pools);
  // Which of the callable models can take image input — step one of the
  // vision plan (ARCHITECTURE.md §5.1): the info, not the execution.
  // Absent API key → no catalog → the list is simply undeclared, not "none".
  const visionModels = Array.isArray(catalog)
    ? catalog
        .map((entry) => identifyVisionModel(entry))
        .filter((entry) => entry.vision)
    : undefined;

  // Step three: persist the fetched catalog to the PRIVATE state file and
  // rebuild the registered provider, but ONLY when the offered set actually
  // changed — the catalog fetch is cached for an hour while the panel polls
  // every 30 s, so a write/re-register per poll would be pure churn. The
  // reported model counts come from the fresh catalog when one arrived, else
  // from whatever the mount seed had stored.
  const keyState = await apiKeyStore.state().catch(() => ({ hasApiKey: false, keySource: null, ephemeral: false }));
  // The effective switch: a panel-saved value beats the patch default. Both
  // are reported so the panel can say which side is in charge.
  const effectivePanelSwitch = await panelSwitch().catch(() => null);
  // The curated allow-list is read on every poll, not only when a fresh
  // catalogue arrived: a /models save must reach the picker even on a poll
  // that serves a cached catalogue.
  const enabledIds = await catalogStore.listEnabledIds().catch(() => providerState.enabledIds);
  let offered = providerState.entries;
  let catalogChanged = false;
  if (Array.isArray(catalog)) {
    const freshSignature = catalogSignature(catalog, enabledIds);
    if (freshSignature !== providerState.signature) {
      catalogChanged = true;
      providerState.signature = freshSignature;
      await catalogStore.replace(catalog, enabledIds).catch(() => {});
      await publisher.publish(catalog, enabledIds, unavailableModelIds);
    }
    offered = catalog;
  }
  // Quota state can flip (a pool hits zero, or its window resets) without the
  // catalogue changing. When it does, rebuild the registration so the picker
  // drops/restores the affected models — `PiAiAdapter` memoizes the profiles
  // snapshot on Map identity, so only a fresh registration can change the
  // offered set (ROADMAP.md §3.3). Skip when the catalogue branch already
  // published this exact set a moment ago.
  const quotaSig = [...unavailableModelIds].sort().join(",");
  if (quotaSig !== providerState.quotaSignature) {
    providerState.quotaSignature = quotaSig;
    if (!catalogChanged) {
      await publisher.publish(providerState.entries, providerState.enabledIds, unavailableModelIds);
    }
  }
  // The counts describe the OFFER, not the catalogue: the adapter is built
  // from the allow-list-filtered entries, so a panel line that quoted the raw
  // count would claim to have registered models that were ticked off.
  const summary = summarizeCatalog(filterByEnabled(offered, enabledIds));
  // Secret-free by construction: the store reports booleans/source only, never
  // the key value.
  const llmStatus = {
    ...keyState,
    registerProvider: (effectivePanelSwitch ?? settings.registerProvider) === true,
    registerSource: effectivePanelSwitch === null ? "config" : "panel",
    llmAvailable: providerState.llmAvailable,
    providerRegistered: providerState.registered,
    providerId: LLM_PROVIDER_ID,
    modelCount: summary.modelCount,
    visionCount: summary.visionCount,
    // The panel roster: every chat model this catalogue can offer, each tagged
    // with whether its quota pool is currently exhausted, plus the curated
    // allow-list. An empty allow-list means "no filter".
    models: rosterWithAvailability(offered, pools),
    enabledModelIds: enabledIds,
    quotaBlockedModelIds: unavailableModelIds,
    ...(providerState.error !== null ? { providerError: providerState.error } : {})
  };

  return {
    ok: true,
    now: Date.now(),
    consoleBase: settings.consoleBase,
    // The panel polls on the Host's cadence and quotes the Host's cache age,
    // so neither number is written down twice.
    cacheSeconds: settings.cacheSeconds,
    pollSeconds: settings.pollSeconds,
    // Token state, with no secret in it: the panel uses this to say whether
    // the token renews itself or is waiting on an account.
    auth: await tokenStore.state(),
    catalogAvailable: Array.isArray(catalog),
    catalogModels: catalogIds,
    // `undefined` (no API key) vs `[]` (key present, no vision models) — the
    // panel must not say "no vision models" when it simply never asked.
    ...(visionModels !== undefined ? { visionModels } : {}),
    uncountedModels: Array.isArray(catalog)
      ? catalogIds.filter((model) => !pools.pools.some((pool) => pool.modelIds.includes(model)))
      : [],
    // Step three status: key presence/source, opt-in, registration state, and
    // model/vision counts — never the key itself.
    llm: llmStatus,
    pools,
    trend,
    shapeWarnings
  };
}
