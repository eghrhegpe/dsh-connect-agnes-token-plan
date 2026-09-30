/**
 * The panel's rendered output, checked against the code the browser loads.
 *
 * The decision tests assert WHICH view renders; nothing asserted WHAT that
 * view says. The known blind spot was a numeric swap — a `WindowRow` that
 * renders `limit/used` instead of `used/limit`, or drops the remaining
 * figure, passed the whole suite. These checks feed arithmetic the reader can
 * verify by hand (12345 of 60000 is 20.575%) into the panel's REAL rendering
 * components and inspect what would reach the screen.
 *
 * There is no DOM and no React here: `panel-render.js` lifts the components
 * out of client.js and evaluates them with a recording `h`, so function
 * components stay uncalled until a check expands them — the tree a check sees
 * is the tree React would receive.
 */
import { render, styles as S, texts, findElement, findAll } from "./panel-render.js";
import { surface } from "./client-surface.js";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}

/** Identity dictionary: assertions are about WHICH key applies, not its text. */
const tt = (key) => key;

/** Render a lifted component to its element tree (function components uncalled). */
const treeOf = (component, props) => component(props);

/** Collect the text a rendered component would put on screen. */
const rendered = (component, props) => texts(treeOf(component, props));

/** The panel's progress-bar element, wherever it sits in the tree. */
const bar = (tree) => findElement(tree, (props) => props["aria-valuenow"] !== undefined);

// === A. the quota card's arithmetic is the one the reader can verify ======
// 12345 of 60000 is 20.575%. Any swap of used/limit/remaining turns these
// figures into different numbers, so this block is the anti-mirror for the
// exact bug the decision tests could not see.
{
  const tree = treeOf(render.QuotaCard, {
    label: "pool.window5h",
    window: { limit: 60000, used: 12345, remaining: 47655, resetAt: 1800000000 },
    tt
  });
  const meta = texts(tree).join("\n");
  check("the used figure is the USED count against the limit",
    meta.includes("pool.used 12,345 / 60,000"), meta);
  check("the headline figure is the REMAINING count, labelled as such",
    meta.includes("47,655") && meta.includes("pool.remaining"), meta);
  check("the percentage is used over limit", meta.includes("20.6%"), meta);

  const fill = bar(tree);
  check("the bar reports the same percentage to assistive tech",
    Number(fill?.props["aria-valuenow"]) === 20.6, String(fill?.props["aria-valuenow"]));
  const inner = findElement(fill, (props) => typeof props.style?.width === "string");
  check("the bar's width is the same fraction the text shows",
    inner?.props.style.width === "20.575%", String(inner?.props.style.width));
  check("the reset time is rendered when present", meta.includes("pool.reset"), meta);
}

// === B. a window without a reset time stays quiet about resets ============
{
  const out = rendered(render.QuotaCard, {
    label: "pool.window7d",
    window: { limit: 60000, used: 1, remaining: 59999, resetAt: null },
    tt
  });
  check("no reset time means no reset line", !out.includes("pool.reset"), out.join("\n"));
}

// === C. the bar's tone escalates as the window fills ======================
// The thresholds live in the client (70 warn / 90 error); a check hard-coding
// a colour would pass a tone swap. The values come from the lifted S instead.
{
  const fillFor = (used) => {
    const fill = bar(treeOf(render.QuotaCard, {
      label: "l", window: { limit: 60000, used, remaining: 60000 - used, resetAt: null }, tt
    }));
    return findElement(fill, (p) => typeof p.style?.width === "string")?.props.style;
  };
  check("an ordinary window uses the brand fill",
    fillFor(30000).background === S.barFill.background, JSON.stringify(fillFor(30000)));
  check("past 70% the bar turns to the warn fill",
    fillFor(42000).background === S.barFillWarn.background, JSON.stringify(fillFor(42000)));
  check("past 90% the bar turns to the error fill",
    fillFor(54000).background === S.barFillError.background, JSON.stringify(fillFor(54000)));
}

// === D. an empty limit is 0%, never NaN ===================================
{
  const tree = treeOf(render.QuotaCard, {
    label: "l", window: { limit: 0, used: 0, remaining: 0, resetAt: null }, tt
  });
  check("a zero limit renders as 0.0%", texts(tree).includes("0.0%"), texts(tree).join("\n"));
  check("the bar's reported value stays a number",
    bar(tree)?.props["aria-valuenow"] !== undefined && Number(bar(tree)?.props["aria-valuenow"]) === 0,
    String(bar(tree)?.props["aria-valuenow"]));
}

// === E. the trend table lists rows in order, with the credited amounts ====
{
  const out = rendered(render.TrendTable, {
    trend: { models: [{ model: "Alpha", credits: 42.5 }, { model: "Beta", credits: 0 }] },
    tt
  });
  const alpha = out.indexOf("Alpha");
  check("the table carries both models", alpha !== -1 && out.includes("Beta"), out.join("\n"));
  check("row order follows the data", alpha !== -1 && alpha < out.indexOf("42.5") && out.indexOf("42.5") < out.indexOf("Beta"),
    out.join("\n"));
  check("a zero-credit row still renders", out.includes("0"), out.join("\n"));
  check("the table is a table, not the empty note", !out.includes("trend.none"), out.join("\n"));
}

// === E2. the trend card visualises which model consumed the most ========
// The bare table earned a card and a per-row bar: each bar is relative to
// the LARGEST consumer, so the top model fills the track and the rest
// shrink proportionally — that is the "who is burning credits" answer.
{
  const tree = treeOf(render.TrendTable, {
    trend: { models: [{ model: "Alpha", credits: 42.5 }, { model: "Beta", credits: 0 }] },
    tt
  });
  check("the trend rows sit inside a card like the quota cards",
    tree.props?.style?.background === S.card.background && tree.props?.style?.borderRadius === S.card.borderRadius,
    JSON.stringify(tree.props?.style ?? {}));
  const bars = findAll(tree, (props) => props["aria-valuenow"] !== undefined);
  check("each model row carries its own bar", bars.length === 2, `found ${bars.length}`);
  const widths = bars.map((bar) => findElement(bar, (p) => typeof p.style?.width === "string")?.props.style?.width);
  check("the biggest consumer fills the track", widths.includes("100%"), JSON.stringify(widths));
  check("a zero-credit model gets an empty track", widths.includes("0%"), JSON.stringify(widths));
  check("the bars report the same fractions to assistive tech",
    bars[0]?.props["aria-valuenow"] === 100 && bars[1]?.props["aria-valuenow"] === 0,
    bars.map((bar) => bar.props["aria-valuenow"]).join(", "));
  check("the absolute amount still sits beside the model name",
    texts(tree).includes("42.5") && texts(tree).includes("0"), texts(tree).join("\n"));
}

// === F. an empty trend says so instead of rendering an empty table ========
{
  const out = rendered(render.TrendTable, { trend: { models: [] }, tt });
  check("an empty trend shows the empty note", out.includes("trend.none"), out.join("\n"));
  const none = rendered(render.TrendTable, { trend: null, tt });
  check("a missing trend shows the empty note too", none.includes("trend.none"), none.join("\n"));
  const emptyTree = treeOf(render.TrendTable, { trend: { models: [] }, tt });
  check("the empty note sits inside a card too",
    emptyTree.props?.style?.background === S.card.background, JSON.stringify(emptyTree.props?.style ?? {}));
}

// === G. the pool card assembles its own sections ==========================
{
  const pool = {
    name: "通用池", poolType: "default",
    modelIds: ["Model-A", "Model-B"],
    lockedModels: ["Model-C"],
    window5h: { limit: 60000, used: 1, remaining: 59999, resetAt: null },
    window7d: { limit: 600000, used: 2, remaining: 599998, resetAt: null },
    grantBalance: 0
  };
  const out = rendered(render.PoolCard, { pool, tt });
  check("the pool's name is rendered", out.includes("通用池"), out.join("\n"));
  check("a default pool is labelled as such", out.includes("pool.default"), out.join("\n"));
  check("both quota windows are present",
    out.includes("pool.window5h") && out.includes("pool.window7d"), out.join("\n"));
  check("the fold carries the details summary", out.includes("pool.details"), out.join("\n"));
  check("every callable model is listed (inside the fold)",
    out.includes("Model-A") && out.includes("Model-B"), out.join("\n"));
  check("locked models are summarised, not listed", out.includes("pool.locked") && !out.includes("Model-C"),
    out.join("\n"));
  check("no grant text when the balance is zero", !out.includes("pool.grant"), out.join("\n"));

  const dedicated = rendered(render.PoolCard, { pool: { ...pool, poolType: "dedicated" }, tt });
  check("a dedicated pool is labelled as such", dedicated.includes("pool.dedicated"), dedicated.join("\n"));

  const granted = rendered(render.PoolCard, { pool: { ...pool, grantBalance: 500 }, tt });
  check("a grant balance is rendered when present", granted.includes("pool.grant"), granted.join("\n"));

  // `callableModels` (the /v1/models truth) outranks `modelIds` (the plan's
  // list): a model the plan covers but this key cannot call is NOT callable.
  const scoped = rendered(render.PoolCard, {
    pool: { ...pool, callableModels: ["Model-A"] }, tt
  });
  check("the callable list wins over the plan list",
    scoped.includes("Model-A") && !scoped.includes("Model-B"), scoped.join("\n"));
}

// === G2. sections are collapsible card headers, expanded by default ======
// The two content sections live behind a workbuddy-style card header: a
// full-width button (title + rotating chevron) that tucks the body away.
// The header is hook-free — `open`/`onToggle` arrive as props — so the
// toggle is exercised here; `PanelPage` starts both sections expanded.
{
  const children = ["inner"];
  const openTree = treeOf(render.SectionCard, {
    title: "section.pools", open: true, onToggle: () => {}, tt, children
  });
  check("the section sits in a card like the quota cards",
    openTree.props?.style?.background === S.card.background && openTree.props?.style?.borderRadius === S.card.borderRadius,
    JSON.stringify(openTree.props?.style ?? {}));
  const head = findElement(openTree, (props) => props["aria-expanded"] !== undefined);
  check("the section header is a real button", head?.type === "button", String(head?.type));
  check("an open section reports aria-expanded=true", head?.props["aria-expanded"] === true,
    String(head?.props["aria-expanded"]));
  check("the header announces the collapse action",
    head?.props["aria-label"] === "section.collapse: section.pools", String(head?.props["aria-label"]));
  check("the header hands the click to the toggle", typeof head?.props.onClick === "function", "");
  check("an open section renders its body", texts(openTree).includes("inner"), texts(openTree).join("\n"));
  check("an open body is not hidden",
    findElement(openTree, (props) => props.hidden !== undefined)?.props.hidden === false, "");
  const chev = findElement(openTree, (props) => typeof props.viewBox === "string");
  check("the header carries a chevron", chev !== null, "");
  check("the chevron flips when the section is open",
    chev?.props.style?.transform === "rotate(180deg)", String(chev?.props.style?.transform));

  const closedTree = treeOf(render.SectionCard, {
    title: "section.trend", open: false, onToggle: () => {}, tt, children
  });
  const closedHead = findElement(closedTree, (props) => props["aria-expanded"] !== undefined);
  check("a closed section reports aria-expanded=false", closedHead?.props["aria-expanded"] === false,
    String(closedHead?.props["aria-expanded"]));
  check("the header announces the expand action",
    closedHead?.props["aria-label"] === "section.expand: section.trend", String(closedHead?.props["aria-label"]));
  check("a closed section hides its body", !texts(closedTree).includes("inner"), texts(closedTree).join("\n"));
  check("the body stays mounted but hidden when closed",
    findElement(closedTree, (props) => props.hidden !== undefined)?.props.hidden === true, "");
  const closedChev = findElement(closedTree, (props) => typeof props.viewBox === "string");
  check("the chevron points down when the section is closed",
    closedChev?.props.style?.transform === undefined, String(closedChev?.props.style?.transform));
}

// === G3. the step-three provider status is secret-free and stateful ======
// ProviderStatus is the hook-free half of the API-key section: it must say
// where the key came from WITHOUT carrying the key, and distinguish the four
// registration states (off / registered / no llm service / failed). These
// render with the REAL zh dictionary: the identity `tt` returns the key
// itself, which carries no `{placeholder}` to expand, so composition (the
// counts, the id, the source) could not be checked through it.
{
  const zh = surface.dictionaries.zh;
  const ttZh = (key) => zh[key] ?? key;

  check("no llm block renders nothing",
    rendered(render.ProviderStatus, { llm: null, tt }).length === 0
      && rendered(render.ProviderStatus, { llm: "x", tt }).length === 0);

  const off = rendered(render.ProviderStatus, {
    llm: { hasApiKey: false, keySource: null, ephemeral: false, registerProvider: false,
      llmAvailable: false, providerRegistered: false, providerId: "sensenova-token-plan" },
    tt: ttZh
  });
  check("no key asks for one", off.some((line) => line.includes(zh["llm.noKey"])), off.join("\n"));
  check("the opt-in being off is stated",
    off.some((line) => line.includes("未向 DSH 注册") && line.includes("开关")), off.join("\n"));
  check("the provider id is shown",
    off.some((line) => line.includes("sensenova-token-plan")), off.join("\n"));

  const registered = rendered(render.ProviderStatus, {
    llm: { hasApiKey: true, keySource: "credentials", ephemeral: false, registerProvider: true,
      llmAvailable: true, providerRegistered: true, providerId: "sensenova-token-plan",
      modelCount: 3, visionCount: 1,
      // A defensive field the Host never sends: it must never reach the screen.
      value: "sk-secret-value" },
    tt: ttZh
  });
  check("a stored key reports the credentials source",
    registered.some((line) => line.includes(zh["llm.src.credentials"])), registered.join("\n"));
  check("the registered line carries both counts and the id",
    registered.some((line) => line.includes("3") && line.includes("1")
      && line.includes("sensenova-token-plan")), registered.join("\n"));
  check("the key value itself never renders",
    !registered.some((line) => line.includes("sk-secret-value")), registered.join("\n"));
  check("ephemeral is quiet when a credentials service exists",
    !registered.some((line) => line.includes(zh["llm.ephemeral"])));

  const fromEnv = rendered(render.ProviderStatus, {
    llm: { hasApiKey: true, keySource: "env", ephemeral: true, registerProvider: true,
      llmAvailable: true, providerRegistered: true, providerId: "p", modelCount: 0, visionCount: 0 },
    tt: ttZh
  });
  check("an environment key reports the environment source",
    fromEnv.some((line) => line.includes(zh["llm.src.env"])), fromEnv.join("\n"));
  check("an ephemeral host says so",
    fromEnv.some((line) => line.includes(zh["llm.ephemeral"])), fromEnv.join("\n"));

  const noService = rendered(render.ProviderStatus, {
    llm: { hasApiKey: true, keySource: "credentials", registerProvider: true,
      llmAvailable: false, providerRegistered: false, providerId: "p" },
    tt: ttZh
  });
  check("enabled without an llm service says so",
    noService.some((line) => line.includes(zh["llm.noService"])), noService.join("\n"));

  const failed = rendered(render.ProviderStatus, {
    llm: { hasApiKey: true, keySource: "credentials", registerProvider: true,
      llmAvailable: true, providerRegistered: false, providerId: "p", providerError: "DUPLICATE_ADAPTER" },
    tt: ttZh
  });
  check("a failed registration shows the error line",
    failed.some((line) => line.includes("DUPLICATE_ADAPTER")), failed.join("\n"));
}

// === G4. the model roster: which rows exist, and which are ticked ==========
// The picker's rows are the single source of truth for "what could this key be
// pushed": a curated id that no longer exists must never become a checkbox, and
// each checkbox state must be exactly what the Host's allow-list says. The row
// is hook-free, so the render suite drives the real one.
{
  const zh = surface.dictionaries.zh;
  const ttZh = (key) => zh[key] ?? key;
  const roster = [
    { id: "nova-flash-lite", name: "Nova Flash Lite", vision: false },
    { id: "nova-vl", name: "Nova VL", vision: true },
    { id: "nova-pro", name: "Nova Pro", vision: false }
  ];
  const treeOfRoster = (enabledIds, extra = {}) =>
    treeOf(render.ModelRoster, { models: roster, enabledIds, tt: ttZh, ...extra });
  const boxes = (tree) => findAll(tree, (props) => props.type === "checkbox").map((el) => el.props);

  const allOn = treeOfRoster([]);
  const allOnTexts = texts(allOn);
  check("every catalogue entry becomes one tickable row", boxes(allOn).length === 3,
    `found ${boxes(allOn).length} checkboxes`);
  check("row order follows the catalogue, not the allow-list",
    (() => {
      const flat = texts(allOn).join(" ");
      const a = flat.indexOf("Nova Flash Lite");
      const b = flat.indexOf("Nova VL");
      const c = flat.indexOf("Nova Pro");
      return a !== -1 && b !== -1 && c !== -1 && a < b && b < c;
    })(), texts(allOn).join("\n"));
  check("an empty allow-list ticks every model",
    JSON.stringify(boxes(allOn).map((props) => props.checked)) === JSON.stringify([true, true, true]),
    JSON.stringify(boxes(allOn).map((props) => props.checked)));

  const partial = treeOfRoster(["nova-pro", "nova-vl"]);
  check("a curated allow-list ticks exactly those models, in row order",
    JSON.stringify(boxes(partial).map((props) => props.checked)) === JSON.stringify([false, true, true]),
    JSON.stringify(boxes(partial).map((props) => props.checked)));

  const none = treeOfRoster([surface.helpers.HIDE_ALL_MODELS]);
  check("the hide-all sentinel unticks every model",
    JSON.stringify(boxes(none).map((props) => props.checked)) === JSON.stringify([false, false, false]),
    JSON.stringify(boxes(none).map((props) => props.checked)));

  const visionLines = texts(allOn).filter((line) => line === zh["llm.rosterVision"]);
  const textLines = texts(allOn).filter((line) => line === zh["llm.rosterText"]);
  check("one vision model earns one vision badge", visionLines.length === 1, String(visionLines.length));
  check("the two text-only models earn text-only badges", textLines.length === 2, String(textLines.length));
  check("an unticked row keeps its modality badge",
    texts(none).filter((line) => line === zh["llm.rosterVision"]).length === 1);

  const busy = treeOfRoster(["nova-vl"], { busy: true });
  check("a save in flight disables every checkbox",
    boxes(busy).every((props) => props.disabled === true),
    JSON.stringify(boxes(busy).map((props) => props.disabled)));
  check("an idle roster leaves the checkboxes live",
    boxes(allOn).every((props) => props.disabled !== true));

  // Each box hands its edit back to the picker; without the callback a row is
  // display-only and the allow-list could not be changed one model at a time.
  const withToggle = treeOfRoster(["nova-vl"], { onToggle: (id) => id });
  const toggles = boxes(withToggle).map((props) => props.onChange);
  check("every checkbox carries its edit handler",
    toggles.length === 3 && toggles.every((fn) => typeof fn === "function"),
    JSON.stringify(toggles.map((fn) => typeof fn)));
  check("a roster without a handler stays display-only",
    boxes(allOn).every((props) => props.onChange === undefined));

  check("a checkbox announces the model name to assistive tech",
    JSON.stringify(boxes(allOn).map((props) => props["aria-label"])) === JSON.stringify(["Nova Flash Lite", "Nova VL", "Nova Pro"]),
    JSON.stringify(boxes(allOn).map((props) => props["aria-label"])));

  check("a missing display name falls back to the id",
    texts(treeOf(render.ModelRoster, { models: [{ id: "nova-bare" }], enabledIds: [], tt })).includes("nova-bare"),
    texts(treeOf(render.ModelRoster, { models: [{ id: "nova-bare" }], enabledIds: [], tt })).join("\n"));

  check("a curated id that is no longer in the catalogue draws no row",
    boxes(treeOf(render.ModelRoster, { models: roster, enabledIds: ["ghost-model"], tt })).length === 3,
    String(boxes(treeOf(render.ModelRoster, { models: roster, enabledIds: ["ghost-model"], tt })).length));

  check("an empty catalogue draws no rows at all",
    boxes(treeOf(render.ModelRoster, { models: [], enabledIds: [], tt })).length === 0);

  check("a junk models value reads as an empty catalogue",
    boxes(treeOf(render.ModelRoster, { models: "nope", enabledIds: [], tt })).length === 0);
}

// === G5. the exhaustion notice explains WHY models vanish and WHEN back ===
// When a pool hits zero the host drops its models from the picker; without this
// line the reader sees models disappear with no cause or recovery expectation.
// The component is hook-free and reads only the snapshot's pools, so the render
// suite drives the real one. It must stay silent when nothing is exhausted, and
// must surface the EARLIEST reset among the exhausted windows.
{
  const zh = surface.dictionaries.zh;
  const ttZh = (key) => zh[key] ?? key;
  const when = surface.helpers.when;

  const clean = rendered(render.PoolExhaustionNotice, { pools: { pools: [
    { window5h: { limit: 100, used: 1, remaining: 99, resetAt: null }, window7d: { limit: 100, used: 1, remaining: 99, resetAt: null } }
  ] }, tt: ttZh });
  check("a fully-stocked plan renders no exhaustion notice", clean.length === 0, clean.join("\n"));

  const exhausted = rendered(render.PoolExhaustionNotice, { pools: { pools: [
    { window5h: { limit: 100, used: 100, remaining: 0, resetAt: 1800003600 },
      window7d: { limit: 100, used: 1, remaining: 99, resetAt: null } }
  ] }, tt: ttZh });
  check("an exhausted pool surfaces the notice",
    exhausted.some((line) => line.includes("部分积分池已耗尽") && line.includes("暂不可选")), exhausted.join("\n"));
  check("the notice carries the earliest reset time",
    exhausted.some((line) => line.includes(when(1800003600))), exhausted.join("\n"));
  check("the notice is marked as a status role for assistive tech",
    treeOf(render.PoolExhaustionNotice, { pools: { pools: [
      { window5h: { limit: 100, used: 100, remaining: 0, resetAt: 1800003600 }, window7d: { limit: 100, used: 1, remaining: 99, resetAt: null } }
    ] }, tt: ttZh })?.props?.role === "status");

  // Two exhausted windows across pools: the EARLIEST reset wins, not the latest.
  const two = rendered(render.PoolExhaustionNotice, { pools: { pools: [
    { window5h: { limit: 100, used: 100, remaining: 0, resetAt: 1800007200 }, window7d: { limit: 100, used: 1, remaining: 99, resetAt: null } },
    { window5h: { limit: 100, used: 1, remaining: 99, resetAt: null }, window7d: { limit: 100, used: 100, remaining: 0, resetAt: 1800003600 } }
  ] }, tt: ttZh });
  check("the earliest of multiple exhausted resets is shown",
    two.some((line) => line.includes(when(1800003600))) && !two.some((line) => line.includes(when(1800007200))),
    two.join("\n"));
}

// === G6. a zeroed quota window is labelled "已耗尽", not just 0 ============
// The bare "0 / 100%" left the reader to infer exhaustion; a chip names it, and
// the reset line is suppressed on that window (the notice above carries recovery).
{
  const zh = surface.dictionaries.zh;
  const ttZh = (key) => zh[key] ?? key;
  const when = surface.helpers.when;
  const tree = treeOf(render.QuotaCard, {
    label: "pool.window5h",
    window: { limit: 100, used: 100, remaining: 0, resetAt: 1800003600 },
    tt: ttZh
  });
  check("a zeroed window is labelled 已耗尽",
    texts(tree).includes(zh["pool.exhausted"]), texts(tree).join("\n"));
  // The reset line must NOT appear on the exhausted window (the notice owns it).
  check("the exhausted window does not also print its own reset line",
    !texts(tree).includes(zh["pool.reset"]), texts(tree).join("\n"));

  const ok = treeOf(render.QuotaCard, {
    label: "pool.window7d",
    window: { limit: 100, used: 1, remaining: 99, resetAt: 1800003600 },
    tt: ttZh
  });
  check("a non-zero window keeps its reset line and no exhausted chip",
    texts(ok).includes(zh["pool.reset"].replace("{time}", when(1800003600))) && !texts(ok).includes(zh["pool.exhausted"]),
    texts(ok).join("\n"));
  // 1800003600 is 2027-01-15 17:00 local, months from now, so the day must
  // travel with the time. The old assertion pinned the bare "重置 17:00", which
  // read as "resets later TODAY" — the weekly-reset bug.
  check("a cross-day weekly reset carries its MM-DD date",
    texts(ok).join("\n").includes("01-15 17:00") && !texts(ok).join("\n").includes("重置 17:00"),
    texts(ok).join("\n"));
}

// === G7. a reset clock that crosses midnight carries its day ==============
// `clock` yields HH:MM only. That is honest for the 5-hour window, but it
// rendered the WEEKLY reset — an absolute instant days away — as "重置 18:10",
// which reads as "today at 18:10". `when` keeps the compact form on the current
// local day and adds the MM-DD date once the instant falls on another day.
{
  const when = surface.helpers.when;
  const pad = (value) => String(value).padStart(2, "0");
  // A local instant `daysOut` days from now, at hour:minute.
  const at = (daysOut, hour, minute) => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysOut, hour, minute).getTime() / 1000;
  };

  check("a reset still due today stays a compact HH:MM", when(at(0, 18, 10)) === "18:10", when(at(0, 18, 10)));

  const tomorrow = at(1, 18, 10);
  const tomorrowDate = new Date(tomorrow * 1000);
  check("a reset on another day carries its MM-DD date",
    when(tomorrow) === `${pad(tomorrowDate.getMonth() + 1)}-${pad(tomorrowDate.getDate())} 18:10`,
    when(tomorrow));

  check("a far-off weekly reset still carries its MM-DD date",
    when(1800003600) === "01-15 17:00", when(1800003600));

  check("a junk reset time degrades to the em dash",
    when(null) === "—" && when(0) === "—" && when(-1) === "—",
    `${when(null)}|${when(0)}|${when(-1)}`);

  // The card and the notice agree with the helper they share.
  const zh = surface.dictionaries.zh;
  const ttZh = (key) => zh[key] ?? key;
  const weeklyCard = texts(treeOf(render.QuotaCard, {
    label: "pool.window7d",
    window: { limit: 100, used: 1, remaining: 99, resetAt: 1800003600 },
    tt: ttZh
  })).join(" ");
  check("the weekly quota card prints the date-aware reset",
    weeklyCard.includes(`重置 ${when(1800003600)}`), weeklyCard);

  const notice = rendered(render.PoolExhaustionNotice, { pools: { pools: [
    { window5h: { limit: 100, used: 1, remaining: 99, resetAt: null },
      window7d: { limit: 100, used: 100, remaining: 0, resetAt: 1800003600 } }
  ] }, tt: ttZh });
  check("the exhaustion notice carries the same date-aware weekly reset",
    notice.some((line) => line.includes(when(1800003600))), notice.join("\n"));
}

// === G8. a drifted payload degrades to a line, never a crash ==============
// The Host flags top-level shape drift but still passes the data through, so
// a pool row whose window is absent — or a trend block with no models — must
// render nothing/empty instead of throwing and blanking the whole panel. One
// malformed pool must not take the quota view (and its shape warning) down.
{
  const zh = surface.dictionaries.zh;
  const ttZh = (key) => zh[key] ?? key;

  check("a quota window that is not an object renders nothing",
    texts(treeOf(render.QuotaCard, { label: "pool.window5h", window: null, tt: ttZh })).length === 0
      && texts(treeOf(render.QuotaCard, { label: "pool.window5h", window: undefined, tt: ttZh })).length === 0,
    texts(treeOf(render.QuotaCard, { label: "pool.window5h", window: null, tt: ttZh })).join("\n"));

  const barePool = rendered(render.PoolCard, {
    pool: { name: "通用池", poolType: "default", grantBalance: 0 }, tt: ttZh
  });
  check("a pool missing both windows still renders its identity",
    barePool.includes("通用池") && barePool.includes(zh["pool.default"]), barePool.join("\n"));

  const emptyTrend = rendered(render.TrendTable, { trend: {}, tt: ttZh });
  check("a trend block without models shows the empty note, not a crash",
    emptyTrend.includes(zh["trend.none"]), emptyTrend.join("\n"));
}

// === H. the rendering came from the shipped client ========================
// Reaching here means every extraction marker was found. These checks pin the
// lifted pieces themselves, so a refactor that silently empties one of them
// cannot read as a green suite.
{
  check("the style tokens were lifted from the client", S.card?.borderRadius === 12 && S.bar?.height === 6,
    JSON.stringify(S.card ?? {}));
  check("the number formatter was lifted", render.PoolCard instanceof Function && render.TrendTable instanceof Function
    && render.QuotaCard instanceof Function);
  check("count renders its input unchanged for small numbers",
    rendered(render.TrendTable, { trend: { models: [{ model: "m", credits: 12.345 }] }, tt }).includes("12.35"),
    "count(12.345) should round to 2 places");

  // === H2. the first frame says "loading", not "sign in" ==================
  // `viewOf(null, null)` reads as needsSetup, so the OLD PanelPage rendered
  // AccountForm for the whole first poll — `panel.loading` was dead code, and
  // a configured user saw the sign-in form flash on every mount. The
  // `loadedOnce` gate (set in the load's finally) is invisible to `viewOf`;
  // only driving the mounted page proves the gate is wired. The stand-in
  // returns useState's INITIAL value, so this is the true first frame.
  {
    const firstFrame = rendered(render.PanelPage, {
      onClose: () => {}, tt, localeSubscribe: undefined
    });
    check("the first frame shows the loading line", firstFrame.includes("panel.loading"),
      firstFrame.join("\n"));
    check("the first frame does NOT show the sign-in form", !firstFrame.includes("auth.title"),
      firstFrame.join("\n"));
  }
}

// === I. the decision table: every wire code gets an answer ================
// `viewOf` is a deliberate copy of the Host's taxonomy and nothing else in the
// suite drove it, so a code added to `codes.js` and forgotten here — or a
// guidance value pointing at a dictionary key that does not exist — read as a
// green suite. The last loop is what keeps the copy honest: a bad key would
// render the key itself on screen.
{
  const { viewOf, errorOfStatus, dictionaries, tables } = surface;
  const viewOfCode = (code, message = "an error") =>
    viewOf(null, { message, code, auth: null }, tt);

  // A non-2xx snapshot response carries no body, so the status code is the only
  // clue. 401/403 must read as "the token is gone" and keep the sign-in form on
  // screen; anything else stays a plain transport string.
  for (const status of [401, 403]) {
    const rejected = errorOfStatus(status);
    check(`HTTP ${status} reads as an expired token`,
      rejected.code === "jwt_expired" && rejected.message === `HTTP ${status}` && rejected.auth === null,
      JSON.stringify(rejected));
    const rejectedView = viewOf(null, rejected, tt);
    check(`HTTP ${status} still reaches the sign-in form`,
      rejectedView.needsSetup === true && rejectedView.guidanceKey === "panel.jwtExpired",
      String(rejectedView.guidanceKey));
  }
  for (const status of [408, 429, 500, 503]) {
    check(`HTTP ${status} stays a plain transport string`,
      errorOfStatus(status) === `HTTP ${status}`, String(errorOfStatus(status)));
  }

  // The console not answering is the code this table used to have no line for:
  // the sign-in form was correctly withheld, but the reader was left with a
  // bare error string that implied a permanent failure.
  const consoleDown = viewOfCode("console_error");
  check("a console outage has its own guidance line",
    consoleDown.guidanceKey === "panel.consoleTransient", String(consoleDown.guidanceKey));
  check("a console outage does not offer the sign-in form",
    consoleDown.needsSetup === false);

  check("an expired token still names the renewal failure",
    viewOfCode("jwt_expired").guidanceKey === "panel.jwtExpired",
    String(viewOfCode("jwt_expired").guidanceKey));
  check("an unconfigured host still reaches the sign-in form",
    viewOfCode("not_configured").guidanceKey === "panel.jwtMissing"
      && viewOfCode("not_configured").needsSetup === true);

  // Every code the form must not answer to is one the table can explain.
  for (const code of tables.FORM_EXCLUDED_CODES) {
    check(`the form-excluded code ${code} keeps the form hidden`,
      viewOfCode(code).needsSetup === false);
  }

  // A guidance value is a dictionary key, in both languages.
  for (const [code, key] of Object.entries(tables.GUIDANCE_BY_CODE)) {
    check(`guidance for ${code} resolves to real text in both languages`,
      typeof dictionaries.zh[key] === "string" && typeof dictionaries.en[key] === "string", key);
  }

  // No code at all still means "the account is the answer", never a dead end.
  check("a transport failure keeps the sign-in form reachable",
    viewOf(null, "network down", tt).needsSetup === true);
  check("an unrecognised code keeps the sign-in form reachable",
    viewOfCode("some_new_code").needsSetup === true);
}

// === G6. the draw switch section is rendered and says which state it is in
// DrawSwitch is hook-based (like ProviderSwitch), so the render suite cannot
// mount it; what IS exercised here is that the component is exported by the
// shipped surface and that a snapshot with `llm.drawEnabled` flowing through
// still renders the pools view without crashing.
{
  check("the draw switch component is exported by the client surface",
    typeof render.DrawSwitch === "function", String(typeof render.DrawSwitch));
  check("the draw section's dictionary keys exist in zh",
    typeof surface.dictionaries.zh["draw.switch"] === "string" &&
      typeof surface.dictionaries.zh["draw.on"] === "string" &&
      typeof surface.dictionaries.zh["draw.off"] === "string",
    JSON.stringify(Object.keys(surface.dictionaries.zh).filter((k) => k.startsWith("draw."))));
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
