/**
 * The snapshot route's DATA AGGREGATION — the peer-free pure half.
 *
 * Keeps the router to only the HTTP surface (route registration, the trust
 * fence, body reading, the `writeJson` responses) while the polling-side
 * decisions — fetching through the cache, parsing the quota/usage/catalog
 * sources, computing shape warnings, identifying vision models, building the
 * `llm` status block — live here as one testable function.
 *
 * ## What Agnes actually reports
 *
 * The platform allocates quota by WINDOW, account-wide, on four dimensions
 * (`requests5h` / `requestsWeekly` / `imagesDaily` / `videoDaily`) — there is
 * no credit balance and no per-model split. Two consequences shape this file:
 *
 * 1. **No "remaining" is computed.** The console reports cumulative usage
 *    (`/api/usage/overview`) and per-bucket usage (`/api/usage/series`); a
 *    rolling 5-hour window cannot be derived from either. Printing
 *    `limit - total` would be a fabricated number, so the limits and the
 *    consumed totals are reported as two separate facts and the panel labels
 *    them as such.
 * 2. **Nothing is silently dropped from the picker.** Per-model exhaustion
 *    does not exist here, so `unavailableModelIds` is empty by design rather
 *    than by omission — see `rosterWithAvailability`.
 *
 * Every console source is fetched with the SAME failure policy: all five
 * degrade, and each degradation is reported through `quota.error` while the
 * sources that answered still render. The account's usage overview is not
 * exempt — it is the auth probe (`quota.consoleConnected` is its outcome), but
 * letting it reject the snapshot made the panel all-or-nothing: a console that
 * was never signed in blanked the API-key tab and the Raccoon tab too, and the
 * Raccoon tab does not read this snapshot at all. A partial screen beats a
 * full-page error, and an absent module must leave the rest usable
 * (ARCHITECTURE.md §5).
 *
 * Pure by design: it takes the resolved `settings`, the shared `cache` /
 * `inflight` maps, the `tokenStore`, the `apiKeyStore`, the `publisher` (from
 * `provider-publish.ts`) and the `catalogStore`, and returns the exact
 * snapshot body the route writes. No HTTP surface, no filesystem writes, no
 * module-level state — so `test/routes.test.mjs` can pin every branch (the
 * snapshot contract, the vision-vs-catalog distinction, the registration
 * re-publish) without mounting the full container.
 *
 * @module dsh-connect-agnes-token-plan/snapshot-aggregate
 */

import { fetchConsole, fetchModelCatalog, fetchPlans } from "./console-client.ts";
import {
  parseUsageOverview,
  parseUsageSeries,
  parsePlans,
  matchCurrentPlan,
  quotaWindows,
  readSubscriptionExpiry,
  checkShape,
  identifyVisionModel
} from "./parsers.ts";
import { summarizeCatalog, filterByEnabled, rosterWithAvailability, LLM_PROVIDER_ID, DEFAULT_REASONING_EFFORT } from "./llm-models.ts";
import { catalogSignature } from "./provider-publish.ts";
import { imageGenModelIds, pickDrawModel } from "./draw.ts";
import { pickVideoModel, videoGenModelIds, video25ModelIds } from "./video.ts";
import { str } from "./util.ts";

/** The authenticated console paths this poll reads. */
const USAGE_OVERVIEW_PATH = "/api/usage/overview";
const USAGE_SERIES_PATH = "/api/usage/series";
const SUBSCRIPTION_PATH = "/api/cn/user/subscription";

/**
 * The date window the usage series is asked for, as `YYYY-MM-DD` (UTC).
 *
 * The series endpoint takes DATES, not timestamps (`start_date` / `end_date`),
 * which is why the window is measured in days and not in the hours the
 * SenseNova trend used. Snapping to whole days also makes the URL stable for
 * the whole day, so the long series cache actually hits instead of
 * re-fetching the console on every poll.
 * @param {number} days - how many days back to ask for, inclusive of today.
 * @param {number} [nowMs] - the reference instant (injectable for tests).
 * @returns {{startDate: string, endDate: string}} the window bounds.
 */
export function usageWindow(days, nowMs = Date.now()) {
  const span = Math.max(1, Math.floor(days)) - 1;
  const format = (ms) => new Date(ms).toISOString().slice(0, 10);
  return { startDate: format(nowMs - span * 86_400_000), endDate: format(nowMs) };
}

/**
 * Run one console fetch, reporting its failure instead of throwing.
 *
 * Used for EVERY source, the account's usage overview included. It once
 * excepted the overview, on the theory that the auth probe should stay fatal
 * because the route's catch is what puts the sign-in form on screen — but that
 * made the whole panel all-or-nothing: one missing module (the console) took
 * down three tabs, including the Raccoon tab, which reaches a DIFFERENT
 * upstream with its own credential and never reads this snapshot at all. That
 * is the exact shape ARCHITECTURE.md §5 forbids: a module that is absent must
 * leave the panel usable, not blank it.
 *
 * So a failure becomes `{value: null, error}` everywhere. The panel renders the
 * sources that did arrive, names the one that did not, and keeps the tabs
 * reachable — and a signed-out Host still serves the API-key half (the model
 * catalogue and the provider/draw switches), which is the one combination that
 * made "I only want the models, not the quota" impossible.
 * @param {() => Promise<unknown>} run - the fetch to attempt.
 * @returns {Promise<{value: unknown, error: Error|null}>} the outcome.
 */
async function soft(run) {
  try {
    return { value: await run(), error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/**
 * The panel's projection of one catalogue entry: no `featureTexts`, no
 * envelope leftovers — only the fields the quota screen reads or compares.
 * @param {object} plan - one {@link parsePlans} entry.
 * @returns {object} the projection.
 */
export function planSummary(plan) {
  return {
    uuid: str(plan?.uuid, ""),
    planId: Number(plan?.planId) || 0,
    name: str(plan?.name, ""),
    displayName: str(plan?.displayName, ""),
    billingCycle: str(plan?.billingCycle, ""),
    displayCycle: str(plan?.displayCycle, ""),
    priceMinor: Number(plan?.priceMinor) || 0,
    currency: str(plan?.currency, ""),
    usageLimitText: str(plan?.usageLimitText, ""),
    limits: {
      requests5h: Number(plan?.concurrencyLimit) || 0,
      requestsWindowH: Number(plan?.concurrencyWindowH) || 0,
      requestsWeekly: Number(plan?.textWeeklyLimit) || 0,
      imagesDaily: Number(plan?.imageDailyLimit) || 0,
      videoDaily: Number(plan?.videoDailyLimit) || 0
    }
  };
}

/**
 * The first failure among the named sources, as a secret-free report.
 * @param {Array<[string, {error: Error|null}]>} sources - name/outcome pairs.
 * @returns {{source: string, code: string|null, message: string}|null} the report.
 */
function firstFailure(sources) {
  for (const [source, outcome] of sources) {
    if (outcome.error !== null) {
      return {
        source,
        code: typeof outcome.error.code === "string" ? outcome.error.code : null,
        message: outcome.error.message
      };
    }
  }
  return null;
}

/**
 * The operator's pseudo multiplier that names one model id, or undefined.
 *
 * Matching is a case-insensitive SUBSTRING of the model id, first configured
 * key wins (insertion order — `resolveTrendMultipliers` preserves it). It
 * rides on the panel's model roster as a `×N` badge: Agnes publishes no
 * per-model usage, so the badge is the operator's own comparison aid rather
 * than a figure the platform backs.
 *
 * @param {unknown} modelId - a model id (roster row id).
 * @param {Record<string, number>} multipliers - the sanitized config map.
 * @returns {number|undefined} the hit value, or undefined when nothing matched.
 */
export function matchMultiplier(modelId, multipliers) {
  const id = String(modelId ?? "").toLowerCase();
  for (const [key, value] of Object.entries(multipliers || {})) {
    if (id.includes(key.toLowerCase())) return value;
  }
  return undefined;
}

/**
 * Fetch the four console sources plus the model catalog and aggregate them
 * into the snapshot body the route writes.
 *
 * All five are fetched in parallel through the shared `cache` + `inflight`
 * maps (a single-flight per URL so concurrent polls share one call) and the
 * `tokenStore` (so a 401 triggers one renewal before the call). Only the
 * catalog is authenticated by the API key instead; a missing key degrades the
 * model lists, not the quota — resolved per poll so a key that arrives after
 * the plugin mounted still lights the lists on the next poll.
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
 * @param {() => Promise<boolean|null>} context.drawSwitch - the panel-saved
 *   draw-tool switch (`draw-store.enabled()`), same shape and precedence.
 * @param {() => Promise<string|null>} context.drawModelId - the panel-saved
 *   draw-model preference (`draw-store.modelId()`); null when untouched.
 * @param {() => Promise<boolean|null>} context.videoSwitch - the panel-saved
 *   video-tool switch (`video-store.enabled()`). A SEPARATE opt-in from the
 *   draw switch: the two modalities are independent.
 * @param {() => Promise<string|null>} context.videoModelId - the panel-saved
 *   video-model preference (`video-store.modelId()`); null when untouched.
 * @returns {Promise<object>} the snapshot body.
 */
export async function buildSnapshotBody({
  settings,
  cache,
  inflight,
  tokenStore,
  apiKeyStore,
  publisher,
  catalogStore,
  panelSwitch,
  drawSwitch,
  drawModelId,
  videoSwitch,
  videoModelId
}) {
  const providerState = publisher.state;
  const resolveApiKey = async () => (await apiKeyStore.resolve()).value;

  const now = Math.floor(Date.now() / 1000);
  const { startDate, endDate } = usageWindow(settings.usageDays);
  // THE AUTH PROBE — and, since the panel learned to degrade, one source among
  // five rather than the gate on all of them.
  //
  // It still runs FIRST and ALONE, for the reason it always did. It is the one
  // call that heals a dead token — the store renews on its 401, so by the time
  // the batch below goes out the token is live again — and it is the cheapest
  // way to learn that nobody is signed in, because that failure is a local
  // `not_configured` with no network round-trip and therefore costs the batch
  // nothing. Folding it into the `Promise.all` would present the same dead
  // token to three authenticated endpoints at once and buy back a single
  // round-trip on a path that is usually served from cache anyway;
  // `test/routes.test.mjs` group B pins that trade ("the dead token is
  // presented exactly once").
  //
  // What changed is only that it no longer THROWS. `soft` turns its failure
  // into `{value: null, error}`, so the batch runs regardless: a signed-out
  // Host still serves the public catalogue, the plan list and the API-key
  // half instead of rejecting the whole snapshot and blanking every tab.
  // `quota.consoleConnected` is this outcome, and `auth` says whether a login
  // would fix it.
  const overview = await soft(() => fetchConsole(
    settings,
    USAGE_OVERVIEW_PATH,
    undefined,
    settings.cacheSeconds * 1000,
    cache,
    inflight,
    tokenStore
  ));
  const [series, subscription, plans, catalog] = await Promise.all([
    // Everything below degrades. A signed-in account that simply has no plan,
    // or a console whose series endpoint is having a bad day, must still show
    // the numbers that DID arrive rather than a full-screen error.
    soft(() => fetchConsole(
      settings,
      USAGE_SERIES_PATH,
      { range: "custom", start_date: startDate, end_date: endDate },
      // Longer cache than the overview: the window is day-snapped, so the URL
      // is stable for the whole day and there is nothing to gain from
      // re-reading it every poll.
      Math.max(settings.cacheSeconds, 300) * 1000,
      cache,
      inflight,
      tokenStore
    )),
    soft(() => fetchConsole(settings, SUBSCRIPTION_PATH, undefined, settings.cacheSeconds * 1000, cache, inflight, tokenStore)),
    // The catalogue is PUBLIC — an anonymous request answers it — so it is the
    // one quota source that survives everything except the platform being
    // unreachable, and it is what lets the panel answer "is upgrading worth
    // it" with the platform's own numbers.
    soft(() => fetchPlans(settings, 3600_000, cache, inflight)),
    // Optional: a missing API key degrades the model lists, not the quota.
    (async () => {
      const apiKey = await resolveApiKey();
      return apiKey === "" ? null : fetchModelCatalog(settings, 3600_000, cache, inflight, apiKey).catch(() => null);
    })()
  ]);

  // --- the quota block -----------------------------------------------------
  const catalogue = parsePlans(plans.value);
  const currentPlan = matchCurrentPlan(subscription.value, catalogue);
  const quota = {
    plan: currentPlan === null ? null : planSummary(currentPlan),
    // The four windows the plan caps. Empty when the payload did not name a
    // plan this plugin recognises — an empty list is honest, a guessed plan is
    // not, and the panel says "unknown" rather than showing the entry tier.
    windows: quotaWindows(currentPlan),
    // Cumulative usage. Deliberately NOT subtracted from the limits above: the
    // two are measured over different periods, so a difference would be a
    // number nobody can defend.
    //
    // `null` when the overview did not arrive — and NOT a zeroed block. Every
    // counter in `parseUsageOverview` defaults through `countOf`, so handing it
    // the `{}` that `obj(null)` returns would print "0 requests / 0 tokens" for
    // an account whose usage nobody managed to read: the failure would come out
    // as a measurement. The panel already renders `null` as "not read yet"
    // (`quota.usageMissing`), which is why the wire contract declares this
    // nullable.
    totals: overview.value === null ? null : parseUsageOverview(overview.value),
    plans: catalogue.map(planSummary),
    expiresAt: readSubscriptionExpiry(subscription.value),
    // Whether the console half answered at all. `false` means every
    // authenticated source is missing and what follows is the PUBLIC catalogue
    // plus whatever degraded source happened to answer — the panel says so
    // rather than letting the absence read as "you have used nothing".
    consoleConnected: overview.value !== null,
    // Why a source is missing, when one is. `overview` leads the list now that
    // it degrades: its code (`not_configured` on a fresh install, `auth_error`
    // on a dead token, `console_error` when the platform is down) is what tells
    // the panel whether a login would fix this or patience would.
    error: firstFailure([
      ["usage-overview", overview],
      ["series", series],
      ["subscription", subscription],
      ["plans", plans]
    ])
  };
  const usage = series.value === null
    ? null
    : (() => {
        const parsed = parseUsageSeries(series.value, settings.usageDays);
        return { days: parsed.days, windowTotals: parsed.totals, buckets: parsed.buckets };
      })();

  // A shape drift does not fail the poll — the parsers still return what they
  // understood — but it must reach the panel, or a renamed field would read
  // as "no usage" forever. A source that failed outright is reported through
  // `quota.error` instead, so it is skipped here: reporting both would blame
  // the shape for a network error.
  const shapeWarnings = [
    // Same rule as the series below: a source that failed outright is reported
    // through `quota.error`, so checking the shape of a null body would blame a
    // renamed field for a network error.
    ...(overview.value === null
      ? []
      : checkShape(overview.value, "usage-overview").missing.map((key) => ({ api: "usage-overview", missing: key }))),
    ...(series.value === null
      ? []
      : checkShape(series.value, "usage-series").missing.map((key) => ({ api: "usage-series", missing: key }))),
    // `checkShape` describes objects; the catalogue's `data` is an array, so
    // its drift is checked here.
    ...(plans.value !== null && !Array.isArray(plans.value) ? [{ api: "plans", missing: "array" }] : [])
  ];

  // --- the catalog half ----------------------------------------------------
  const catalogIds = Array.isArray(catalog) ? catalog.map((entry) => entry.id) : [];
  // Agnes blocks nothing per model: quota is account-wide and its consumed side
  // is not readable as a balance, so the picker keeps every callable model and
  // the panel explains account-level exhaustion itself. The mechanism stays
  // wired (the publisher takes the list, the flip detector below watches it)
  // because a second provider absorbed into this plugin may well have a real
  // per-model signal.
  const unavailableModelIds = [];
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
  // The draw-model preference with the same precedence the tool resolves at
  // mount: panel-saved beats the patch default; "" = auto-pick. Resolved once
  // here so the llm block's three draw fields cannot disagree.
  const effectiveDrawModelId = (await drawModelId?.().catch(() => null)) ?? str(settings.drawModelId, "");
  // Same precedence for video, resolved once so the llm block's video fields
  // cannot disagree with each other or with what the tool dispatches.
  const effectiveVideoModelId = (await videoModelId?.().catch(() => null)) ?? str(settings.videoModelId, "");
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
    // What DSH's 思考强度 "Default" actually means on this provider. The
    // adapter profile pins this constant, the panel quotes it — same source,
    // so the two cannot drift.
    thinkingDefault: DEFAULT_REASONING_EFFORT,
    // The panel roster: every chat model this catalogue can offer, each tagged
    // with whether it is currently callable, plus the curated allow-list. An
    // empty allow-list means "no filter". Every row also carries the operator's
    // pseudo `×N` under the SAME matcher the config keys use — an unmatched
    // model simply gets no badge (never a guessed 1).
    models: rosterWithAvailability(offered, unavailableModelIds).map((row) => {
      const multiplier = matchMultiplier(row.id, settings.trendMultipliers);
      return multiplier === undefined ? row : { ...row, multiplier };
    }),
    enabledModelIds: enabledIds,
    quotaBlockedModelIds: unavailableModelIds,
    drawEnabled: (await drawSwitch?.().catch(() => null) ?? settings.drawEnabled) === true,
    drawSource: await drawSwitch?.().catch(() => null) === null ? "config" : "panel",
    // A draw call's actual target model, picked by the same precedence the
    // tool itself uses (`pickDrawModel`) over the same normalized catalog —
    // so the panel's line and the tool's behavior cannot disagree. Emitted
    // whenever the catalog is present: an AUTO pick (no configured id) still
    // addresses the catalog's first image model, so `drawModel` / the
    // candidate set are facts about the deployment, not about the operator's
    // preference. Only `drawPreferredModel` (the operator's pinned choice) is
    // preference-shaped and absent when auto. The whole block disappears when
    // there is no catalog at all (no key, or the poll has never fetched one).
    ...(Array.isArray(catalog)
      ? (() => {
          const candidates = imageGenModelIds(catalog);
          return {
            drawModel: pickDrawModel(catalog, "", effectiveDrawModelId) ?? undefined,
            drawCandidateCount: candidates.length,
            drawCandidateIds: candidates,
            // Presence of a preference (panel or config) is what the panel
            // renders as "pinned"; its absence is "auto-picked".
            ...(effectiveDrawModelId !== "" ? { drawPreferredModel: effectiveDrawModelId } : {})
          };
        })()
      : {}),
    videoEnabled: (await videoSwitch?.().catch(() => null) ?? settings.videoEnabled) === true,
    videoSource: await videoSwitch?.().catch(() => null) === null ? "config" : "panel",
    // Same shape as the draw block above, with ONE extra fact the panel has to
    // be able to explain: the catalog may list a 2.5 family that speaks a
    // MUTUALLY EXCLUSIVE parameter system (`mode`/`seconds`/`size`/
    // `aspect_ratio` vs V2.0's `width`/`num_frames`/`frame_rate`). The tool
    // now drives BOTH — `videoCandidateIds` holds every video model (both
    // families, so the panel's picker offers them all) and `video25ModelIds`
    // carries the 2.5 subset, which the card names as the seconds/size/aspect
    // family the tool adapts to automatically. A silent drop would make the
    // panel look like it had lost models.
    ...(Array.isArray(catalog)
      ? (() => {
          const candidates = videoGenModelIds(catalog);
          return {
            videoModel: pickVideoModel(catalog, "", effectiveVideoModelId) ?? undefined,
            videoCandidateCount: candidates.length,
            videoCandidateIds: candidates,
            video25ModelIds: video25ModelIds(catalog),
            ...(effectiveVideoModelId !== "" ? { videoPreferredModel: effectiveVideoModelId } : {})
          };
        })()
      : {}),
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
    // Step three status: key presence/source, opt-in, registration state, and
    // model/vision counts — never the key itself.
    llm: llmStatus,
    quota,
    usage,
    shapeWarnings
  };
}
