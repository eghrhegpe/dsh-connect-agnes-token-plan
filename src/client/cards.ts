/**
 * Hook-free presentational components: the panel icon, the plan card, its
 * quota-window sub-cards, the usage figures and chart, and the collapsible
 * section card. The render suite drives every one of these in Node, so
 * behavior may not drift by a hair.
 */
import { clockLong, clockSameDay, count, format, money, tokenSize } from "./format.ts";
import { h } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import { S } from "./styles.ts";
import type { PlanData, QuotaData, QuotaWindowData, UsageBucketData, UsageData, UsageTotalsData } from "./wire.ts";

/**
 * A quota window as the wire carries it; fields are defensive on purpose.
 *
 * The alias names the WELL-FORMED shape the two readers cast to once their own
 * `typeof` guard has passed — it is not a parameter type. Both entry points
 * declare `unknown` on purpose: a window that is not an object at all (a
 * shape-drifted row, an absent field) must render nothing instead of throwing,
 * and writing the union out (`QuotaWindow | null | unknown`) would not buy
 * anything, because `unknown` absorbs every other member — the precise-looking
 * spelling is exactly `unknown`. `wire.ts` already declares the well-formed
 * case, so this references it rather than redeclaring it.
 */
type QuotaWindow = QuotaWindowData;

/**
 * One percentage's severity: 90 danger / 70 warn, else ok.
 *
 * Its own function because a SECOND surface reads the same thresholds — the
 * composer usage pill paints a status dot with them (`composer-usage-pill.ts`).
 * Two copies of "90 / 70" would be two answers to "when is a window in
 * trouble", and the panel's tonal vocabulary is not something to re-invent per
 * surface.
 */
export function usageTier(pct: number): "error" | "warn" | "ok" {
  if (pct >= 90) return "error";
  if (pct >= 70) return "warn";
  return "ok";
}

/**
 * The bar fill for a usage percentage, by {@link usageTier}.
 *
 * The fill is the whole answer: the bar is the only surface that colours by
 * tier, and the figure keeps the panel's one text colour. (This used to also
 * return a `color` "for the figure", which no caller ever read — a second
 * answer to a question nobody asked.)
 */
export function usageTone(pct: number): Record<string, unknown> {
  const tier = usageTier(pct);
  if (tier === "error") return S.barFillError;
  if (tier === "warn") return S.barFillWarn;
  return S.barFill;
}

/**
 * One window's consumption percentage — the panel's single reading of it.
 *
 * The percentage is the platform's own `usagePct`, quoted verbatim — never a
 * re-derivation. The Host parses it from the subscription response and ships it
 * down for exactly this purpose (docs/API.md §快照, AGNES-API.md: the bar is a
 * transcription, not a computation). Two reasons it is NOT `used/limit` first:
 *
 *  - the platform's denominator need not be `limit` (it may be a separate
 *    quota ceiling for the same window), so the arithmetic silently shows a
 *    different number than the one the console shows;
 *  - clamping to 100 would rewrite the platform's own value. A window in
 *    overage reports >100, and that is a fact, not a rendering bug.
 *
 * `used / limit` remains only as the fallback for a Host that predates the
 * field or omits it for this window — a shape mismatch must still render.
 * `null` means "no reading", which is a different claim from `0`.
 *
 * Exported because the composer pill quotes the same two windows and must not
 * grow a second opinion about what a window's percentage is.
 */
export function windowPercent(window: unknown): number | null {
  if (window === null || typeof window !== "object") return null;
  const source = window as QuotaWindow;
  const platformPct = typeof source.usagePct === "number" && Number.isFinite(source.usagePct) ? source.usagePct : null;
  if (platformPct !== null) return platformPct;
  const limit = Number(source.limit) || 0;
  const used = typeof source.used === "number" && Number.isFinite(source.used) ? source.used : null;
  return used !== null && limit > 0 ? (used / limit) * 100 : null;
}

/**
 * The window's own name, from the key the Host emits.
 *
 * Falls back to the raw key rather than to a generic "quota": an unmapped key
 * means the Host grew a dimension this bundle has never heard of, and showing
 * `requestsMonthly` is more useful to whoever has to fix that than showing
 * four identical "Quota" labels.
 */
function windowLabel(key: unknown, tt: Tt): string {
  const name = String(key ?? "");
  return name === "" ? tt("quota.window") : tt(`quota.win.${name}`);
}

/** The window's period, phrased the way the platform phrases it. */
function windowPeriod(hours: unknown, tt: Tt): string {
  const value = Number(hours);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value === 168) return tt("quota.perWeek");
  if (value === 24) return tt("quota.perDay");
  return format(tt("quota.perHours"), { hours: value });
}

/**
 * The unit a dimension is counted in — `""` only where naming one would be an
 * invention.
 *
 * Video is deliberately unitless. The platform's limit field is
 * `video_daily_limit` while its usage field is `total_video_seconds`, and it
 * never says which one the limit is expressed in, so printing "500 秒" would
 * assert something nobody verified.
 *
 * An UNKNOWN unit falls back to the raw name, the same rule `windowLabel`
 * follows for an unknown key: a Host that grew a dimension this bundle has
 * never heard of must show up as itself. Returning `""` there would drop the
 * noun and print a naked "1500" — the exact "reads as available capacity"
 * shape this card exists to avoid, and silent where an unknown KEY is loud.
 */
function unitOf(unit: unknown, tt: Tt): string {
  const name = String(unit ?? "");
  if (name === "requests") return tt("quota.unit.requests");
  if (name === "images") return tt("quota.unit.images");
  if (name === "video") return "";
  return name;
}

/** `monthly` / `yearly` as the panel phrases them. */
function cycleLabel(cycle: unknown, tt: Tt): string {
  const name = String(cycle ?? "");
  if (name === "yearly" || name === "annual") return tt("quota.cycle.yearly");
  if (name === "monthly") return tt("quota.cycle.monthly");
  return name;
}

/**
 * One quota window as a compact sub-card.
 *
 * The CONSUMPTION FRACTION is the headline, not the raw limit. When the
 * subscription reports a window's `used` against the plan's `limit`, the big
 * figure is the platform's own fraction as a percentage and the raw
 * `used / limit` counts sit below it — a bare "1500 次" headline reads as
 * available capacity and misleads exactly when the window is exhausted. The
 * limit is still quoted verbatim in the counts line; nothing is subtracted or
 * re-derived. A window with no stated `used` (the video window today: the cap
 * field is `video_daily_limit` while usage counts `video_seconds`) keeps the
 * limit as its headline, because there is no fraction to lead with.
 *
 * A window that is not an object at all (a row the Host flagged as
 * shape-drifted, or a field simply absent) renders NOTHING instead of throwing:
 * one malformed row must not blank the whole panel — the shape warning above
 * already says what is wrong.
 */
export function QuotaWindowCard({ label, window, tt }: { label: string; window: unknown; tt: Tt }): unknown {
  if (window === null || typeof window !== "object") return null;
  const source = window as QuotaWindow;
  const limit = Number(source.limit) || 0;
  const unit = unitOf(source.unit, tt);
  // `used` is only meaningful when the PLATFORM stated it — a missing field
  // must not read as zero used, which would draw a full bar and claim the
  // window is untouched.
  const used = typeof source.used === "number" && Number.isFinite(source.used) ? source.used : null;
  // The percentage comes from the ONE shared reading of a window
  // (`windowPercent`: the platform's own `usagePct`, else `used / limit`), so
  // the card and the composer pill cannot grow two opinions about it.
  const pct = windowPercent(source);
  // The window's own reset moment, when the subscription reported one. It is a
  // fact the platform states, so it is quoted verbatim; the platform's own
  // countdown is used only when the absolute time is missing.
  const resetAt = typeof source.resetAt === "number" && Number.isFinite(source.resetAt) ? source.resetAt : null;
  const resetInSeconds = typeof source.resetInSeconds === "number" && Number.isFinite(source.resetInSeconds) ? source.resetInSeconds : null;
  // A same-day reset collapses to time only (`重置 17:00`): the panel re-
  // renders well before the day turns, so the date is dead weight on the
  // common case. `clockSameDay` keeps the date when the reset falls on a
  // different calendar day, so the reader never has to guess whether the
  // clock means today or tomorrow.
  const resetLine = resetAt !== null
    ? format(tt("quota.resetAt"), { time: clockSameDay(resetAt) })
    : resetInSeconds !== null
      ? format(tt("quota.resetCountdown"), { minutes: Math.max(1, Math.round(resetInSeconds / 60)) })
      : null;
  return h(
    "div",
    { style: S.quota },
    // The head is the window's IDENTITY alone. It used to carry a period chip
    // ("生图" + "每日", "5 小时" + "每周"), but the card head already names the
    // period for the request group ("5 小时" / "每周") and the reset line below
    // states the moment — so the chip only ever repeated one of the two. The
    // card reads: what it is, how much is used, when it resets.
    h(
      "div",
      { style: S.quotaTop },
      h("span", { style: S.quotaLabel }, label)
    ),
    // With a stated `used`, the percentage IS the fact the reader needs — it
    // leads. Without one, the limit is all the card knows and keeps the lead,
    // but at a smaller size: a capacity ceiling and a measured reading are not
    // the same claim, and dressing the ceiling like the headline made the two
    // indistinguishable at a glance.
    pct !== null
      ? h("div", { style: S.quotaRemaining }, `${pct.toFixed(1)}%`)
      : h("div", { style: S.quotaLimit }, limit > 0 ? `${count(limit)}${unit === "" ? "" : ` ${unit}`}` : "—"),
    pct === null
      ? null
      : h(
          "div",
          {
            style: S.bar,
            role: "progressbar",
            "aria-label": `${label} ${tt("quota.used")} ${pct.toFixed(1)}%`,
            // ARIA cannot carry a value above its own maximum, and this window
            // is the one that legitimately exceeds 100 (the platform's own
            // figure, never clamped — PITFALLS §45). Reading `valuenow=130`
            // against a fixed `valuemax=100` is an invalid meter, and a reader
            // that clamps it loses the single fact the bar is there to carry.
            // So the maximum FOLLOWS the reading, and `aria-valuetext` spells
            // the platform's figure out so an overage survives speech intact.
            "aria-valuenow": pct.toFixed(1),
            "aria-valuemin": 0,
            "aria-valuemax": Math.max(100, Math.ceil(pct)),
            "aria-valuetext": `${pct.toFixed(1)}%`
          },
          h("div", { style: { ...usageTone(pct), width: `${pct}%` } })
        ),
    // The counts and the reset stamp share ONE bottom row (counts left, reset
    // right) — two stacked rows would spend vertical space the bar already
    // paid for, and even a narrow twin card fits this pair. The counts need a
    // real fraction: a zero limit has none, and "已用 0 / 0" would read as a
    // measurement of a window the platform never sized.
    //
    // They also need a real `used`, which is a SEPARATE condition from `pct`:
    // the Host parses `used` and `usagePct` from two independent fields, so a
    // window can carry a percentage and no reading at all. `count(null)`
    // renders "0", and "已用 0 / N" is exactly the "the window is untouched"
    // claim the `used` guard above refuses. Keep the bar and the percentage
    // (both are the platform's own word), drop only the count row.
    (pct === null || used === null) && resetLine === null
      ? null
      : h(
          "div",
          { style: S.quotaFoot },
          pct === null || used === null
            ? null
            : h("span", { style: S.quotaUsed }, `${tt("quota.used")} ${count(used)} / ${count(limit)}`),
          resetLine === null ? null : h("span", { style: { ...S.muted, fontSize: 11 } }, resetLine)
        )
  );
}

/**
 * The windows, partitioned into two RESPONSIBILITY groups.
 *
 * Agnes caps two different jobs: text generation is limited per 5 hours and
 * per week, image/video generation per day. A flat grid labels the first two
 * "模型请求 / 5 小时" and "每周请求 / 每周" — the noun and the period repeat
 * each other. Grouping lets the heading carry the job ("模型请求" / "多媒体")
 * and the card head carry only what distinguishes the siblings: the period
 * inside the request group ("5 小时" / "每周"), the capability inside the
 * media group ("生图" / "视频"), whose daily period rides along as the chip.
 *
 * Unknown keys (a dimension this bundle has never heard of) keep the raw-key
 * label and land in an unheaded pool, so a new Host dimension still shows its
 * numbers instead of being silently dropped by the partition.
 */
const WINDOW_GROUPS: Array<{ label: string; keys: string[]; headByPeriod: boolean }> = [
  { label: "quota.group.requests", keys: ["requests5h", "requestsWeekly"], headByPeriod: true },
  { label: "quota.group.media", keys: ["imagesDaily", "videoDaily"], headByPeriod: false }
];

/** One group's windows plus each card's distinguishing head label. */
function windowGroups(windows: unknown[], tt: Tt): Array<{ label: string; items: Array<{ key: string; label: string; window: unknown }> }> {
  const placed = new Set<string>();
  const groups = WINDOW_GROUPS
    .map((group) => {
      const items = windows
        .map((window) => ({ window, key: String((window as { key?: unknown })?.key ?? "") }))
        .filter(({ key }) => group.keys.includes(key))
        .map(({ key, window }) => {
          placed.add(key);
          const period = windowPeriod((window as { windowHours?: unknown })?.windowHours, tt);
          return { key, label: group.headByPeriod && period !== "" ? period : windowLabel(key, tt), window };
        });
      return { label: group.label, items };
    })
    .filter((group) => group.items.length > 0);
  const rest = windows
    .map((window) => ({ window, key: String((window as { key?: unknown })?.key ?? "") }))
    .filter(({ key }) => !placed.has(key))
    .map(({ key, window }) => ({ key, label: windowLabel(key, tt), window }));
  if (rest.length > 0) groups.push({ label: "", items: rest });
  return groups;
}

/**
 * The reader's own plan: its identity and the four windows it caps.
 *
 * The plan catalogue (the other tiers) is a separate concern — "what would
 * upgrading buy?" — and lives in its own section below, so the open card is
 * purely about the reader's current plan.
 */
export function PlanCard({ quota, tt }: { quota?: QuotaData | null; tt: Tt }): unknown {
  const plan: PlanData | null = quota?.plan ?? null;
  const windows = Array.isArray(quota?.windows) ? quota.windows : [];
  if (plan === null && windows.length === 0) {
    return h("div", { style: S.empty }, tt("quota.none"));
  }
  return h(
    "div",
    null,
    plan === null
      ? h("div", { style: S.empty }, tt("quota.planUnknown"))
      : h(
          "div",
          { style: S.cardHead },
          h("span", { style: S.poolName }, plan.displayName || plan.name || tt("quota.planUnknown")),
          plan.billingCycle ? h("span", { style: S.chip }, cycleLabel(plan.billingCycle, tt)) : null,
          // The price is money the user pays, so it reads as a figure, not a
          // pill — same reasoning as the old grant balance.
          plan.priceMinor !== undefined && plan.priceMinor > 0
            ? h("span", { style: S.grantChip }, `${money(plan.priceMinor, plan.currency)}${plan.billingCycle === "yearly" ? tt("quota.perYear") : tt("quota.perMonth")}`)
            : null,
          h("span", { style: S.spacer }),
          quota?.expiresAt
            ? h("span", { style: S.quotaReset }, format(tt("quota.expires"), { time: clockLong(quota.expiresAt) }))
            : null
        ),
    // The plan catalogue's `usage_limit_text` ("1500 次模型请求 / 5 小时") is
    // deliberately NOT rendered: it is static plan marketing that never moves
    // with consumption, so it reads as available capacity exactly when the
    // window is spent. The live per-window fractions below are the truth.
    // Each responsibility group is ONE POOL CARD containing its window
    // sub-cards (like the SenseNova pools): "模型请求" holds the 5-hour and
    // weekly twins, "多媒体" holds images and video. The pool cards sit in a
    // shared auto-fit grid, so on a wide pane the two pools fill one row left
    // and right; on a narrow one they stack. Unknown dimensions get an
    // unheaded pool so a new Host dimension still shows its numbers.
    windows.length > 0
      ? h(
          "div",
          { style: S.pools },
          windowGroups(windows, tt).map((group) =>
            h(
              "div",
              { key: group.label || "_rest", style: S.pool },
              group.label === "" ? null : h("div", { style: S.poolHead }, tt(group.label)),
              h(
                "div",
                { style: S.quotas },
                group.items.map((item) =>
                  h(QuotaWindowCard, { key: item.key, label: item.label, window: item.window, tt })
                )
              )
            )
          )
        )
      : null,
  );
}

/**
 * The public plan catalogue — what the other tiers would allow.
 *
 * Rendered inside its own section (not folded into the reader's plan card),
 * so the reader's own numbers stay uncluttered and the "is upgrading worth it"
 * question is one click away without crowding the plan identity.
 *
 * Returns `null` when no catalogue arrived, so the section can be hidden
 * entirely rather than showing an empty card.
 */
export function CatalogueCard({ plans, tt }: { plans?: PlanData[] | null; tt: Tt }): unknown {
  const catalogue = Array.isArray(plans) ? plans : [];
  if (catalogue.length === 0) return null;
  // Group by tier: the platform returns 6 rows (入门/专业/高级 × 月付/年付).
  // Grouping by the tier name lets the reader compare like-for-like across
  // billing cycles, instead of reading a 6-row flat list where the 5h/每周/每日
  // numbers repeat and the eye has no anchor.
  const tiers = new Map<string, PlanData[]>();
  for (const entry of catalogue) {
    const name = entry.displayName || entry.name || "";
    // Strip the cycle suffix to get the tier key: "入门版 (按月)" → "入门版"
    const key = name.replace(/\s*[（(].*?[）)]\s*$/, "").trim() || name;
    if (!tiers.has(key)) tiers.set(key, []);
    tiers.get(key)!.push(entry);
  }
  const renderLimit = (text: string) =>
    h("span", { style: S.planLimit }, text);
  const renderEntry = (entry: PlanData) => {
    const limits = entry.limits ?? {};
    const windowHours = Number(limits.requestsWindowH);
    const limitItems: unknown[] = [];
    if (limits.requests5h !== undefined && limits.requests5h > 0) {
      limitItems.push(renderLimit(`${count(limits.requests5h)}${tt("quota.unit.requests")} / ${windowHours > 0 ? windowHours : 5}h`));
    }
    if (limits.requestsWeekly !== undefined && limits.requestsWeekly > 0) {
      limitItems.push(renderLimit(`${count(limits.requestsWeekly)}${tt("quota.unit.requests")} / ${tt("quota.perWeek")}`));
    }
    if (limits.imagesDaily !== undefined && limits.imagesDaily > 0) {
      limitItems.push(renderLimit(`${count(limits.imagesDaily)}${tt("quota.unit.images")} / ${tt("quota.perDay")}`));
    }
    return h(
      "div",
      { style: S.planCycle },
      h("span", { style: S.planCycleLabel }, cycleLabel(entry.billingCycle, tt)),
      entry.priceMinor !== undefined && entry.priceMinor > 0
        ? h("span", { style: S.planPrice }, money(entry.priceMinor, entry.currency))
        : null
    );
  };
  return h(
    "div",
    { style: S.planGrid },
    Array.from(tiers.entries()).map(([tierName, entries]) =>
      h(
        "div",
        { key: tierName, style: S.planCard },
        h("span", { style: S.planTier }, tierName),
        entries.map((entry) =>
          h("div", { key: entry.uuid || String(entry.planId) },
            renderEntry(entry)
          )
        ),
        h("div", { style: S.planLimits },
          // Re-render the limits from the monthly entry (the first one, since
          // monthly and yearly share the same limits — only price differs).
          ...(() => {
            const e = entries[0];
            const limits = e?.limits ?? {};
            const windowHours = Number(limits.requestsWindowH);
            const items: unknown[] = [];
            if (limits.requests5h !== undefined && limits.requests5h > 0) {
              items.push(renderLimit(`${count(limits.requests5h)}${tt("quota.unit.requests")} / ${windowHours > 0 ? windowHours : 5}h`));
            }
            if (limits.requestsWeekly !== undefined && limits.requestsWeekly > 0) {
              items.push(renderLimit(`${count(limits.requestsWeekly)}${tt("quota.unit.requests")} / ${tt("quota.perWeek")}`));
            }
            if (limits.imagesDaily !== undefined && limits.imagesDaily > 0) {
              items.push(renderLimit(`${count(limits.imagesDaily)}${tt("quota.unit.images")} / ${tt("quota.perDay")}`));
            }
            return items;
          })()
        )
      )
    )
  );
}

/**
 * The consumption figures for one period, as a row of metric cells.
 *
 * `label` names the period ("account total" vs "last N days") because the two
 * blocks use the SAME figures with different meanings, and an unlabelled row
 * would let the reader take a lifetime total for a window total. `activeDays`
 * is only present on the account row — the series has no such field — and an
 * absent cell is simply not drawn rather than shown as 0.
 */
export function UsageTotals({ totals, label, tt }: { totals?: UsageTotalsData | null; label: string; tt: Tt }): unknown {
  const source = totals ?? null;
  if (source === null) return h("div", { style: S.empty }, format(tt("quota.usageMissing"), { label }));
  const cells = [
    { key: "requests", label: tt("quota.total.requests"), value: count(source.totalRequests), on: typeof source.totalRequests === "number" },
    // The account-lifetime token figure runs into the billions; the full
    // thousands-separated digits filled the cell and misbalanced the row
    // against its short neighbours. Same tokenSize() the rosters use.
    { key: "tokens", label: tt("quota.total.tokens"), value: tokenSize(source.totalTokens) || count(source.totalTokens), on: typeof source.totalTokens === "number" },
    { key: "images", label: tt("quota.total.images"), value: count(source.totalImages), on: typeof source.totalImages === "number" },
    // The field IS seconds (totalVideoSeconds — a measured usage figure, not
    // the window cap whose unit the platform never states), so naming the
    // unit is transcription, not invention.
    { key: "video", label: tt("quota.total.video"), value: `${count(source.totalVideoSeconds)} ${tt("quota.unit.seconds")}`, on: typeof source.totalVideoSeconds === "number" },
    { key: "days", label: tt("quota.total.activeDays"), value: count(source.activeDays), on: typeof source.activeDays === "number" }
  // An absent field is not a zero measurement. `count(undefined)` returns "0",
  // so a partially-missing totals block must omit the cell rather than draw a
  // figure nobody reported — the same rule `activeDays` already followed, now
  // applied to all four main counters.
  ].filter((cell) => cell.on);
  return h(
    "div",
    null,
    h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 8 } }, label),
    h(
      "div",
      { style: S.metricGrid },
      cells.map((cell) => h(
        "div",
        { key: cell.key, style: S.metric },
        h("span", { style: S.metricLabel }, cell.label),
        h("span", { style: S.metricValue }, cell.value)
      ))
    )
  );
}

/** One quota period's length: the platform's weekly window is 168 hours. */
const WEEK_MS = 168 * 3600 * 1000;

/**
 * A platform bucket label ("2026-09-29") as UTC milliseconds, or null.
 *
 * The label is parsed as a DATE, not an instant — `Date.parse("2026-09-29")`
 * is the one ISO form every engine reads as UTC midnight — because the weekly
 * grouping needs only WHERE a day falls relative to the reset line, and the
 * reset instants themselves arrived already normalised (Asia/Shanghai) from
 * the Host. Local-midnight parsing would shift every bucket by the reader's
 * timezone and place the reset line inside different days for different
 * readers.
 */
function dateMsOf(bucket: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bucket);
  if (m === null) return null;
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * One axis tick as the eye reads it: "2026-09-18" → "9-18". The year prints
 * only where it means something — a window inside one year never repeats it,
 * while a tick whose year differs from the window's first bucket keeps its
 * full "2025-12-30", so a series crossing New Year cannot read as two
 * equal-looking labels.
 */
function axisLabel(bucket: string, yearBase: string): string {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(bucket);
  if (m === null) return bucket;
  const short = `${Number(m[2])}-${Number(m[3])}`;
  return m[1] === yearBase ? short : `${m[1]}-${short}`;
}

/**
 * Which period index a date belongs to, counting back from the platform's
 * weekly reset: `0` is the current period, `1` the one before it, and so on.
 *
 * Periods are half-open `[anchor − (k+1)·W, anchor − k·W)`: the instant a
 * period opens belongs to the period it OPENS — usage at the reset line is
 * already the new period's usage, so a day whose midnight lands exactly on a
 * boundary counts toward the newer period. A plain `floor` would file that
 * boundary day into the older period and shift every seam by one day.
 *
 * The anchor is a POSITIVE epoch-second timestamp; a wall-clock label older
 * than the anchor (a stale snapshot, a clock disagreement) reads as the
 * current period rather than being clamped backwards — a bucket cannot
 * precede the window it was served inside.
 */
function periodIndexOf(bucketMs: number, anchorSec: number): number {
  return Math.max(0, Math.ceil((anchorSec * 1000 - bucketMs) / WEEK_MS) - 1);
}

/** One quota period's slice of the chart: its buckets and their total. */
interface PeriodBand {
  start: number;
  end: number;
  total: number;
  /** Distance from the anchor: 0 is the current period. Drives the shading. */
  period: number;
}

/**
 * Cut the (chronological) bucket run into quota periods walked back from the
 * anchor. Returns `null` when the run cannot be grouped — which covers BOTH
 * degenerate cases: an unparseable anchor (absent, negative, or not a number
 * the panel would stand behind) and a run with no parseable date label at
 * all. `null` is one spelling for "no bands" because the two failures must
 * degrade the same way: the plain per-bucket chart, no partial grouping.
 *
 * One date gap splits nothing: a period is a RANGE of time, so a missing
 * bucket is a zero inside its period, not a seam between two of them. What
 * the periods answer is "which days share a quota period" — a question about
 * where the reset lines fall, not about how many rows the platform returned.
 */
function groupIntoPeriods(buckets: UsageBucketData[], values: number[], anchorSec: number): PeriodBand[] | null {
  const bands: PeriodBand[] = [];
  let current: PeriodBand | null = null;
  let currentPeriod = -1;
  let sawDate = false;
  for (let index = 0; index < buckets.length; index += 1) {
    const ms = dateMsOf(String(buckets[index]?.bucket ?? ""));
    if (ms === null) continue;
    sawDate = true;
    const period = periodIndexOf(ms, anchorSec);
    if (current === null || period !== currentPeriod) {
      current = { start: index, end: index, total: 0, period };
      bands.push(current);
      currentPeriod = period;
    }
    current.end = index;
    current.total += values[index] ?? 0;
  }
  return sawDate ? bands : null;
}

/**
 * Per-bucket consumption as a mini bar chart, grouped into 7-day quota
 * periods.
 *
 * The x axis quotes the platform's OWN bucket labels — the series endpoint
 * takes dates and answers with whatever granularity it chose, and the panel
 * does not re-derive dates it was never promised. A 30-bucket window cannot
 * print thirty readable labels, so the axis shows a short "M-D" tick every few
 * buckets with the FULL platform label kept in each tick's `title`, and every
 * bar carries its own `title` for the one the reader hovers.
 *
 * Each bar prints its own request count above the fill, so "how much was that
 * day" is answered at a glance rather than only on hover. Zero buckets print
 * nothing — a bar with no fill needs no caption.
 *
 * OVER the bars sit the quota periods: alternating background bands walked
 * back from the weekly window's reset time, each with that period's request
 * total in one line above its bars. The bands are DECORATION, not data — no
 * height, no fill — so the eye never reads them as "the week's usage bar".
 * The grouping needs three things to line up: the anchor (the weekly window's
 * reset time, quoted from the snapshot the panel already polls), parseable
 * date labels on the buckets, and a parseable date on the FIRST label for the
 * axis's year logic. Any of them missing and the whole layer steps aside —
 * half a grouping is worse than none, because a missing band would read as
 * "no quota period here" rather than "not drawn".
 *
 * The bars are scaled to the LARGEST bucket, so the tallest always fills the
 * track; that answers "when was the heavy day", but the eye misreads a full
 * track as "at the limit", so the legend names the convention.
 */
export function UsageChart({ usage, weeklyResetAt, tt }: { usage?: UsageData | null; weeklyResetAt?: number | null; tt: Tt }): unknown {
  const buckets = Array.isArray(usage?.buckets) ? usage.buckets : [];
  if (buckets.length === 0) {
    return h("div", { style: S.empty }, tt("usage.none"));
  }
  const values = buckets.map((bucket) => Math.max(0, Number(bucket?.requestCount) || 0));
  const max = Math.max(0, ...values);
  // The anchor is only accepted as a well-formed positive epoch; anything
  // else (absent, negative, NaN) degrades to the plain chart.
  const anchorSec = Number(weeklyResetAt);
  const bands = Number.isFinite(anchorSec) && anchorSec > 0
    ? groupIntoPeriods(buckets, values, anchorSec)
    : null;
  // A handful of ticks instead of nothing between first and last: ~7 labels
  // for the 30-day default (6 for 14, 2 for a 2-bucket series), always ending
  // on the final bucket.
  const tickStep = Math.max(1, Math.ceil(buckets.length / 6));
  const tickIndexes: number[] = [];
  for (let index = 0; index < buckets.length; index += tickStep) tickIndexes.push(index);
  if (tickIndexes[tickIndexes.length - 1] !== buckets.length - 1) tickIndexes.push(buckets.length - 1);
  const yearBase = /^(\d{4})/.exec(String(buckets[0]?.bucket ?? ""))?.[1] ?? "";
  // One period band's column: the decorative background, its label (the
  // period's request total), and the bars it owns. The bars keep their own
  // flex row so the two scales never share a container: band widths follow
  // the PERIODS, bar widths follow the BUCKETS. Shading keys on the band's
  // DISTANCE from the anchor (period % 2), not its time order: the current
  // period is always the shaded one, so a window that gains or drops its
  // oldest band never flips the whole row's parity.
  const renderBand = (band: PeriodBand): unknown => h(
    "div",
    {
      key: `band-${band.start}`,
      style: { ...S.usageBand, ...(band.period % 2 === 0 ? S.usageBandEven : S.usageBandOdd), flexGrow: band.end - band.start + 1 },
      title: `${String(buckets[band.start]?.bucket ?? "")} ~ ${String(buckets[band.end]?.bucket ?? "")}: ${count(band.total)} ${tt("quota.unit.requests")}`
    },
    h("div", { style: S.usageBandLabel }, count(band.total)),
    h(
      "div",
      { style: S.usageBars },
      buckets.slice(band.start, band.end + 1).map((bucket, offset) => {
        const index = band.start + offset;
        const value = values[index] ?? 0;
        const pct = max > 0 ? ((value ?? 0) / max) * 100 : 0;
        const label = String(bucket?.bucket ?? "");
        return h(
          "div",
          {
            key: `${label}-${index}`,
            style: S.usageBar,
            title: `${label}: ${count(value)} ${tt("quota.unit.requests")}`
          },
          value > 0
            ? h("span", { style: { ...S.usageBarValue, bottom: `calc(${pct}% + 3px)` } }, count(value))
            : null,
          h("div", {
            style: { ...S.usageBarFill, height: `${pct}%` },
            role: "progressbar",
            "aria-label": `${label} ${count(value)}`,
            "aria-valuenow": Math.round(pct),
            "aria-valuemin": 0,
            "aria-valuemax": 100
          })
        );
      })
    )
  );
  return h(
    "div",
    null,
    h(
      "div",
      { style: S.trendHead },
      h("span", { style: S.trendHeadLabel }, tt("usage.requests")),
      h("span", { style: { ...S.trendHeadLabel, textAlign: "right" } }, tt("usage.perBucket"))
    ),
    bands !== null
      ? h("div", { style: S.usageBands }, bands.map(renderBand))
      : h(
          "div",
          { style: S.usageBars },
          buckets.map((bucket, index) => {
            const value = values[index] ?? 0;
            const pct = max > 0 ? ((value ?? 0) / max) * 100 : 0;
            const label = String(bucket?.bucket ?? "");
            return h(
              "div",
              {
                key: `${label}-${index}`,
                style: S.usageBar,
                title: `${label}: ${count(value)} ${tt("quota.unit.requests")}`
              },
              value > 0
                ? h("span", { style: { ...S.usageBarValue, bottom: `calc(${pct}% + 3px)` } }, count(value))
                : null,
              h("div", {
                style: { ...S.usageBarFill, height: `${pct}%` },
                role: "progressbar",
                "aria-label": `${label} ${count(value)}`,
                "aria-valuenow": Math.round(pct),
                "aria-valuemin": 0,
                "aria-valuemax": 100
              })
            );
          })
        ),
    h(
      "div",
      { style: S.usageAxis },
      tickIndexes.map((index) => {
        const full = String(buckets[index]?.bucket ?? "");
        return h("span", { key: `${full}-${index}`, style: S.usageAxisTick, title: full }, axisLabel(full, yearBase));
      })
    ),
    h("div", { style: S.trendLegend }, tt("usage.legend"), bands !== null ? h("div", { style: { marginTop: 2 } }, tt("usage.weekNote")) : null)
  );
}

/**
 * One content section as a workbuddy-style collapsible card: a full-width
 * header button (title + rotating chevron) over a bordered card body.
 * Auto-expanded by default in `PanelPage`; the reader can tuck a section
 * away to focus on the other. Hook-free on purpose — `open` and `onToggle`
 * arrive as props, so the render tests exercise the toggle without faking
 * React state (children travel as a regular `children` prop, as in React).
 */
export function SectionCard({ title, open, onToggle, children, tt }: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children?: unknown;
  tt: Tt;
}): unknown {
  return h(
    "div",
    { style: S.sectionCard },
    h(
      "button",
      {
        type: "button",
        style: S.sectionHead,
        "aria-expanded": open,
        "aria-label": `${tt(open ? "section.collapse" : "section.expand")}: ${title}`,
        onClick: onToggle
      },
      h("span", { style: S.sectionHeadTitle }, title),
      h(
        "svg",
        { viewBox: "0 0 16 16", width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", style: open ? { ...S.chevron, ...S.chevronOpen } : S.chevron },
        h("path", { d: "M3 6l5 5 5-5" })
      )
    ),
    h("div", { style: S.sectionBody, hidden: !open }, open ? children : null)
  );
}
