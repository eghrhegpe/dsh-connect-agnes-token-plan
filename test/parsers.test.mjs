/**
 * Unit checks for the console parsers — the layer that turns an Agnes response
 * into the panel's rows, and the one PITFALLS §12 says must never read a renamed
 * field as "no usage".
 *
 * Until now these were only touched indirectly: the route stubs served them a
 * single happy-path body, so the drift branch (the whole reason `EXPECTED_SHAPES`
 * exists), the string-number coercion (§11), and the "buckets sum ACROSS, never
 * within" semantics each had no direct assertion. A regression in any of them
 * stayed green as long as one well-shaped body still parsed. This file exercises
 * them directly, with no network at all — they are pure functions over an object.
 *
 * Two contract facts are load-bearing and pinned below:
 *   1. Every function here takes the payload AFTER `console-client.ts` unwrapped
 *      the `{code, message, data}` envelope. `parsePlans` is the exception: its
 *      `data` IS the array.
 *   2. Nothing is ever SUBTRACTED. The console reports cumulative totals and
 *      plan limits over different periods, so a "remaining" figure would be a
 *      number nobody can defend. No parser here computes one.
 */
import {
  countOf,
  timestampSeconds,
  checkShape,
  parseUsageOverview,
  parseUsageSeries,
  parsePlans,
  matchCurrentPlan,
  readSubscriptionExpiry,
  quotaWindows,
  identifyVisionModel,
  EXPECTED_SHAPES
} from "../src/host/parsers.ts";
// Imported here (not a new file) because the multiplier matcher sits on top of
// the parsed roster rows: same layer of the pipeline, same suite.
import { matchMultiplier, usageWindow, planSummary } from "../src/host/snapshot-aggregate.ts";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail }); }
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) }); }

// --- 1. countOf(): the console mixes numbers and numeric STRINGS (§11) -----
{
  check("a numeric string becomes a number", countOf("60000") === 60000, String(countOf("60000")));
  check("a real number passes through", countOf(42.5) === 42.5);
  check("a decimal string keeps precision", countOf("1234.56") === 1234.56, String(countOf("1234.56")));
  // NaN is what a raw `Number(undefined)` produces; the parser must not leak it
  // onto the screen as "NaN".
  check("undefined reads as zero, not NaN", countOf(undefined) === 0);
  check("null reads as zero", countOf(null) === 0);
  check("an empty string reads as zero", countOf("") === 0);
  check("a non-numeric string reads as zero", countOf("abc") === 0);
  check("Infinity reads as zero (not finite)", countOf(Infinity) === 0);
}

// --- 2. timestampSeconds(): four input shapes, and the 1970 trap -----------
// The platform has been seen to send epochs as second-precision strings, and
// the field names differ per route, so the reader accepts epoch seconds, epoch
// MILLIS, a decimal string of either, or an ISO-8601 date. Absent or unusable
// must be `null`, NOT 0 — reading "no expiry" as epoch 0 would render a date
// in 1970.
{
  check("a decimal-string epoch becomes a number", timestampSeconds("1800000000") === 1800000000, String(timestampSeconds("1800000000")));
  check("a real number epoch passes through", timestampSeconds(1800000000) === 1800000000);
  check("fractional seconds are floored", timestampSeconds("1800000000.9") === 1800000000, String(timestampSeconds("1800000000.9")));
  // The millis guess is safe because the ranges do not overlap: a seconds stamp
  // above 1e12 would be the year 33658.
  check("an epoch in milliseconds is divided down",
    timestampSeconds(1_800_000_000_000) === 1800000000, String(timestampSeconds(1_800_000_000_000)));
  check("a millisecond string is divided down too",
    timestampSeconds("1800000000000") === 1800000000, String(timestampSeconds("1800000000000")));
  // ISO-8601, and the timezone must actually be honored — two spellings of the
  // same instant have to land on the same number.
  check("an ISO date parses",
    timestampSeconds("2026-10-01T00:00:00Z") === timestampSeconds("2026-10-01T08:00:00+08:00"),
    `${timestampSeconds("2026-10-01T00:00:00Z")} vs ${timestampSeconds("2026-10-01T08:00:00+08:00")}`);
  check("an ISO date is a plausible epoch", timestampSeconds("2026-10-01T00:00:00Z") > 1_700_000_000, String(timestampSeconds("2026-10-01T00:00:00Z")));

  check("undefined is null (absent)", timestampSeconds(undefined) === null);
  check("null is null", timestampSeconds(null) === null);
  check('empty string is null', timestampSeconds("") === null);
  // The specific trap: the platform's own sentinel for "never expires" is "0".
  check('"0" is null, not the year 1970', timestampSeconds("0") === null, String(timestampSeconds("0")));
  check("numeric 0 is null", timestampSeconds(0) === null);
  check("a negative epoch is null", timestampSeconds(-5) === null);
  check("a non-numeric string is null", timestampSeconds("soon") === null);
}

// --- 3. checkShape(): the drift detector behind shapeWarnings -------------
// Forgiving parsers turn a platform rename into a serene empty screen; this is
// the one place that notices. Both directions matter: a missing key flags, a
// present key does not, and an unknown kind flags nothing (it has no contract).
{
  const overviewKeys = EXPECTED_SHAPES["usage-overview"];
  check("usage-overview expects total_requests and total_tokens",
    overviewKeys.includes("total_requests") && overviewKeys.includes("total_tokens"), JSON.stringify(overviewKeys));
  check("a complete overview body has no drift",
    checkShape({ total_requests: 1, total_tokens: 2 }, "usage-overview").ok === true);
  const missingTokens = checkShape({ total_requests: 1 }, "usage-overview");
  check("a dropped `total_tokens` key is reported",
    missingTokens.ok === false && missingTokens.missing.includes("total_tokens"), JSON.stringify(missingTokens));
  const renamed = checkShape({ totalRequests: 1, totalTokens: 2 }, "usage-overview");
  check("a renamed key is reported as missing (camelCase is not accepted)",
    renamed.missing.length === 2, JSON.stringify(renamed));

  check("usage-series expects `items`", EXPECTED_SHAPES["usage-series"].includes("items"));
  check("a series body without items drifts",
    checkShape({}, "usage-series").missing.includes("items"));
  // `subscription` deliberately expects NOTHING: no session token was available
  // to observe that payload, so inventing an expectation would report drift on
  // every poll. Pin the empty list so nobody "helpfully" fills it in.
  check("subscription declares no expectations (unobserved contract)",
    EXPECTED_SHAPES.subscription.length === 0, JSON.stringify(EXPECTED_SHAPES.subscription));
  check("any subscription body passes the shape check",
    checkShape({ anything: 1 }, "subscription").ok === true);

  // A null/array body must not throw — obj() folds it to {}.
  check("a null body reports every expected key missing",
    checkShape(null, "usage-overview").missing.length === overviewKeys.length);
  check("an array body is not a plain object, so keys are missing",
    checkShape([], "usage-overview").ok === false);
  check("an unknown kind flags nothing", checkShape({}, "does-not-exist").ok === true);
}

// --- 4. parseUsageOverview(): cumulative totals, and NO subtraction --------
{
  try {
    const out = parseUsageOverview({
      total_requests: "1200",
      total_tokens: 340000,
      total_images: "40",
      total_video_seconds: 610.5,
      active_days: 12
    });
    check("request/token totals coerce", out.totalRequests === 1200 && out.totalTokens === 340000,
      `${out.totalRequests}/${out.totalTokens}`);
    check("image and video totals are carried", out.totalImages === 40 && out.totalVideoSeconds === 610.5,
      `${out.totalImages}/${out.totalVideoSeconds}`);
    check("active days is carried", out.activeDays === 12, String(out.activeDays));
    // The load-bearing negative: the parser must not invent a `remaining`-like
    // field. If one ever appears here it means someone started subtracting.
    check("no derived remaining field is produced",
      !("remaining" in out) && !("used" in out), JSON.stringify(Object.keys(out)));
  } catch (error) {
    fail("parseUsageOverview normalizes a full body", error);
  }

  // A sparse body reads as zeros, never undefined/NaN.
  try {
    const sparse = parseUsageOverview({ total_requests: 5 });
    check("a missing total reads as zero, not undefined",
      sparse.totalTokens === 0 && sparse.totalImages === 0 && sparse.activeDays === 0,
      JSON.stringify(sparse));
    check("a malformed body still returns every key",
      Object.keys(parseUsageOverview(null)).sort().join(",") ===
        "activeDays,totalImages,totalRequests,totalTokens,totalVideoSeconds",
      Object.keys(parseUsageOverview(null)).join(","));
  } catch (error) {
    fail("parseUsageOverview tolerates a sparse body", error);
  }
}

// --- 5. parseUsageSeries(): each item IS a bucket; totals sum ACROSS ------
// Unlike the SenseNova trend — where several points made up one model's row —
// nothing is summed per row here. The window total sums across buckets, because
// that is a fact the platform does not state for the window.
{
  const body = {
    items: [
      { bucket: "2026-09-30", request_count: "10", text_tokens: 100, image_count: 1, video_seconds: 0 },
      { bucket: "2026-09-28", request_count: 20, text_tokens: "200", image_count: 0, video_seconds: 30.5 },
      { bucket: "2026-09-29", request_count: 30, text_tokens: 300, image_count: 2, video_seconds: 1 }
    ]
  };
  try {
    const out = parseUsageSeries(body, 30);
    check("days echoes the requested window", out.days === 30, String(out.days));
    check("one row per bucket", out.buckets.length === 3, String(out.buckets.length));
    // Chronological, so the panel's bars read left-to-right in time order
    // regardless of the order the platform listed them in.
    check("buckets are sorted chronologically",
      out.buckets.map((b) => b.bucket).join(",") === "2026-09-28,2026-09-29,2026-09-30",
      out.buckets.map((b) => b.bucket).join(","));
    check("a bucket's own fields coerce strings to numbers",
      out.buckets[2].requestCount === 10 && out.buckets[2].textTokens === 100, JSON.stringify(out.buckets[2]));
    // The totals use the SAME key names as parseUsageOverview, so the panel has
    // one shape to render whether it shows the window or the account.
    check("the window total sums ACROSS buckets",
      out.totals.totalRequests === 60 && out.totals.totalTokens === 600,
      JSON.stringify(out.totals));
    check("image and video totals sum too",
      out.totals.totalImages === 3 && out.totals.totalVideoSeconds === 31.5,
      JSON.stringify(out.totals));
    check("the total keys match the overview's key names",
      Object.keys(out.totals).sort().join(",") === "totalImages,totalRequests,totalTokens,totalVideoSeconds",
      Object.keys(out.totals).join(","));
  } catch (error) {
    fail("parseUsageSeries sums buckets", error);
  }

  // An entry with no `bucket` label is not a usable point in time: drop it
  // rather than plot it under "".
  try {
    const out = parseUsageSeries({ items: [{ request_count: 9 }, { bucket: "2026-09-29", request_count: 1 }] }, 7);
    check("an entry without a bucket label is dropped", out.buckets.length === 1, JSON.stringify(out.buckets));
    check("the dropped entry does not reach the totals", out.totals.totalRequests === 1, String(out.totals.totalRequests));
  } catch (error) {
    fail("parseUsageSeries drops unlabeled buckets", error);
  }

  // Malformed: a missing/non-array items yields an empty list, not a throw.
  try {
    check("a missing items reads as no rows", parseUsageSeries({}, 30).buckets.length === 0);
    check("a non-array items reads as no rows", parseUsageSeries({ items: null }, 30).buckets.length === 0);
    check("an empty series sums to zero",
      parseUsageSeries({ items: [] }, 30).totals.totalRequests === 0);
    check("a null body still returns a shape",
      parseUsageSeries(null, 30).days === 30 && Array.isArray(parseUsageSeries(null, 30).buckets));
  } catch (error) {
    fail("parseUsageSeries survives malformed input", error);
  }
}

// --- 5b. parsePlans(): the catalogue, whose `data` is an ARRAY ------------
// Verified live 2026-10-01 against an anonymous request: six entries — 入门版 /
// 专业版 / 高级版, each in a monthly and a yearly variant. The field names below
// are exactly the platform's; the daily image and video caps are identical
// across all three tiers, which is why only the request dimensions differentiate.
{
  const entry = {
    uuid: "11111111-2222-3333-4444-555555555555",
    id: 3,
    name: "高级版",
    display_name: "高级版",
    billing_cycle: "monthly",
    display_cycle: "月付",
    price_minor: 9900,
    currency: "CNY",
    concurrency_limit: 30000,
    concurrency_window_h: 5,
    text_weekly_limit: "300000",
    image_daily_limit: 4000,
    video_daily_limit: 500,
    usage_limit_text: "30000 次模型请求 / 5 小时",
    feature_texts: ["全部模型", 42, null, "优先支持"]
  };
  try {
    const [plan] = parsePlans([entry]);
    check("uuid and plan id are carried", plan.uuid === entry.uuid && plan.planId === 3, JSON.stringify(plan));
    check("name and display name are carried", plan.name === "高级版" && plan.displayName === "高级版");
    check("the billing cycle and its label are carried",
      plan.billingCycle === "monthly" && plan.displayCycle === "月付");
    check("price and currency are carried", plan.priceMinor === 9900 && plan.currency === "CNY");
    check("the four limits coerce strings to numbers",
      plan.concurrencyLimit === 30000 && plan.textWeeklyLimit === 300000 &&
        plan.imageDailyLimit === 4000 && plan.videoDailyLimit === 500,
      JSON.stringify(plan));
    check("the 5-hour window comes off the payload",
      plan.concurrencyWindowH === 5, String(plan.concurrencyWindowH));
    check("the platform's own limit sentence is kept verbatim",
      plan.usageLimitText === "30000 次模型请求 / 5 小时", plan.usageLimitText);
    // feature_texts is the ONLY place the daily caps are explained in the UI,
    // so non-strings must be filtered rather than rendered as "[object Object]".
    check("non-string feature texts are dropped",
      plan.featureTexts.join("|") === "全部模型|优先支持", plan.featureTexts.join("|"));
  } catch (error) {
    fail("parsePlans normalizes a catalogue entry", error);
  }

  try {
    // The array check is the important one: `checkShape` cannot describe an
    // array, so a non-array body must fold to [] instead of throwing.
    check("a non-array body yields an empty catalogue", parsePlans({ data: [] }).length === 0);
    check("null yields an empty catalogue", parsePlans(null).length === 0);
    check("an absent body yields an empty catalogue", parsePlans(undefined).length === 0);
    const sparse = parsePlans([{ id: 1 }]);
    check("a sparse entry defaults every string to empty",
      sparse[0].uuid === "" && sparse[0].name === "" && sparse[0].currency === "", JSON.stringify(sparse[0]));
    check("a sparse entry's display name falls back to the name",
      parsePlans([{ name: "入门版" }])[0].displayName === "入门版", parsePlans([{ name: "入门版" }])[0].displayName);
    check("a sparse entry's limits read as zero",
      sparse[0].concurrencyLimit === 0 && sparse[0].imageDailyLimit === 0);
  } catch (error) {
    fail("parsePlans survives malformed input", error);
  }
}

// --- 5c. matchCurrentPlan(): which catalogue entry the account is on ------
// Two signals, strongest first: a UUID matched anywhere (nothing else on the
// platform looks like a 36-char uuid), then a NAME matched ONLY against the
// values held under the identity keys. A numeric plan id is deliberately NOT a
// signal — the ids are 1–6 and a subscription object is full of small integers.
{
  const monthly = parsePlans([
    { uuid: "aaaa1111-0000-0000-0000-000000000001", id: 1, name: "入门版", display_name: "入门版", billing_cycle: "monthly" },
    { uuid: "aaaa1111-0000-0000-0000-000000000002", id: 2, name: "入门版", display_name: "入门版", billing_cycle: "yearly" },
    { uuid: "aaaa1111-0000-0000-0000-000000000003", id: 3, name: "高级版", display_name: "高级版", billing_cycle: "monthly" }
  ]);

  try {
    // 1. UUID wins, and it may sit anywhere in the payload.
    const byUuid = matchCurrentPlan({ nested: { deep: { plan_uuid: monthly[2].uuid } } }, monthly);
    check("a uuid anywhere in the payload matches", byUuid?.name === "高级版", JSON.stringify(byUuid));
    const uuidBeatsName = matchCurrentPlan({ plan_name: "入门版", uuid: monthly[2].uuid }, monthly);
    check("a uuid outranks a name", uuidBeatsName?.name === "高级版", JSON.stringify(uuidBeatsName));

    // 2. A name under an identity key matches.
    const byName = matchCurrentPlan({ plan_name: "高级版" }, monthly);
    check("a name under an identity key matches", byName?.name === "高级版", JSON.stringify(byName));

    // 3. The trap: a numeric id must NOT match. `{id: 1}` is on almost every
    //    account, so honouring it would report the entry tier to everyone.
    check("a bare numeric id is not a signal", matchCurrentPlan({ id: 1 }, monthly) === null,
      JSON.stringify(matchCurrentPlan({ id: 1 }, monthly)));
    check("a small integer under another key is not a signal either",
      matchCurrentPlan({ planId: 3 }, monthly) === null, JSON.stringify(matchCurrentPlan({ planId: 3 }, monthly)));

    // 4. The user's own name is not a plan name — the whole reason the name
    //    signal reads a fixed key list instead of scanning the payload.
    check("an unrelated user name matches nothing",
      matchCurrentPlan({ name: "张三", email: "z@example.com" }, monthly) === null,
      JSON.stringify(matchCurrentPlan({ name: "张三" }, monthly)));

    // 5. A name hits BOTH cycles; the payload's stated cycle breaks the tie,
    //    and monthly is the default.
    const tieMonthly = matchCurrentPlan({ plan_name: "入门版", billing_cycle: "monthly" }, monthly);
    check("a tie defaults to the monthly variant",
      tieMonthly?.billingCycle === "monthly", JSON.stringify(tieMonthly));
    const tieYearly = matchCurrentPlan({ plan_name: "入门版", billing_cycle: "yearly" }, monthly);
    check("a stated yearly cycle wins the tie",
      tieYearly?.billingCycle === "yearly", JSON.stringify(tieYearly));
    const tieAnnual = matchCurrentPlan({ plan_name: "入门版", billing_cycle: "annual" }, monthly);
    check("the `annual` spelling is read as yearly",
      tieAnnual?.billingCycle === "yearly", JSON.stringify(tieAnnual));

    // 6. Degenerate inputs.
    check("no catalogue means no match", matchCurrentPlan({ plan_name: "高级版" }, []) === null);
    check("no subscription means no match", matchCurrentPlan(null, monthly) === null);
    check("an empty subscription means no match", matchCurrentPlan({}, monthly) === null);
    check("a non-array catalogue means no match", matchCurrentPlan({ plan_name: "高级版" }, null) === null);
  } catch (error) {
    fail("matchCurrentPlan identifies the current plan", error);
  }
}

// --- 5d. readSubscriptionExpiry(): several plausible field names ----------
// No session token was available to observe the real name, so several are tried
// in order. `null` means "the payload did not state one", which the panel
// renders as nothing rather than as an error.
{
  check("expires_at is read",
    readSubscriptionExpiry({ expires_at: "1800000000" }) === 1800000000);
  check("a camelCase spelling is read",
    readSubscriptionExpiry({ expiresAt: 1800000000 }) === 1800000000);
  check("current_period_end is read",
    readSubscriptionExpiry({ current_period_end: "2026-10-01T00:00:00Z" }) === 1790812800,
    String(readSubscriptionExpiry({ current_period_end: "2026-10-01T00:00:00Z" })));
  check("the first usable field wins",
    readSubscriptionExpiry({ expires_at: "0", end_at: "1800000000" }) === 1800000000,
    String(readSubscriptionExpiry({ expires_at: "0", end_at: "1800000000" })));
  check("an unstated expiry is null", readSubscriptionExpiry({ plan: "高级版" }) === null);
  check("a null payload is null", readSubscriptionExpiry(null) === null);
  check("a null expiry never reads as 1970",
    readSubscriptionExpiry({ expires_at: "0" }) === null, String(readSubscriptionExpiry({ expires_at: "0" })));
}

// --- 5e. quotaWindows(): four WINDOWS, no balance -------------------------
// Agnes caps four dimensions account-wide, each a window rather than a credit
// balance, so the shape is "N per W hours" and there is nothing to decrement.
// A zero or absent limit is DROPPED rather than shown as "0 / 日": an unstated
// cap must not read as "you may do nothing".
{
  const full = quotaWindows({
    concurrencyLimit: 30000,
    concurrencyWindowH: 5,
    textWeeklyLimit: 300000,
    imageDailyLimit: 4000,
    videoDailyLimit: 500
  });
  try {
    check("a full plan yields four windows", full.length === 4, JSON.stringify(full.map((w) => w.key)));
    check("the windows come in the panel's order",
      full.map((w) => w.key).join(",") === "requests5h,requestsWeekly,imagesDaily,videoDaily",
      full.map((w) => w.key).join(","));
    const byKey = new Map(full.map((w) => [w.key, w]));
    check("the 5-hour window carries its own hour count",
      byKey.get("requests5h").limit === 30000 && byKey.get("requests5h").windowHours === 5,
      JSON.stringify(byKey.get("requests5h")));
    check("the weekly window is 168 hours", byKey.get("requestsWeekly").windowHours === 168);
    check("the image window is 24 hours and counted in images",
      byKey.get("imagesDaily").unit === "images" && byKey.get("imagesDaily").windowHours === 24,
      JSON.stringify(byKey.get("imagesDaily")));
    // The video limit's unit is the load-bearing honesty call: the field is
    // `video_daily_limit` while the usage side counts `video_seconds`, and the
    // platform never says which one the cap is in — so the unit claims nothing.
    check("the video window claims no seconds",
      byKey.get("videoDaily").unit === "video" && byKey.get("videoDaily").windowHours === 24,
      JSON.stringify(byKey.get("videoDaily")));
    check("no window carries a used/remaining figure",
      full.every((w) => !("used" in w) && !("remaining" in w)), JSON.stringify(full));
  } catch (error) {
    fail("quotaWindows builds the four windows", error);
  }

  try {
    // A missing hour count falls back to the platform's own 5 — the value
    // `usage_limit_text` renders on every plan.
    const noHours = quotaWindows({ concurrencyLimit: 1500 });
    check("a missing window hour count falls back to 5",
      noHours[0].windowHours === 5, JSON.stringify(noHours[0]));
    // Zero and absent limits are dropped, not shown as zero.
    const sparse = quotaWindows({ concurrencyLimit: 1500, textWeeklyLimit: 0, imageDailyLimit: "0" });
    check("a zero limit is dropped rather than shown as 0",
      sparse.map((w) => w.key).join(",") === "requests5h", JSON.stringify(sparse.map((w) => w.key)));
    check("an empty plan yields no windows", quotaWindows({}).length === 0);
    check("a null plan yields no windows", quotaWindows(null).length === 0);
    check("a plan with only a video cap yields one window",
      quotaWindows({ videoDailyLimit: 500 }).length === 1);
  } catch (error) {
    fail("quotaWindows tolerates a sparse plan", error);
  }
}

// --- 5f. usageWindow(): the day-snapped range the series is asked for -----
// The series endpoint takes DATES, so the window is measured in days. Snapping
// to whole days also makes the URL stable for the day, which is what lets the
// long series cache actually hit.
{
  const now = Date.UTC(2026, 9, 1, 12, 0, 0);
  const w = usageWindow(30, now);
  check("the end date is today (UTC)", w.endDate === "2026-10-01", w.endDate);
  // 30 days INCLUSIVE of today is a 29-day span.
  check("the start date is 29 days back for a 30-day window", w.startDate === "2026-09-02", w.startDate);
  check("a single-day window starts today", usageWindow(1, now).startDate === "2026-10-01", usageWindow(1, now).startDate);
  check("a zero/negative window still spans one day",
    usageWindow(0, now).startDate === "2026-10-01", usageWindow(0, now).startDate);
  // The same instant on the same day must give the same URL — that is the
  // whole point of snapping.
  check("the window is stable across the day",
    usageWindow(30, now).startDate === usageWindow(30, now + 3_600_000).startDate);
}

// --- 5g. planSummary(): the projection the panel compares ---------------
{
  const summary = planSummary(parsePlans([{
    uuid: "u", id: 2, name: "专业版", display_name: "专业版 Pro", billing_cycle: "yearly",
    display_cycle: "年付", price_minor: 99900, currency: "CNY",
    concurrency_limit: 7500, concurrency_window_h: 5, text_weekly_limit: 75000,
    image_daily_limit: 4000, video_daily_limit: 500,
    usage_limit_text: "7500 次模型请求 / 5 小时", feature_texts: ["x"]
  }])[0]);
  check("the summary carries the identity fields",
    summary.uuid === "u" && summary.name === "专业版" && summary.displayName === "专业版 Pro",
    JSON.stringify(summary));
  check("the summary nests the five limits",
    summary.limits.requests5h === 7500 && summary.limits.requestsWeekly === 75000 &&
      summary.limits.imagesDaily === 4000 && summary.limits.videoDaily === 500,
    JSON.stringify(summary.limits));
  check("the summary keeps the platform's limit sentence", summary.usageLimitText === "7500 次模型请求 / 5 小时");
  // `feature_texts` is the panel's catalogue-comparison detail and is NOT part
  // of the projection — it would be duplicated per entry on every poll.
  check("the summary drops feature_texts", !("featureTexts" in summary), JSON.stringify(Object.keys(summary)));
  check("a null plan still projects a full shape",
    planSummary(null).limits.requests5h === 0 && planSummary(null).name === "");
}

// --- 6. matchMultiplier(): the ×N labels the panel renders ----------------
// The pseudo-multiplier matching runs Host-side on the roster rows, so its
// semantics are part of the wire contract: substring match, case-insensitive,
// first configured key wins, and NO match means NO value (never a guessed 1).
// Agnes publishes no per-model usage, so the badge is the operator's own note.
{
  const map = { "glm-5.2": 10, "kimi-k3": 20, agnes: 1 };
  check("a substring match returns the value", matchMultiplier("GLM-5.2-Pro", map) === 10, String(matchMultiplier("GLM-5.2-Pro", map)));
  check("matching is case-insensitive", matchMultiplier("KIMI-K3", map) === 20, String(matchMultiplier("KIMI-K3", map)));
  check("a value of 1 still labels the row", matchMultiplier("agnes-image-2.5-flash", map) === 1);
  check("an unmatched model gets NO value (not 1)", matchMultiplier("unmatched", map) === undefined, String(matchMultiplier("unmatched", map)));
  // First-key-wins in insertion order: a model matching two keys takes the one
  // written first, not the "better" one.
  check("first configured key wins on overlap",
    matchMultiplier("deepseek-agnes", { agnes: 1, deepseek: 4 }) === 1,
    String(matchMultiplier("deepseek-agnes", { agnes: 1, deepseek: 4 })));
  // An empty/absent map (the operator set `{}`, which IS the shipped default)
  // leaves every row bare.
  check("an empty map disables all labels", matchMultiplier("glm-5.2", {}) === undefined);
  check("an absent map reads as disabled too", matchMultiplier("glm-5.2", undefined) === undefined);
  check("a missing model id matches nothing", matchMultiplier(undefined, map) === undefined);
  // A hazard worth naming: an empty key would match EVERY id (every string
  // contains ""). Nothing here defends against it — `resolveTrendMultipliers`
  // drops empty keys, so this function never receives one from config. Pinned
  // so the coupling is visible if that sanitizer is ever loosened.
  check("an empty key would match everything (the sanitizer is what prevents it)",
    matchMultiplier("anything", { "": 7 }) === 7, String(matchMultiplier("anything", { "": 7 })));
}

// --- 7. identifyVisionModel(): which callable models take image input -----
// Step one of the vision plan (ARCHITECTURE.md §5.1). Two signals in priority
// order: a structured modality field wins (Agnes confirms `input_modalities` on
// every catalog entry, 2026-09 probe); otherwise a name pattern, and the result
// is marked `source: "name"` so the panel can say "inferred".
{
  try {
    // Structured field: any of the accepted spellings wins over the name.
    const byField = identifyVisionModel({ id: "mystery", input_modalities: ["text", "image"] });
    check("a structured input_modalities field wins", byField.vision === true && byField.source === "field", JSON.stringify(byField));
    const byFieldOff = identifyVisionModel({ id: "mystery", input_modalities: ["text"] });
    check("a structured field saying text-only is not vision", byFieldOff.vision === false && byFieldOff.source === "field", JSON.stringify(byFieldOff));
    const stringList = identifyVisionModel({ id: "mystery", input_modalities: "text,image" });
    check("a comma-joined field value parses the same", stringList.vision === true && stringList.source === "field");
    const caps = identifyVisionModel({ id: "mystery", capabilities: "image,vision" });
    check("a `capabilities` field is also honored", caps.vision === true && caps.source === "field");
    // A text→image (image OUTPUT) model is not a vision model: only the input
    // side counts.
    const outOnly = identifyVisionModel({ id: "img-out", input_modalities: ["text"], output_modalities: ["image"] });
    check("image-only OUTPUT does not make a model vision", outOnly.vision === false && outOnly.source === "field", JSON.stringify(outOnly));

    // Name pattern, used only when no structured field is present at all.
    // (On Agnes the platform field makes this path unreachable; it exists so the
    // plugin degrades sensibly on a provider with no modality metadata.)
    const nameHit = identifyVisionModel({ id: "qwen2.5-vl-72b" });
    check("a vision-sounding name matches the pattern", nameHit.vision === true && nameHit.source === "name", JSON.stringify(nameHit));
    const nameMiss = identifyVisionModel({ id: "deepseek-v4-flash" });
    check("a plain text model is not vision", nameMiss.vision === false && nameMiss.source === null, JSON.stringify(nameMiss));
    // The legacy `flash-lite` guess is intentionally NOT a pattern anymore: the
    // real catalog shows Agnes-6.8-flash-lite carries
    // input_modalities ["text","image"] (vision via the field) while
    // Agnes-u1.5-lite is ["text"]-in / ["image"]-out — the name alone was
    // never the reliable signal, so the field is what decides.
    const flashLiteNoField = identifyVisionModel({ id: "Agnes-6.8-flash-lite" });
    check("flash-lite without a field no longer matches by name", flashLiteNoField.vision === false && flashLiteNoField.source === null, JSON.stringify(flashLiteNoField));

    // A field beats a contradicting name: the platform's word wins.
    const conflict = identifyVisionModel({ id: "some-flash-lite", input_modalities: ["text"] });
    check("a text-only field overrides a vision-sounding name", conflict.vision === false && conflict.source === "field");

    // Malformed input must not throw — the catalog poll must survive.
    check("a bare id with no other fields reads as not-vision",
      identifyVisionModel({ id: "x" }).vision === false);
    check("an entry without an id still returns a row", identifyVisionModel({}).id === "");
  } catch (error) {
    fail("identifyVisionModel classifies catalog entries", error);
  }
}

console.log(JSON.stringify(results, null, 2));
const failedChecks = results.filter((r) => !r.pass);
if (failedChecks.length > 0) {
  console.error(`\n${failedChecks.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
