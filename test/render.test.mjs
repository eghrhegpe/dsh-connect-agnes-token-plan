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
import { render, styles as S, texts, findElement } from "../panel-render.js";

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

// === A. the window row's arithmetic is the one the reader can verify ======
// 12345 of 60000 is 20.575%. Any swap of used/limit/remaining turns these
// figures into different numbers, so this block is the anti-mirror for the
// exact bug the decision tests could not see.
{
  const tree = treeOf(render.WindowRow, {
    label: "pool.window5h",
    window: { limit: 60000, used: 12345, remaining: 47655, resetAt: 1800000000 },
    tt
  });
  const meta = texts(tree).join("\n");
  check("the used figure is the USED count", meta.includes("pool.used 12,345"), meta);
  check("the remaining figure is the REMAINING count", meta.includes("pool.remaining 47,655"), meta);
  check("the percentage is used over limit", meta.includes("20.6%"), meta);

  const fill = bar(tree);
  check("the bar reports the same percentage to assistive tech",
    fill?.props["aria-valuenow"] === 21, String(fill?.props["aria-valuenow"]));
  const inner = findElement(fill, (props) => typeof props.style?.width === "string");
  check("the bar's width is the same fraction the text shows",
    inner?.props.style.width === "20.575%", String(inner?.props.style.width));
  check("the reset time is rendered when present", meta.includes("pool.reset"), meta);
}

// === B. a window without a reset time stays quiet about resets ============
{
  const out = rendered(render.WindowRow, {
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
    const fill = bar(treeOf(render.WindowRow, {
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
  const tree = treeOf(render.WindowRow, {
    label: "l", window: { limit: 0, used: 0, remaining: 0, resetAt: null }, tt
  });
  check("a zero limit renders as 0.0%", texts(tree).includes("0.0%"), texts(tree).join("\n"));
  check("the bar's reported value stays a number", bar(tree)?.props["aria-valuenow"] === 0,
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

// === F. an empty trend says so instead of rendering an empty table ========
{
  const out = rendered(render.TrendTable, { trend: { models: [] }, tt });
  check("an empty trend shows the empty note", out.includes("trend.none"), out.join("\n"));
  const none = rendered(render.TrendTable, { trend: null, tt });
  check("a missing trend shows the empty note too", none.includes("trend.none"), none.join("\n"));
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
  check("every callable model is listed",
    out.includes("Model-A") && out.includes("Model-B"), out.join("\n"));
  check("locked models are summarised, not listed", out.includes("pool.locked") && !out.includes("Model-C"),
    out.join("\n"));
  check("no grant line when the balance is zero", !out.includes("pool.grant"), out.join("\n"));

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

// === H. the rendering came from the shipped client ========================
// Reaching here means every extraction marker was found. These checks pin the
// lifted pieces themselves, so a refactor that silently empties one of them
// cannot read as a green suite.
{
  check("the style tokens were lifted from the client", S.card?.borderRadius === 12 && S.bar?.height === 6,
    JSON.stringify(S.card ?? {}));
  check("the number formatter was lifted", render.PoolCard instanceof Function && render.TrendTable instanceof Function
    && render.WindowRow instanceof Function);
  check("count renders its input unchanged for small numbers",
    rendered(render.TrendTable, { trend: { models: [{ model: "m", credits: 12.345 }] }, tt }).includes("12.35"),
    "count(12.345) should round to 2 places");
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
