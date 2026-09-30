/**
 * Theme-token-only styles; a renamed token degrades looks, never rendering.
 * Verbatim from the pre-split `clientts`.
 */
export const S = {
  // The shell's center column is `display:flex; flex-direction:column;
  // overflow:hidden` — it never scrolls itself; every main-slot panel owns
  // its own scroll body. This root fills the column and clips; the pinned
  // header stays flex-none and `scroll` (flex:1, min-height:0) takes the
  // overflow. Without this chain the page grows past the column and the
  // shell silently truncates everything below the fold.
  page: { flex: "1 1 auto", height: "100%", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden", color: "var(--dsw-alias-label-primary)", fontSize: 14, lineHeight: "22px" },
  headerBar: { flex: "none", background: "var(--dsw-alias-bg-base)", position: "relative", zIndex: 1 },
  header: { display: "flex", alignItems: "center", gap: 12, maxWidth: 1040, margin: "0 auto", padding: "16px 32px 12px" },
  scroll: { flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" },
  content: { padding: "6px 32px 56px", maxWidth: 1040, margin: "0 auto" },
  title: { margin: 0, fontSize: 20, fontWeight: 600, lineHeight: "28px" },
  updated: { color: "var(--dsw-alias-label-secondary)", fontSize: 12 },
  spacer: { flex: 1 },
  button: { height: 30, padding: "0 12px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-primary)", fontSize: 13, cursor: "pointer" },
  sectionTitle: { margin: "22px 0 10px", fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-secondary)" },
  // Content sections are workbuddy-style collapsible cards: a bordered
  // card whose header is a full-width button (title + rotating chevron).
  // `PanelPage` starts both sections expanded; the reader can tuck one
  // away to focus on the other.
  sectionCard: { border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 12, background: "var(--dsw-alias-bg-layer-1)", overflow: "hidden", marginTop: 22 },
  sectionHead: { display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "12px 16px", background: "none", border: "none", cursor: "pointer", textAlign: "left" },
  sectionHeadTitle: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
  chevron: { display: "inline-flex", flex: "none", transition: "transform 0.15s ease", color: "var(--dsw-alias-label-secondary)" },
  chevronOpen: { transform: "rotate(180deg)" },
  sectionBody: { borderTop: "1px solid var(--dsw-alias-border-l1)", margin: "0 16px", padding: "12px 0 16px" },
  // Pool cards live in the responsive `poolsGrid` (gap owns the spacing),
  // so the card itself carries no bottom margin.
  card: { background: "var(--dsw-alias-bg-layer-1)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 12, padding: 16 },
  // Responsive deck of pool cards: each column is at least 320px and the
  // row reflows on narrow panels instead of overflowing.
  poolsGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 12, alignItems: "start" },
  cardHead: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  poolName: { fontSize: 15, fontWeight: 600 },
  chip: { display: "inline-flex", alignItems: "center", height: 22, padding: "0 8px", borderRadius: 999, fontSize: 12, border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-secondary)" },
  // The grant balance is money the user can still spend, so it reads as a
  // metric, not a decoration: right-aligned tabular figures on the card's
  // own line, no chip frame. A pill here gave a headline number the same
  // weight as the static type label beside it.
  grantChip: { display: "inline-flex", alignItems: "center", fontSize: 13, color: "var(--dsw-alias-label-primary)", fontVariantNumeric: "tabular-nums" },
  // The two quota windows sit side by side as twin sub-cards, stacking
  // when the card gets narrower than ~2*170px (170 leaves room for the
  // longest "used x / limit" caption beside the headline figures).
  quotas: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 170px), 1fr))", gap: 10, marginTop: 14 },
  // The twin quota windows float on a darker surface (layer-2) rather than
  // a third nested border: the section card owns the outer frame and the
  // pool card owns the inner one, so the sub-window reads by background
  // step alone. A border here made three equal-weight rectangles inside
  // each other and flattened the hierarchy it was meant to express.
  quota: { display: "flex", flexDirection: "column", gap: 8, minWidth: 0, padding: "12px 14px", borderRadius: 10, background: "var(--dsw-alias-bg-layer-2)" },
  // `flexWrap` because the reset stamp can grow to `MM-DD HH:mm`: in a narrow
  // twin column the label and the date no longer share a row, and the date is
  // the one part of the line that must never be clipped.
  quotaTop: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" },
  quotaLabel: { fontSize: 12, fontWeight: 500, color: "var(--dsw-alias-label-secondary)" },
  quotaReset: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" },
  quotaFigures: { display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 8 },
  // Remaining credits are the headline number — that is what the reader
  // opens the panel for. Tabular figures keep it still while polling.
  quotaRemaining: { fontSize: 24, lineHeight: "28px", fontWeight: 650, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" },
  quotaRemainLabel: { fontSize: 11, marginTop: 1, color: "var(--dsw-alias-label-secondary)" },
  quotaPct: { fontSize: 15, lineHeight: "20px", fontWeight: 600, textAlign: "right", fontVariantNumeric: "tabular-nums" },
  // used/limit is a single quiet caption under the bar (its own full row,
  // so the figures row never wraps on a narrow twin card).
  quotaUsed: { fontSize: 11, lineHeight: "15px", color: "var(--dsw-alias-label-secondary)", fontVariantNumeric: "tabular-nums" },
  bar: { height: 6, borderRadius: 3, background: "var(--dsw-alias-bg-layer-1)", overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 3, background: "var(--dsw-alias-brand-primary)" },
  barFillWarn: { background: "var(--dsw-alias-state-warn-primary)" },
  barFillError: { background: "var(--dsw-alias-state-error-primary)" },
  // Secondary bookkeeping (grant expiry, model coverage) folds away so a
  // card's open state is just its name, the twin quotas, and nothing else.
  details: { marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--dsw-alias-border-l1)" },
  detailsSummary: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", cursor: "pointer", userSelect: "none" },
  detailsBody: { display: "flex", flexDirection: "column", gap: 10, marginTop: 10 },
  grant: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
  models: { display: "flex", flexWrap: "wrap", gap: 6 },
  modelTag: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 11, padding: "2px 6px", borderRadius: 6, background: "var(--dsw-alias-bg-layer-2)", border: "1px solid var(--dsw-alias-border-l1)" },
  // The per-model consumption card: a label row over one horizontal-bar
  // row per model. The bar is relative to the LARGEST consumer — the
  // chart answers "which model is burning credits" — so the top model
  // fills the track and the rest shrink proportionally; the absolute
  // number stays right-aligned beside the model name.
  trendHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, paddingBottom: 6, borderBottom: "1px solid var(--dsw-alias-border-l1)" },
  trendHeadLabel: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", fontWeight: 500 },
  trendRow: { display: "flex", flexDirection: "column", gap: 8, padding: "10px 0", borderBottom: "1px solid var(--dsw-alias-border-l1)" },
  trendRowHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, minWidth: 0 },
  trendModel: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  trendCredits: { fontSize: 13, fontWeight: 600, fontVariantNumeric: "tabular-nums" },
  // The trend card sits on layer-1 like the pool cards, so its bar track
  // must be layer-2 (the quota bars invert this: layer-1 inside layer-2).
  trendBar: { height: 6, borderRadius: 3, background: "var(--dsw-alias-bg-layer-2)", overflow: "hidden" },
  // The legend under the bars: quiet secondary text, lifted a little off
  // the last row's divider so it reads as a caption, not another data row.
  trendLegend: { marginTop: 10, fontSize: 11, lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" },
  muted: { color: "var(--dsw-alias-label-secondary)" },
  error: { color: "var(--dsw-alias-state-error-primary)" },
  note: { marginTop: 24, color: "var(--dsw-alias-label-secondary)", fontSize: 12, lineHeight: "18px" },
  empty: { color: "var(--dsw-alias-label-secondary)", padding: "18px 0" },
  field: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 },
  fieldLabel: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
  input: {
    height: 32, padding: "0 10px", borderRadius: 8, fontSize: 13,
    border: "1px solid var(--dsw-alias-border-l2)",
    background: "var(--dsw-alias-bg-layer-1)",
    color: "var(--dsw-alias-label-primary)"
  },
  /** Real shell tokens — replaces the color-mix hack that faked "on-primary". */
  primary: {
    height: 32, padding: "0 16px", borderRadius: 8, fontSize: 13, fontWeight: 500,
    border: "1px solid var(--dsw-alias-border-l2)",
    background: "var(--dsw-alias-button-primary-fill)",
    color: "var(--dsw-alias-label-primary-foreground)", cursor: "pointer"
  },
  primaryHover: { background: "var(--dsw-alias-button-primary-hover)" },
  primaryBusy: { opacity: 0.6, cursor: "default" },
  formError: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12, margin: "10px 0 0" },
  formNote: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, margin: "10px 0 0" },
  // The model picker: a search box and a all/none row over one row per
  // model, each row a checkbox, the name, and a modality badge. Rows sit
  // in their own card so the list can grow past a screen without pushing
  // the rest of the panel out of view.
  rosterTools: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 },
  rosterCount: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", fontVariantNumeric: "tabular-nums", marginLeft: "auto" },
  modelList: { display: "flex", flexDirection: "column", gap: 6, margin: 0, padding: 0, listStyle: "none" },
  modelRow: { display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 10, border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-layer-2)" },
  modelRowOff: { opacity: 0.55 },
  modelCheck: { flex: "none", width: 15, height: 15, cursor: "pointer", accentColor: "var(--dsw-alias-brand-primary)", margin: 0 },
  modelName: { flex: "1 1 auto", minWidth: 0, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  modelBadge: { flex: "none", fontSize: 11, padding: "1px 7px", borderRadius: 999, border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-secondary)" },
  rosterFoot: { display: "flex", gap: 8, alignItems: "center", marginTop: 10 }
};
