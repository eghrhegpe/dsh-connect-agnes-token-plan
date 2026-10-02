/**
 * Hook-free presentational components: the panel icon, the plan card, its
 * quota-window sub-cards, the usage figures and chart, and the collapsible
 * section card. The render suite drives every one of these in Node, so
 * behavior may not drift by a hair.
 */
import { PANEL_ID } from "./const.ts";
import { clockLong, count, format, money } from "./format.ts";
import { h } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import { S } from "./styles.ts";
import type { PlanData, QuotaData, QuotaWindowData, UsageData, UsageTotalsData } from "./wire.ts";

/**
 * A quota window as the wire carries it; fields are defensive on purpose.
 *
 * The alias exists because `QuotaWindowCard` deliberately accepts `unknown`: a
 * window that is not an object at all (a shape-drifted row, an absent field)
 * must render nothing instead of throwing. `wire.ts` already describes the
 * well-formed case, so this narrows the same shape instead of redeclaring it.
 */
type QuotaWindow = QuotaWindowData;

/** The sidebar row glyph: the shell owns the button, this draws the coin. */
export function PanelIcon({ size }: { size?: number }): unknown {
  return h(
    "svg",
    {
      "data-dsh-panel-entry": PANEL_ID,
      viewBox: "0 0 16 16",
      width: size,
      height: size,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.3",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true"
    },
    h("circle", { cx: 8, cy: 8, r: 6 }),
    h("path", { d: "M8 5.2v5.6M6.2 6.6h3.6M6.2 9.4h3.6" })
  );
}

/** The bar fill and figure tone for a usage percentage: 70 warn / 90 danger. */
export function usageTone(pct: number): { fill: Record<string, unknown>; color: string } {
  if (pct >= 90) return { fill: S.barFillError, color: "var(--dsw-alias-state-error-primary)" };
  if (pct >= 70) return { fill: S.barFillWarn, color: "var(--dsw-alias-state-warn-primary)" };
  return { fill: S.barFill, color: "var(--dsw-alias-label-secondary)" };
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
 * The unit a dimension is counted in — `""` for video.
 *
 * Video is deliberately unitless. The platform's limit field is
 * `video_daily_limit` while its usage field is `total_video_seconds`, and it
 * never says which one the limit is expressed in, so printing "500 秒" would
 * assert something nobody verified.
 */
function unitOf(unit: unknown, tt: Tt): string {
  const name = String(unit ?? "");
  if (name === "requests") return tt("quota.unit.requests");
  if (name === "images") return tt("quota.unit.images");
  return "";
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
export function QuotaWindowCard({ label, window, tt }: { label: string; window: QuotaWindow | null | unknown; tt: Tt }): unknown {
  if (window === null || typeof window !== "object") return null;
  const source = window as QuotaWindow;
  const limit = Number(source.limit) || 0;
  const period = windowPeriod(source.windowHours, tt);
  const unit = unitOf(source.unit, tt);
  // `used` is only meaningful when the PLATFORM stated it — a missing field
  // must not read as zero used, which would draw a full bar and claim the
  // window is untouched.
  const used = typeof source.used === "number" && Number.isFinite(source.used) ? source.used : null;
  const pct = used !== null && limit > 0 ? Math.min(100, (used / limit) * 100) : null;
  const tone = usageTone(pct ?? 0);
  // The window's own reset moment, when the subscription reported one. It is a
  // fact the platform states, so it is quoted verbatim; the platform's own
  // countdown is used only when the absolute time is missing.
  const resetAt = typeof source.resetAt === "number" && Number.isFinite(source.resetAt) ? source.resetAt : null;
  const resetInSeconds = typeof source.resetInSeconds === "number" && Number.isFinite(source.resetInSeconds) ? source.resetInSeconds : null;
  const resetLine = resetAt !== null
    ? format(tt("quota.resetAt"), { time: clockLong(resetAt) })
    : resetInSeconds !== null
      ? format(tt("quota.resetCountdown"), { minutes: Math.max(1, Math.round(resetInSeconds / 60)) })
      : null;
  return h(
    "div",
    { style: S.quota },
    h(
      "div",
      { style: S.quotaTop },
      h("span", { style: S.quotaLabel }, label),
      // When the period IS the head label (the request group's "5 小时" /
      // "每周"), the chip would repeat it verbatim — so it only rides along
      // on cards whose label names something else ("生图" + "每日").
      period === "" || period === label ? null : h("span", { style: S.quotaReset }, period)
    ),
    // With a stated `used`, the percentage IS the fact the reader needs — it
    // leads. Without one, the limit is all the card knows and keeps the lead.
    pct !== null
      ? h("div", { style: S.quotaRemaining }, `${pct.toFixed(1)}%`)
      : h("div", { style: S.quotaRemaining }, limit > 0 ? `${count(limit)}${unit === "" ? "" : ` ${unit}`}` : "—"),
    pct === null
      ? null
      : h(
          "div",
          { style: S.bar, role: "progressbar", "aria-label": `${label} ${tt("quota.used")} ${pct.toFixed(1)}%`, "aria-valuenow": pct.toFixed(1), "aria-valuemin": 0, "aria-valuemax": 100 },
          h("div", { style: { ...tone.fill, width: `${pct}%` } })
        ),
    // The counts and the reset stamp share ONE bottom row (counts left, reset
    // right) — two stacked rows would spend vertical space the bar already
    // paid for, and even a narrow twin card fits this pair. The counts need a
    // real fraction: a zero limit has none, and "已用 0 / 0" would read as a
    // measurement of a window the platform never sized.
    pct === null && resetLine === null
      ? null
      : h(
          "div",
          { style: S.quotaFoot },
          pct === null
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
    return h("div", { style: S.card }, h("div", { style: S.empty }, tt("quota.none")));
  }
  return h(
    "div",
    { style: S.card },
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
  return h(
    "div",
    null,
    catalogue.map((entry) => {
      const limits = entry.limits ?? {};
      const parts = [
        limits.requests5h !== undefined && limits.requests5h > 0 ? `${count(limits.requests5h)}${tt("quota.unit.requests")} / ${limits.requestsWindowH || 5}h` : "",
        limits.requestsWeekly !== undefined && limits.requestsWeekly > 0 ? `${count(limits.requestsWeekly)}${tt("quota.unit.requests")} / ${tt("quota.perWeek")}` : "",
        limits.imagesDaily !== undefined && limits.imagesDaily > 0 ? `${count(limits.imagesDaily)}${tt("quota.unit.images")} / ${tt("quota.perDay")}` : ""
      ].filter((part) => part !== "");
      return h(
        "div",
        { key: entry.uuid || String(entry.planId), style: S.catalogueRow },
        h("span", { style: S.catalogueName }, entry.displayName || entry.name || ""),
        h("span", { style: S.muted }, cycleLabel(entry.billingCycle, tt)),
        entry.priceMinor !== undefined && entry.priceMinor > 0 ? h("span", { style: S.muted }, money(entry.priceMinor, entry.currency)) : null,
        h("span", { style: S.catalogueLimits }, parts.join(" · "))
      );
    })
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
    { key: "requests", label: tt("quota.total.requests"), value: source.totalRequests },
    { key: "tokens", label: tt("quota.total.tokens"), value: source.totalTokens },
    { key: "images", label: tt("quota.total.images"), value: source.totalImages },
    { key: "video", label: tt("quota.total.video"), value: source.totalVideoSeconds },
    ...(typeof source.activeDays === "number" ? [{ key: "days", label: tt("quota.total.activeDays"), value: source.activeDays }] : [])
  ];
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
        h("span", { style: S.metricValue }, count(cell.value))
      ))
    )
  );
}

/**
 * Per-bucket consumption as a mini bar chart.
 *
 * The x axis is the platform's OWN bucket label, not a date this client
 * re-derives: the series endpoint takes dates and answers with whatever
 * granularity it chose, so re-formatting `bucket` would be the panel asserting
 * a granularity the platform never promised. Only the first and last labels are
 * printed — 30 daily bars cannot each carry a readable date, and every bar
 * carries its own `title` for the one the reader hovers.
 *
 * The bars are scaled to the LARGEST bucket, so the tallest always fills the
 * track; that answers "when was the heavy day", but the eye misreads a full
 * track as "at the limit", so the legend names the convention.
 */
export function UsageChart({ usage, tt }: { usage?: UsageData | null; tt: Tt }): unknown {
  const buckets = Array.isArray(usage?.buckets) ? usage.buckets : [];
  if (buckets.length === 0) {
    return h("div", { style: S.card }, h("div", { style: S.empty }, tt("usage.none")));
  }
  const values = buckets.map((bucket) => Math.max(0, Number(bucket?.requestCount) || 0));
  const max = Math.max(0, ...values);
  const first = String(buckets[0]?.bucket ?? "");
  const last = String(buckets[buckets.length - 1]?.bucket ?? "");
  return h(
    "div",
    { style: S.card },
    h(
      "div",
      { style: S.trendHead },
      h("span", { style: S.trendHeadLabel }, tt("usage.requests")),
      h("span", { style: { ...S.trendHeadLabel, textAlign: "right" } }, tt("usage.perBucket"))
    ),
    h(
      "div",
      { style: S.usageBars },
      buckets.map((bucket, index) => {
        const value = values[index];
        const pct = max > 0 ? ((value ?? 0) / max) * 100 : 0;
        const label = String(bucket?.bucket ?? "");
        return h(
          "div",
          {
            key: `${label}-${index}`,
            style: S.usageBar,
            title: `${label}: ${count(value)} ${tt("quota.unit.requests")}`
          },
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
      h("span", null, first),
      h("span", null, last)
    ),
    h("div", { style: S.trendLegend }, tt("usage.legend"))
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
