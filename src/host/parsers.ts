/**
 * Console response parsing and shape-drift detection.
 *
 * The parsers stay forgiving so a poll never throws because a field moved;
 * that forgiveness is also how a platform-side rename becomes a serene "no
 * data yet" screen, so `EXPECTED_SHAPES` + `checkShape` are what let the panel
 * say "the upstream shape changed" instead of "you used nothing".
 *
 * Every function here takes the payload AFTER `console-client.ts` unwrapped
 * the `{code, message, data}` envelope — that is, it sees `data`, not the
 * wrapper. The one exception is `parsePlans`, whose `data` IS the array.
 * @module dsh-connect-agnes-token-plan/parsers
 */

import { str, obj } from "./util.ts";

/**
 * The top-level keys each console contract is expected to carry.
 *
 * The parsers below stay forgiving so that a poll never throws because a field
 * moved. That forgiveness is also how a platform-side rename becomes a serene
 * "no data yet" screen, so this declaration is what lets the panel say
 * "the upstream shape changed" instead of "you used nothing".
 *
 * `subscription` deliberately lists NOTHING: no session token was available to
 * observe that payload (see `docs/AGNES-API.md`), and inventing an
 * expectation for a contract nobody has seen would report drift on every poll.
 * The plan catalogue is checked separately — its `data` is an ARRAY, which
 * `checkShape` cannot describe.
 */
export const EXPECTED_SHAPES = Object.freeze({
  "usage-overview": ["total_requests", "total_tokens"],
  "usage-series": ["items"],
  // Observed live 2026-10-01 (see docs/AGNES-API.md): the subscription's core
  // identity carries `plan_name` and `billing_cycle`. The `usage` block that
  // also arrives here is DELIBERATELY not required — an account that has never
  // consumed anything may simply lack it, and missing `usage` is an absence of
  // enrichment, not a shape drift. Only the identity keys are load-bearing.
  "subscription": ["plan_name", "billing_cycle"]
});

/**
 * Parse one numeric field the console returns as a string or a number.
 *
 * Agnes mixes the two: plan limits arrive as real JSON numbers, while usage
 * counters have been seen as strings on the sibling gateway routes. `Number`
 * accepts both, and anything unparseable becomes 0 so the panel shows a
 * missing figure rather than `NaN`.
 */
export function countOf(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Read one timestamp as seconds since the epoch, from any shape the platform
 * might send it in: epoch seconds, epoch millis, a decimal string of either,
 * or an ISO-8601 date.
 *
 * The millis-vs-seconds guess is safe because the two ranges do not overlap in
 * practice: a seconds stamp above 1e12 would be the year 33658, and a millis
 * stamp below it would be 1970. Returns `null` for anything else — a missing
 * expiry must read as "unknown", never as 1970.
 */
export function timestampSeconds(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.floor(value > 1e12 ? value / 1000 : value);
  }
  const text = String(value).trim();
  if (text === "") return null;
  if (/^\d+(\.\d+)?$/.test(text)) return timestampSeconds(Number(text));
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

/**
 * Report which expected top-level keys a console payload is missing.
 * @param {unknown} body - the parsed console response (already unwrapped).
 * @param {string} kind - a key of {@link EXPECTED_SHAPES}.
 * @returns {{ok: boolean, missing: string[]}} the drift report.
 */
export function checkShape(body, kind) {
  const expected = EXPECTED_SHAPES[kind] ?? [];
  const source = obj(body);
  const missing = expected.filter((key) => source[key] === undefined);
  return { ok: missing.length === 0, missing };
}

/**
 * Normalize `GET /api/usage/overview` into the panel's totals row.
 *
 * These are CUMULATIVE figures for whatever period the platform reports — the
 * parser does not claim which. They are therefore shown as their own facts and
 * are never subtracted from a plan limit: a rolling 5-hour window cannot be
 * derived from a running total, and inventing `limit - total` would print a
 * remaining figure that is simply wrong.
 * @param {unknown} body - the unwrapped `data` object.
 * @returns {{totalRequests: number, totalTokens: number, totalImages: number, totalVideoSeconds: number, activeDays: number}}
 */
export function parseUsageOverview(body) {
  const source = obj(body);
  return {
    totalRequests: countOf(source.total_requests),
    totalTokens: countOf(source.total_tokens),
    totalImages: countOf(source.total_images),
    totalVideoSeconds: countOf(source.total_video_seconds),
    activeDays: countOf(source.active_days)
  };
}

/**
 * Normalize `GET /api/usage/series` into per-bucket rows plus their sum.
 *
 * Each `items[]` entry IS one bucket (hour or day, per the platform's own
 * `bucket` label), so unlike the SenseNova trend — where several points made
 * up one model's row — nothing is summed per row. `totals` sums ACROSS buckets
 * because that is a fact the platform does not state for the window, and the
 * panel needs it for its "in the last N days" line.
 *
 * Agnes offers no per-model breakdown at all (the console's own usage page
 * never reads a `model` field), so there is no `models` list to build.
 * @param {unknown} body - the unwrapped `data` object.
 * @param {number} days - the window the Host asked for, echoed for the label.
 * @returns {{days: number, totals: object, buckets: object[]}}
 */
export function parseUsageSeries(body, days) {
  const items = Array.isArray(obj(body).items) ? obj(body).items : [];
  const buckets: Array<{ bucket: string; requestCount: number; textTokens: number; imageCount: number; videoSeconds: number }> = [];
  for (const entry of items) {
    const source = obj(entry);
    const bucket = str(source.bucket, "");
    if (bucket === "") continue;
    buckets.push({
      bucket,
      requestCount: countOf(source.request_count),
      textTokens: countOf(source.text_tokens),
      imageCount: countOf(source.image_count),
      videoSeconds: countOf(source.video_seconds)
    });
  }
  // Chronological, so the panel's bars read left-to-right in time order
  // regardless of what order the platform listed the buckets in.
  buckets.sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));
  // The totals use the SAME key names as `parseUsageOverview`, so the panel
  // has one shape to render whether it is showing the window or the account.
  const totals = buckets.reduce(
    (acc, bucket) => ({
      totalRequests: acc.totalRequests + bucket.requestCount,
      totalTokens: acc.totalTokens + bucket.textTokens,
      totalImages: acc.totalImages + bucket.imageCount,
      totalVideoSeconds: acc.totalVideoSeconds + bucket.videoSeconds
    }),
    { totalRequests: 0, totalTokens: 0, totalImages: 0, totalVideoSeconds: 0 }
  );
  return { days, totals, buckets };
}

/**
 * Normalize the plan catalogue (`GET /api/cn/user/subscription/plans`).
 *
 * Verified live 2026-10-01 against an anonymous request: six entries —
 * `入门版` / `专业版` / `高级版`, each in a monthly and a yearly variant. The
 * numbers below are exactly the platform's field names; the daily image and
 * video caps are identical across all three tiers (4000 / 500), which is why
 * only the request dimensions actually differentiate the plans.
 *
 * `data` is an ARRAY here, not an object — the only Agnes response shaped that
 * way. An unexpected shape yields `[]`, never a throw.
 * @param {unknown} body - the unwrapped `data` value.
 * @returns {object[]} the catalogue, in the platform's own order.
 */
export function parsePlans(body) {
  const list = Array.isArray(body) ? body : [];
  return list.map((entry) => {
    const source = obj(entry);
    return {
      uuid: str(source.uuid, ""),
      planId: countOf(source.id),
      name: str(source.name, ""),
      displayName: str(source.display_name, str(source.name, "")),
      billingCycle: str(source.billing_cycle, ""),
      displayCycle: str(source.display_cycle, ""),
      priceMinor: countOf(source.price_minor),
      currency: str(source.currency, ""),
      concurrencyLimit: countOf(source.concurrency_limit),
      concurrencyWindowH: countOf(source.concurrency_window_h),
      textWeeklyLimit: countOf(source.text_weekly_limit),
      imageDailyLimit: countOf(source.image_daily_limit),
      videoDailyLimit: countOf(source.video_daily_limit),
      featureTexts: Array.isArray(source.feature_texts)
        ? source.feature_texts.filter((text) => typeof text === "string")
        : []
    };
  });
}

/**
 * Keys a subscription payload might name the current plan under.
 *
 * Deliberately a fixed list rather than "scan the whole payload for a string
 * that looks like a plan name": the subscription object also carries the
 * user's own `name`, an order list, and possibly a catalogue of every plan, so
 * a whole-payload scan would match `入门版` on an account that is on `高级版`.
 */
const PLAN_IDENTITY_KEYS = Object.freeze([
  "plan_uuid", "planUuid", "uuid",
  "plan_name", "planName", "plan", "plan_code", "planCode",
  "subscription_plan", "subscriptionPlan", "product", "product_name", "productName",
  "name", "display_name", "displayName", "tier"
]);

/** Every scalar anywhere in a value, as strings — used for uuid matching only. */
function collectScalars(value, depth, out) {
  if (depth > 3) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectScalars(item, depth + 1, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectScalars(item, depth + 1, out);
    return out;
  }
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    if (text !== "") out.add(text);
  }
  return out;
}

/** The values held under {@link PLAN_IDENTITY_KEYS}, at the top two levels. */
function collectIdentities(value, depth, out) {
  if (depth > 2) return out;
  const source = obj(value);
  for (const [key, entry] of Object.entries(source)) {
    if (PLAN_IDENTITY_KEYS.includes(key) && (typeof entry === "string" || typeof entry === "number")) {
      const text = str(String(entry), "");
      if (text !== "") out.add(text);
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) collectIdentities(entry, depth + 1, out);
  }
  return out;
}

/**
 * Find the catalogue entry the signed-in account is currently on.
 *
 * Two signals, strongest first:
 *
 * 1. UUID — a 36-character plan uuid may be matched ANYWHERE in the payload,
 *    because nothing else on the platform looks like one. This is what the
 *    platform's own plan objects use as their stable identity.
 * 2. NAME — matched only against the values held under
 *    {@link PLAN_IDENTITY_KEYS}, never against the whole payload.
 *
 * A numeric plan id is deliberately NOT a signal: the ids are 1–6, and a
 * subscription object is full of small integers, so `planId === 1` would
 * "match" the entry tier on almost every account.
 *
 * A name match hits BOTH billing cycles (入门版 exists as monthly and yearly),
 * so ties are broken with whatever cycle the payload states, defaulting to
 * monthly — the cheaper variant, and the one a fresh signup lands on.
 *
 * @param {unknown} subscription - the unwrapped `/api/cn/user/subscription` data.
 * @param {object[]} plans - the {@link parsePlans} result.
 * @returns {object|null} the matching catalogue entry, or null when the payload
 *   does not name a plan this plugin can recognise.
 */
export function matchCurrentPlan(subscription, plans) {
  const list = Array.isArray(plans) ? plans.filter((plan) => plan && typeof plan === "object") : [];
  if (list.length === 0 || subscription === undefined || subscription === null) return null;
  const everywhere = collectScalars(subscription, 0, new Set());
  const identities = collectIdentities(subscription, 0, new Set());
  const scoreOf = (plan) => {
    if (plan.uuid !== "" && (everywhere.has(plan.uuid) || identities.has(plan.uuid))) return 3;
    for (const value of [plan.name, plan.displayName]) {
      if (value !== "" && identities.has(value)) return 2;
    }
    return 0;
  };
  let bestScore = 0;
  for (const plan of list) bestScore = Math.max(bestScore, scoreOf(plan));
  if (bestScore === 0) return null;
  const tied = list.filter((plan) => scoreOf(plan) === bestScore);
  if (tied.length === 1) return tied[0];
  const stated = [...everywhere].find((value) => value === "monthly" || value === "yearly" || value === "annual");
  const cycle = stated === "annual" ? "yearly" : stated;
  return tied.find((plan) => plan.billingCycle === cycle)
    ?? tied.find((plan) => plan.billingCycle === "monthly")
    ?? tied[0];
}

/**
 * Read a subscription's expiry, from whichever of the plausible key names the
 * platform actually uses.
 *
 * No session token was available to observe the real field name, so several
 * are tried in order of likelihood. `null` means "the payload did not state
 * one", which the panel renders as nothing rather than as an error.
 * @param {unknown} subscription - the unwrapped subscription data.
 * @returns {number|null} seconds since the epoch, or null.
 */
export function readSubscriptionExpiry(subscription) {
  const source = obj(subscription);
  for (const key of [
    "expires_at", "expiresAt", "expire_at", "expired_at",
    "end_at", "end_date", "current_period_end", "next_billing_at", "next_billing_date"
  ]) {
    const value = timestampSeconds(source[key]);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Turn one catalogue entry into the panel's quota windows.
 *
 * Agnes caps four dimensions, each a WINDOW rather than a credit balance, so
 * the shape is "N per W hours" and there is no balance to decrement:
 *
 * | key | limit field | window |
 * |---|---|---|
 * | `requests5h` | `concurrency_limit` | `concurrency_window_h` (5 on every plan) |
 * | `requestsWeekly` | `text_weekly_limit` | 168 h |
 * | `imagesDaily` | `image_daily_limit` | 24 h |
 * | `videoDaily` | `video_daily_limit` | 24 h |
 *
 * The platform's own `usage_limit_text` ("1500 次模型请求 / 5 小时") names the
 * first window's shape but is NOT parsed or rendered: it is static plan
 * marketing that never moves with consumption. The live per-window figures
 * come from `subscription.usage` instead (see `parseSubscriptionUsage`).
 *
 * `unit` is `"requests"` / `"images"` / `"video"` and carries NO seconds claim
 * for video: the field is named `video_daily_limit` while the usage side
 * counts `video_seconds`, and the platform never states which one the limit
 * is in. The panel prints the bare number for that reason.
 *
 * A zero or absent limit is dropped rather than shown as "0 / 日" — an
 * unstated cap must not read as "you may do nothing".
 * @param {unknown} plan - one catalogue entry (or a subscription's own limits).
 * @returns {object[]} the windows, in the order the panel lists them.
 */
export function quotaWindows(plan) {
  const source = obj(plan);
  const windows: Array<{ key: string; unit: string; limit: number; windowHours: number }> = [];
  const requests5h = countOf(source.concurrencyLimit);
  if (requests5h > 0) {
    windows.push({
      key: "requests5h",
      unit: "requests",
      limit: requests5h,
      windowHours: countOf(source.concurrencyWindowH) || 5
    });
  }
  const weekly = countOf(source.textWeeklyLimit);
  if (weekly > 0) {
    windows.push({ key: "requestsWeekly", unit: "requests", limit: weekly, windowHours: 168 });
  }
  const images = countOf(source.imageDailyLimit);
  if (images > 0) {
    windows.push({ key: "imagesDaily", unit: "images", limit: images, windowHours: 24 });
  }
  const video = countOf(source.videoDailyLimit);
  if (video > 0) {
    windows.push({ key: "videoDaily", unit: "video", limit: video, windowHours: 24 });
  }
  return windows;
}

/**
 * Parse a Shanghai-local wall clock the platform sends without an offset.
 *
 * The console declares `"timezone":"Asia/Shanghai"` (its overview reports it)
 * and sends window timestamps as bare `"2026-10-01T15:00:00"`. Interpreting
 * that with the host's own `Date.parse` would shift the reset time by the
 * machine's offset, so the platform's convention is applied explicitly:
 * UTC+8. Returns epoch SECONDS, or null for anything that is not that shape.
 * @param {unknown} text - the raw timestamp string.
 * @returns {number|null} epoch seconds, or null.
 */
function shanghaiSeconds(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(text ?? ""));
  if (match === null) return null;
  const [, year, month, day, hour, minute, second = "0"] = match;
  // `Date.UTC` reads the fields AS IF they were UTC; the platform means
  // Shanghai, which is UTC+8, so the real epoch is that reading minus 8 hours.
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) / 1000 - 8 * 3600;
}

/**
 * Which subscription usage slot answers which panel window.
 *
 * `subscription.usage` is the platform's OWN per-window reading, grouped by
 * generation and keyed by the window shape it applies to:
 *
 * | panel window | subscription path |
 * |---|---|
 * | `requests5h` | `text_generation.windowed` |
 * | `requestsWeekly` | `text_generation.weekly` |
 * | `imagesDaily` | `image_generation.daily` |
 * | `videoDaily` | `video_generation.daily` |
 *
 * Verified live 2026-10-01. This is the ONLY per-window consumption the
 * platform publishes; it is what lets the panel draw a real `used / limit`
 * bar instead of declining to compute one.
 */
const USAGE_WINDOW_MAP = Object.freeze({
  "requests5h": ["text_generation", "windowed"],
  "requestsWeekly": ["text_generation", "weekly"],
  "imagesDaily": ["image_generation", "daily"],
  "videoDaily": ["video_generation", "daily"]
});

/** A finite number, or null — so an absent figure never reads as a measurement. */
function numOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Read `subscription.usage` into the panel's per-window facts.
 *
 * This is the missing half of the quota story. `quotaWindows` states the
 * LIMIT from the plan; this states what has actually been consumed inside the
 * current window, plus the window's own bounds and the moment it resets — all
 * figures the PLATFORM reported, not derived here. Nothing is subtracted:
 * `used` and `limit` are quoted side by side exactly as the console shows
 * them, so the panel's bar is a transcription, not an arithmetic claim.
 *
 * Returns `null` when the payload carries no `usage` at all — an account that
 * has never consumed anything simply may not report one, and that absence
 * must read as "no bar", never as "used 0".
 * @param {unknown} subscription - the unwrapped `/api/cn/user/subscription` data.
 * @returns {Record<string, {used: number|null, limit: number, usagePct: number|null, rangeStart: number|null, rangeEnd: number|null, resetAt: number|null, resetInSeconds: number|null}>|null}
 */
export function parseSubscriptionUsage(subscription) {
  const usage = obj(obj(subscription).usage);
  if (Object.keys(usage).length === 0) return null;
  const out = {};
  for (const [windowKey, pair] of Object.entries(USAGE_WINDOW_MAP)) {
    const group = pair[0];
    const slot = pair[1];
    if (group === undefined || slot === undefined) continue;
    const cell = obj(obj(usage[group])[slot]);
    if (Object.keys(cell).length === 0) continue;
    out[windowKey] = {
      used: numOrNull(cell.used),
      limit: countOf(cell.limit),
      usagePct: numOrNull(cell.usage_pct),
      rangeStart: shanghaiSeconds(cell.time_range_start),
      rangeEnd: shanghaiSeconds(cell.time_range_end),
      resetAt: shanghaiSeconds(cell.reset_at),
      resetInSeconds: numOrNull(cell.reset_in_seconds)
    };
  }
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * Whether one `GET /v1/models` entry can take image input, and WHY.
 *
 * This is the first step of the vision plan (ARCHITECTURE.md §5.1): the panel
 * shows which of this key's callable models accept pictures, so the user
 * knows which one to ask for image input.
 *
 * Two signals, in priority order:
 *
 * 1. STRUCTURED — the Agnes catalog declares `input_modalities` (an
 *   array, e.g. `["text","image"]`) on every entry. This is CONFIRMED the
 *   platform ships it (2026-09 probe), so it is the authoritative answer:
 *   a model is vision-capable iff `"image"` appears in its input
 *   modalities. The name fallback below stops mattering on this platform.
 *   `inputTypes` / `modality` / `capabilities` are kept as the fallback for
 *   other providers that spell the same idea differently — no parser
 *   change needed when they arrive.
 * 2. NAME PATTERN — only when NO structured modality field is present at
 *   all: naming conventions for the multimodal/vision families. Marked
 *   `source: "name"` so the panel can say "inferred from the name" and
 *   never pretend the platform declared it.
 *
 * @param {object} entry - one catalog entry (id + any extra fields).
 * @returns {{"id": string, "vision": boolean, "source": "field"|"name"|null}}
 */
export function identifyVisionModel(entry) {
  const source = obj(entry);
  const id = str(source.id, "");
  const modalities = modalitiesOf(source);
  if (modalities !== undefined) {
    return { id, vision: modalities.some((modality) => /image/i.test(modality)), source: "field" };
  }
  // Naming conventions only: multimodal/vision suffixes. Anything that
  // matches neither is reported as not-vision — the panel shows the list,
  // a human can correct. (On Agnes the platform field above makes this
  // path unreachable; it exists so the plugin degrades sensibly on a
  // provider that exposes no modality metadata at all.)
  const byName = VISION_NAME_PATTERNS.some((pattern) => pattern.test(id));
  return { id, vision: byName, source: byName ? "name" : null };
}

/**
 * Read the first modality-listing field off a catalog entry, or undefined.
 * The Agnes platform's confirmed field is `input_modalities` (array of
 * strings, e.g. `["text","image"]`); the others are the spellings other
 * providers are expected to use. Accepts string or array values so whatever
 * the platform ships parses.
 * @param {object} source - one catalog entry.
 * @returns {string[]|undefined} the modality names, or undefined.
 */
function modalitiesOf(source) {
  for (const key of ["input_modalities", "inputTypes", "modality", "capabilities"]) {
    const value = source[key];
    if (Array.isArray(value)) return value.map((modality) => String(modality));
    if (typeof value === "string" && value !== "") return value.split(/[,|]/).map((modality) => modality.trim());
  }
  return undefined;
}

/**
 * Name patterns used ONLY when no structured modality field is present.
 * `flash-lite` was the legacy guess from before the platform confirmed
 * `input_modalities`; it is no longer a reliable signal (the name now maps
 * to a model family whose actual modality mix the platform field decides),
 * so it is dropped from the fallback set.
 */
const VISION_NAME_PATTERNS = Object.freeze([
  /-vl(-|\b)/i,
  /vision/i,
  /qwen.*vl/i,
  /glm-4v/i
]);
