/**
 * The panel's rendered output, checked against the code the browser loads.
 *
 * The decision tests assert WHICH view renders; nothing asserted WHAT that
 * view says. The known blind spot was a numeric swap — a window card that
 * renders `limit/used` instead of `used/limit`, or that fabricates a
 * "remaining" figure the platform never reported, passed the whole suite.
 * These checks feed arithmetic the reader can verify by hand (12345 of 60000 is
 * 20.575%) into the panel's REAL rendering components and inspect what would
 * reach the screen.
 *
 * There is no DOM and no React here: `panel-render.js` lifts the components out
 * of client.js and evaluates them with a recording `h`, so function components
 * stay uncalled until a check expands them — the tree a check sees is the tree
 * React would receive.
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

// === A. the window card's headline is the LIMIT, and its bar is real ======
// The inversion is the point of the Agnes rewrite. The SenseNova card led with
// "remaining %" because the platform reported a live balance per pool; Agnes
// reports none — it caps four dimensions over sliding windows and its console
// publishes only CUMULATIVE usage — so the limit is the headline, and a
// percentage appears only when the platform itself stated a `used` figure for
// that window. 12345 of 60000 is 20.575%: any swap of used/limit changes the
// bar width, so this block is the anti-mirror for that exact bug.
{
  const tree = treeOf(render.QuotaWindowCard, {
    label: "quota.win.requests5h",
    window: { key: "requests5h", unit: "requests", limit: 60000, windowHours: 5, used: 12345 },
    tt
  });
  const meta = texts(tree).join("\n");
  check("the headline is the LIMIT, with its unit",
    meta.includes("60,000 quota.unit.requests"), meta);
  check("the headline is not a percentage",
    !meta.includes("79.4%") && !meta.includes("20.6%"), meta);
  check("the used figure is the USED count against the limit",
    meta.includes("quota.used 12,345 / 60,000"), meta);
  check("the window's PERIOD is named — there is no reset instant to print",
    meta.includes("quota.perHours"), meta);

  const fill = bar(tree);
  check("the bar reports the used fraction to assistive tech",
    Number(fill?.props["aria-valuenow"]) === 20.6, String(fill?.props["aria-valuenow"]));
  const inner = findElement(fill, (props) => typeof props.style?.width === "string");
  check("the bar's width is the same fraction the caption shows",
    inner?.props.style.width === "20.575%", String(inner?.props.style.width));
}

// === B. a window with no stated consumption draws NO bar ==================
// An absent `used` is not `used: 0`. Drawing an empty bar would claim the
// window is untouched, which the platform never said — and the video window is
// exactly that case today: the limit field exists (`video_daily_limit`) while
// the console's usage side counts `video_seconds`, so there is nothing to pair.
{
  const tree = treeOf(render.QuotaWindowCard, {
    label: "quota.win.videoDaily",
    window: { key: "videoDaily", unit: "video", limit: 500, windowHours: 24 },
    tt
  });
  const meta = texts(tree).join("\n");
  check("the limit still renders without a used figure", meta.includes("500"), meta);
  check("no bar is drawn when no consumption was stated", bar(tree) === null, JSON.stringify(bar(tree)));
  check("no used caption either", !meta.includes("quota.used"), meta);
  // Video is deliberately UNITLESS: the platform never says whether the cap is
  // in clips or in seconds, so the panel prints the bare number rather than
  // asserting one. The image window, by contrast, has a unit the platform's own
  // `feature_texts` uses ("张").
  check("the video window claims no unit at all",
    texts(tree).includes("500"), JSON.stringify(texts(tree)));
  check("the image window does carry its unit",
    texts(treeOf(render.QuotaWindowCard, {
      label: "quota.win.imagesDaily",
      window: { key: "imagesDaily", unit: "images", limit: 4000, windowHours: 24 }, tt
    })).includes("4000 quota.unit.images"),
    JSON.stringify(texts(treeOf(render.QuotaWindowCard, {
      label: "quota.win.imagesDaily",
      window: { key: "imagesDaily", unit: "images", limit: 4000, windowHours: 24 }, tt
    }))));
}

// === C. the bar's tone escalates as the window fills ======================
// The thresholds live in the client (70 warn / 90 error); a check hard-coding
// a colour would pass a tone swap. The values come from the lifted S instead.
{
  const fillFor = (used) => {
    const fill = bar(treeOf(render.QuotaWindowCard, {
      label: "l", window: { limit: 60000, windowHours: 5, used }, tt
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

// === D. an absent limit is UNKNOWN, never a fake zero ====================
{
  const tree = treeOf(render.QuotaWindowCard, {
    label: "l", window: { key: "requests5h", unit: "requests", limit: 0, windowHours: 5, used: 0 }, tt
  });
  check("a zero limit renders as an em dash, not a 0",
    texts(tree).includes("—") && !texts(tree).some((line) => line.includes("0")), texts(tree).join("\n"));
  // limit 0 means there is no fraction to draw, so there is no bar at all —
  // an `aria-valuenow=0` bar would read as "0% used" instead of "unknown".
  check("a zero limit draws no bar at all", bar(tree) === null, JSON.stringify(bar(tree)));
}

// === E. the usage chart draws one bar per platform bucket =================
// The bars are scaled to the BUSIEST bucket, so the tallest always fills the
// track. That answers "when was the heavy day", and the legend says plainly
// that the height is not a fraction of the quota limit — a full track would
// otherwise be misread as "at the cap".
{
  const usage = {
    days: 30,
    windowTotals: { totalRequests: 50, totalTokens: 500, totalImages: 1, totalVideoSeconds: 0 },
    buckets: [
      { bucket: "2026-09-29", requestCount: 40, textTokens: 400, imageCount: 0, videoSeconds: 0 },
      { bucket: "2026-09-30", requestCount: 10, textTokens: 100, imageCount: 1, videoSeconds: 0 }
    ]
  };
  const tree = treeOf(render.UsageChart, { usage, tt });
  const fills = findAll(tree, (props) => props.role === "progressbar");
  check("one bar per bucket", fills.length === 2, `found ${fills.length}`);
  check("the busiest bucket fills the track",
    fills[0]?.props.style.height === "100%", String(fills[0]?.props.style.height));
  check("a quieter bucket is scaled to the busiest",
    fills[1]?.props.style.height === "25%", String(fills[1]?.props.style.height));
  check("the bars report the same fractions to assistive tech",
    fills.map((fill) => fill.props["aria-valuenow"]).join(",") === "100,25",
    fills.map((fill) => fill.props["aria-valuenow"]).join(","));
  check("each bar names its bucket and count for the hover",
    findAll(tree, (props) => props.style === S.usageBar)[0]?.props.title === "2026-09-29: 40 quota.unit.requests",
    String(findAll(tree, (props) => props.style === S.usageBar)[0]?.props.title));
  const meta = texts(tree).join("\n");
  check("the axis prints the platform's own first and last bucket labels",
    meta.includes("2026-09-29") && meta.includes("2026-09-30"), meta);
  check("the chart says what it counts and how it is bucketed",
    meta.includes("usage.requests") && meta.includes("usage.perBucket"), meta);
  check("the legend names the scaling convention",
    meta.includes("usage.legend"), meta);
  check("the chart sits in a card like the other sections",
    tree.props?.style?.background === S.card.background, JSON.stringify(tree.props?.style ?? {}));
}

// === E2. a flat series must not divide by zero ===========================
// Every bucket at zero means there is no maximum to scale against; the bars
// must collapse to nothing instead of producing NaN heights.
{
  const tree = treeOf(render.UsageChart, {
    usage: { buckets: [{ bucket: "a", requestCount: 0 }, { bucket: "b", requestCount: 0 }] }, tt
  });
  const fills = findAll(tree, (props) => props.role === "progressbar");
  check("an all-zero series still draws its bars", fills.length === 2, `found ${fills.length}`);
  check("an all-zero series produces no NaN height",
    fills.every((fill) => fill.props.style.height === "0%"),
    JSON.stringify(fills.map((fill) => fill.props.style.height)));
  check("an all-zero series reports zero to assistive tech",
    fills.every((fill) => fill.props["aria-valuenow"] === 0),
    JSON.stringify(fills.map((fill) => fill.props["aria-valuenow"])));
}

// === E3. the usage totals row names the period it covers ==================
// The account total and the window total use the SAME figures with different
// meanings, so the label is what stops the reader taking a lifetime total for
// a window total. `activeDays` exists only on the account row, and an absent
// cell is not drawn rather than shown as 0.
{
  const totals = { totalRequests: 12000, totalTokens: 340000, totalImages: 40, totalVideoSeconds: 610, activeDays: 12 };
  const out = rendered(render.UsageTotals, { totals, label: "quota.accountTotals", tt });
  check("the period label leads the row", out[0] === "quota.accountTotals", out.join("\n"));
  check("every dimension gets its own labelled cell",
    ["quota.total.requests", "quota.total.tokens", "quota.total.images", "quota.total.video", "quota.total.activeDays"]
      .every((key) => out.includes(key)), out.join("\n"));
  check("the figures reach the screen with thousands separators",
    out.includes("12,000") && out.includes("340,000"), out.join("\n"));

  const sparse = rendered(render.UsageTotals, { totals: { totalRequests: 1 }, label: "l", tt });
  check("a missing activeDays cell is not drawn as a zero",
    !sparse.includes("quota.total.activeDays"), sparse.join("\n"));

  const missing = rendered(render.UsageTotals, { totals: null, label: "l", tt });
  check("a totals block that never arrived names the label it could not read",
    missing.length === 1 && missing[0].includes("quota.usageMissing"), missing.join("\n"));
}

// === F. an empty series says so instead of drawing an empty chart ========
{
  const out = rendered(render.UsageChart, { usage: { buckets: [] }, tt });
  check("an empty series shows the empty note", out.includes("usage.none"), out.join("\n"));
  const none = rendered(render.UsageChart, { usage: null, tt });
  check("a missing series shows the empty note too", none.includes("usage.none"), none.join("\n"));
  const emptyTree = treeOf(render.UsageChart, { usage: { buckets: [] }, tt });
  check("the empty note sits inside a card too",
    emptyTree.props?.style?.background === S.card.background, JSON.stringify(emptyTree.props?.style ?? {}));
}

// === G. the plan card assembles its own sections ==========================
{
  const quota = {
    plan: {
      uuid: "u-1", planId: 3, name: "高级版", displayName: "高级版",
      billingCycle: "monthly", displayCycle: "月付",
      priceMinor: 9900, currency: "CNY",
      usageLimitText: "30000 次模型请求 / 5 小时",
      limits: { requests5h: 30000, requestsWindowH: 5, requestsWeekly: 300000, imagesDaily: 4000, videoDaily: 500 }
    },
    windows: [
      { key: "requests5h", unit: "requests", limit: 30000, windowHours: 5 },
      { key: "requestsWeekly", unit: "requests", limit: 300000, windowHours: 168 },
      { key: "imagesDaily", unit: "images", limit: 4000, windowHours: 24 },
      { key: "videoDaily", unit: "video", limit: 500, windowHours: 24 }
    ],
    totals: { totalRequests: 1200, totalTokens: 340000, totalImages: 40, totalVideoSeconds: 610, activeDays: 12 },
    plans: [],
    expiresAt: 1800003600,
    error: null
  };
  const out = rendered(render.PlanCard, { quota, tt });
  check("the plan's display name is rendered", out.includes("高级版"), out.join("\n"));
  check("the billing cycle is labelled", out.includes("quota.cycle.monthly"), out.join("\n"));
  check("the price reads as money with its period",
    out.join("\n").includes("¥99.00") && out.join("\n").includes("quota.perMonth"), out.join("\n"));
  // The platform's own one-line summary is quoted verbatim rather than
  // re-derived, so it can never disagree with the four window cards below it.
  check("the platform's own limit sentence is quoted verbatim",
    out.includes("30000 次模型请求 / 5 小时"), out.join("\n"));
  check("all four windows are present",
    ["quota.win.requests5h", "quota.win.requestsWeekly", "quota.win.imagesDaily", "quota.win.videoDaily"]
      .every((key) => out.includes(key)), out.join("\n"));
  check("the subscription expiry is rendered when present", out.includes("quota.expires"), out.join("\n"));
  // The card is about the READER's plan; the other tiers fold away so they
  // cannot crowd it, but they stay one click from the answer to "is upgrading
  // worth it" — using the platform's own numbers rather than a link.
  check("no catalogue fold is drawn when no catalogue arrived",
    !out.includes("quota.catalogue"), out.join("\n"));

  const withCatalogue = rendered(render.PlanCard, {
    quota: {
      ...quota,
      plans: [
        { uuid: "a", planId: 1, name: "入门版", displayName: "入门版", billingCycle: "monthly", displayCycle: "月付", priceMinor: 2500, currency: "CNY", usageLimitText: "", limits: { requests5h: 1500, requestsWindowH: 5, requestsWeekly: 15000, imagesDaily: 4000, videoDaily: 500 } },
        { uuid: "b", planId: 3, name: "高级版", displayName: "高级版", billingCycle: "monthly", displayCycle: "月付", priceMinor: 9900, currency: "CNY", usageLimitText: "", limits: { requests5h: 30000, requestsWindowH: 5, requestsWeekly: 300000, imagesDaily: 4000, videoDaily: 500 } }
      ]
    },
    tt
  });
  check("the catalogue fold is drawn when a catalogue arrived",
    withCatalogue.includes("quota.catalogue"), withCatalogue.join("\n"));
  check("every catalogue tier becomes a comparable row",
    withCatalogue.includes("入门版") && withCatalogue.includes("高级版"), withCatalogue.join("\n"));
  check("a catalogue row states its limits, not just its name",
    withCatalogue.join("\n").includes("5h") && withCatalogue.join("\n").includes("15,000"),
    withCatalogue.join("\n"));
}

// === G1b. an unrecognised or absent plan degrades, never guesses ==========
// The console's plan payload was never observed with a session token, so the
// matcher may well come back empty. Printing the entry tier "as a default"
// would be a fabricated fact about the reader's account; the panel says it
// could not tell, and keeps showing what it DOES know (the windows, and the
// public catalogue).
{
  const bare = rendered(render.PlanCard, {
    quota: {
      plan: null,
      windows: [{ key: "requests5h", unit: "requests", limit: 1500, windowHours: 5 }],
      totals: null, plans: [], expiresAt: null, error: null
    },
    tt
  });
  check("an unrecognised plan says so instead of guessing a tier",
    bare.includes("quota.planUnknown") && !bare.includes("入门版"), bare.join("\n"));
  check("the windows still render without a plan", bare.includes("quota.win.requests5h"), bare.join("\n"));

  const nothing = rendered(render.PlanCard, { quota: null, tt });
  check("no quota block at all shows the empty note", nothing.includes("quota.none"), nothing.join("\n"));
  const empty = rendered(render.PlanCard, {
    quota: { plan: null, windows: [], totals: null, plans: [], expiresAt: null, error: null }, tt
  });
  check("an entirely empty quota block shows the empty note too",
    empty.includes("quota.none"), empty.join("\n"));
}

// === G2. sections are collapsible card headers, expanded by default ======
// The two content sections live behind a workbuddy-style card header: a
// full-width button (title + rotating chevron) that tucks the body away.
// The header is hook-free — `open`/`onToggle` arrive as props — so the
// toggle is exercised here; `PanelPage` starts both sections expanded.
{
  const children = ["inner"];
  const openTree = treeOf(render.SectionCard, {
    title: "section.quota", open: true, onToggle: () => {}, tt, children
  });
  check("the section sits in a card like the quota cards",
    openTree.props?.style?.background === S.card.background && openTree.props?.style?.borderRadius === S.card.borderRadius,
    JSON.stringify(openTree.props?.style ?? {}));
  const head = findElement(openTree, (props) => props["aria-expanded"] !== undefined);
  check("the section header is a real button", head?.type === "button", String(head?.type));
  check("an open section reports aria-expanded=true", head?.props["aria-expanded"] === true,
    String(head?.props["aria-expanded"]));
  check("the header announces the collapse action",
    head?.props["aria-label"] === "section.collapse: section.quota", String(head?.props["aria-label"]));
  check("the header hands the click to the toggle", typeof head?.props.onClick === "function", "");
  check("an open section renders its body", texts(openTree).includes("inner"), texts(openTree).join("\n"));
  check("an open body is not hidden",
    findElement(openTree, (props) => props.hidden !== undefined)?.props.hidden === false, "");
  const chev = findElement(openTree, (props) => typeof props.viewBox === "string");
  check("the header carries a chevron", chev !== null, "");
  check("the chevron flips when the section is open",
    chev?.props.style?.transform === "rotate(180deg)", String(chev?.props.style?.transform));

  const closedTree = treeOf(render.SectionCard, {
    title: "section.usage", open: false, onToggle: () => {}, tt, children
  });
  const closedHead = findElement(closedTree, (props) => props["aria-expanded"] !== undefined);
  check("a closed section reports aria-expanded=false", closedHead?.props["aria-expanded"] === false,
    String(closedHead?.props["aria-expanded"]));
  check("the header announces the expand action",
    closedHead?.props["aria-label"] === "section.expand: section.usage", String(closedHead?.props["aria-label"]));
  check("a closed section hides its body", !texts(closedTree).includes("inner"), texts(closedTree).join("\n"));
  check("the body stays mounted but hidden when closed",
    findElement(closedTree, (props) => props.hidden !== undefined)?.props.hidden === true, "");
  const closedChev = findElement(closedTree, (props) => typeof props.viewBox === "string");
  check("the chevron points down when the section is closed",
    closedChev?.props.style?.transform === undefined, String(closedChev?.props.style?.transform));
}

// === G3. the step-three provider status is secret-free and stateful ======
// ProviderStatus (key card) says ONLY where the key came from; the
// registration states live in ProviderRegStatus (provider card) since the
// panel grew one card per concern. These render with the REAL zh
// dictionary: the identity `tt` returns the key itself, which carries no
// `{placeholder}` to expand, so composition (the counts, the id, the
// source) could not be checked through it.
{
  const zh = surface.dictionaries.zh;
  const ttZh = (key) => zh[key] ?? key;

  check("no llm block renders nothing",
    rendered(render.ProviderStatus, { llm: null, tt }).length === 0
      && rendered(render.ProviderStatus, { llm: "x", tt }).length === 0
      && rendered(render.ProviderRegStatus, { llm: null, tt }).length === 0
      && rendered(render.ProviderRegStatus, { llm: "x", tt }).length === 0);

  const off = rendered(render.ProviderStatus, {
    llm: { hasApiKey: false, keySource: null, ephemeral: false, registerProvider: false,
      llmAvailable: false, providerRegistered: false, providerId: "agnes-token-plan" },
    tt: ttZh
  });
  check("no key asks for one", off.some((line) => line.includes(zh["llm.noKey"])), off.join("\n"));
  check("the key card does NOT speak for the provider card",
    !off.some((line) => line.includes("未向 DSH 注册")), off.join("\n"));

  const regOff = rendered(render.ProviderRegStatus, {
    llm: { hasApiKey: false, keySource: null, ephemeral: false, registerProvider: false,
      llmAvailable: false, providerRegistered: false, providerId: "agnes-token-plan" },
    tt: ttZh
  });
  check("the opt-in being off is stated",
    regOff.some((line) => line.includes("未向 DSH 注册") && line.includes("开关")), regOff.join("\n"));
  check("the provider id is shown",
    regOff.some((line) => line.includes("agnes-token-plan")), regOff.join("\n"));

  const registered = rendered(render.ProviderStatus, {
    llm: { hasApiKey: true, keySource: "credentials", ephemeral: false, registerProvider: true,
      llmAvailable: true, providerRegistered: true, providerId: "agnes-token-plan",
      modelCount: 3, visionCount: 1,
      // A defensive field the Host never sends: it must never reach the screen.
      value: "sk-secret-value" },
    tt: ttZh
  });
  const regOn = rendered(render.ProviderRegStatus, {
    llm: { hasApiKey: true, keySource: "credentials", ephemeral: false, registerProvider: true,
      llmAvailable: true, providerRegistered: true, providerId: "agnes-token-plan",
      modelCount: 3, visionCount: 1, value: "sk-secret-value" },
    tt: ttZh
  });
  check("a stored key reports the credentials source",
    registered.some((line) => line.includes(zh["llm.src.credentials"])), registered.join("\n"));
  check("the registered line carries both counts and the id",
    regOn.some((line) => line.includes("3") && line.includes("1")
      && line.includes("agnes-token-plan")), regOn.join("\n"));
  check("the key value itself never renders",
    !registered.some((line) => line.includes("sk-secret-value"))
      && !regOn.some((line) => line.includes("sk-secret-value")), regOn.join("\n"));
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

  const noService = rendered(render.ProviderRegStatus, {
    llm: { hasApiKey: true, keySource: "credentials", registerProvider: true,
      llmAvailable: false, providerRegistered: false, providerId: "p" },
    tt: ttZh
  });
  check("enabled without an llm service says so",
    noService.some((line) => line.includes(zh["llm.noService"])), noService.join("\n"));

  const failed = rendered(render.ProviderRegStatus, {
    llm: { hasApiKey: true, keySource: "credentials", registerProvider: true,
      llmAvailable: true, providerRegistered: false, providerId: "p", providerError: "DUPLICATE_ADAPTER" },
    tt: ttZh
  });
  check("a failed registration shows the error line",
    failed.some((line) => line.includes("DUPLICATE_ADAPTER")), failed.join("\n"));

  // The switch is ticked, no error, service present, but registration has
  // not landed: the line must NOT claim the switch is off — that is the
  // same visibility lie the account editor used to tell after a "forget".
  const pending = rendered(render.ProviderRegStatus, {
    llm: { hasApiKey: true, keySource: "credentials", registerProvider: true,
      llmAvailable: true, providerRegistered: false, providerId: "p" },
    tt: ttZh
  });
  // Match a placeholder-free substring of the pending line, not the raw
  // dictionary string (which still carries the unfilled `{id}`).
  check("a ticked switch without a landed registration says pending, not off",
    pending.some((line) => line.includes("开关已开但注册尚未生效"))
      && !pending.some((line) => line.includes("未向 DSH 注册")), pending.join("\n"));

  // A specific failure outranks a capability gap: both llmAvailable false
  // and a providerError present must show the error, not the capability line.
  const both = rendered(render.ProviderRegStatus, {
    llm: { hasApiKey: true, keySource: "credentials", registerProvider: true,
      llmAvailable: false, providerRegistered: false, providerId: "p", providerError: "DUPLICATE_ADAPTER" },
    tt: ttZh
  });
  check("a specific error outranks the no-service line",
    both.some((line) => line.includes("DUPLICATE_ADAPTER"))
      && !both.some((line) => line.includes(zh["llm.noService"])), both.join("\n"));
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
  check("one vision model earns one vision badge", visionLines.length === 1, String(visionLines.length));
  check("a text-only model earns NO badge — the default state is not notable",
    findAll(allOn, (props) => props.style?.borderRadius === 999).length === 1,
    String(findAll(allOn, (props) => props.style?.borderRadius === 999).length));
  check("an unticked row keeps its vision badge",
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

  // The WorkBuddy-shape additions: the parameter line and the pseudo rate.
  // The 1048576 → "1M" reading is exactly the `1049k` placeholder bug the old
  // decimal rounding drew, so it stays pinned here and in tokenSize below.
  const rich = [{
    id: "deepseek-v4-flash", name: "deepseek-v4-flash", vision: false, available: false, quotaExhausted: true,
    contextWindow: 1048576, maxOutputLength: 65536, multiplier: 10,
    // Proven-only levels: the 2026-09-30 probe recorded 200 on
    // low/medium/xhigh for this model (frozen baseline) — the roster
    // quotes exactly what the panel would let the user pick.
    thinkingLevels: ["off", "low", "medium", "high", "xhigh"]
  }];
  const richTree = treeOf(render.ModelRoster, { models: rich, enabledIds: [], tt: ttZh });
  const richText = texts(richTree).join("\n");
  check("1048576 tokens reads as 1M — never the decimal 1049k",
    richText.includes("1M 上下文") && !richText.includes("1049k"), richText);
  check("the platform-declared output ceiling lands in the parameter line",
    richText.includes("最大输出 64K"), richText);
  check("the row quotes THIS model's selectable levels, localized like the picker",
    richText.includes("思考 关闭/低/中/高/极高"), richText);
  check("the provider-wide default never repeats per row (it lives in the header)",
    !richText.includes("默认思考强度") && !richText.includes(zh["llm.rosterThinkingDefault"]), richText);
  check("the pseudo multiplier labels the row ×N", richText.includes("×10"), richText);
  check("a quota-exhausted row names why it cannot answer",
    richText.includes(zh["llm.rosterExhausted"]), richText);
  check("a row without declared figures draws no parameter line",
    texts(allOn).every((line) => !line.includes("上下文")), texts(allOn).join("\n"));
  const tokenSize = surface.helpers.tokenSize;
  check("tokenSize keeps decimal and binary figures at home",
    tokenSize(1048576) === "1M" && tokenSize(262144) === "256K" &&
    tokenSize(128000) === "128K" && tokenSize(65536) === "64K" &&
    tokenSize(0) === "" && tokenSize("junk") === "",
    [tokenSize(1048576), tokenSize(262144), tokenSize(128000), tokenSize(65536), tokenSize(0)].join("/"));

  check("an empty catalogue draws no rows at all",
    boxes(treeOf(render.ModelRoster, { models: [], enabledIds: [], tt })).length === 0);

  check("a junk models value reads as an empty catalogue",
    boxes(treeOf(render.ModelRoster, { models: "nope", enabledIds: [], tt })).length === 0);
}

// === G8. a drifted payload degrades to a line, never a crash ==============
// The Host flags top-level shape drift but still passes the data through, so a
// window row that is not an object, a plan block with nothing recognised, or a
// usage block with no buckets must render nothing/empty instead of throwing and
// blanking the whole panel. One malformed row must not take the quota view (and
// its shape warning) down with it.
{
  const zh = surface.dictionaries.zh;
  const ttZh = (key) => zh[key] ?? key;

  check("a quota window that is not an object renders nothing",
    texts(treeOf(render.QuotaWindowCard, { label: "quota.win.requests5h", window: null, tt: ttZh })).length === 0
      && texts(treeOf(render.QuotaWindowCard, { label: "quota.win.requests5h", window: undefined, tt: ttZh })).length === 0,
    texts(treeOf(render.QuotaWindowCard, { label: "quota.win.requests5h", window: null, tt: ttZh })).join("\n"));

  const barePlan = rendered(render.PlanCard, {
    quota: { plan: null, windows: [], plans: [], totals: null, expiresAt: null, error: "series" },
    tt: ttZh
  });
  check("a quota block with nothing recognised says so rather than blanking",
    barePlan.includes(zh["quota.none"]), barePlan.join("\n"));

  const emptyChart = rendered(render.UsageChart, { usage: {}, tt: ttZh });
  check("a usage block without buckets shows the empty note, not a crash",
    emptyChart.includes(zh["usage.none"]), emptyChart.join("\n"));

  const missingTotals = rendered(render.UsageTotals, { totals: undefined, label: "l", tt: ttZh });
  check("an absent totals block names itself instead of printing NaN",
    missingTotals.length === 1 && !missingTotals.join("").includes("NaN"), missingTotals.join("\n"));
}

// === H. the rendering came from the shipped client ========================
// Reaching here means the real components were lifted off the shipped bundle.
// These checks pin the lifted pieces themselves, so a refactor that silently
// empties one of them cannot read as a green suite.
{
  check("the style tokens were lifted from the client", S.card?.borderRadius === 12 && S.bar?.height === 6,
    JSON.stringify(S.card ?? {}));
  check("the components were lifted from the shipped bundle",
    render.PlanCard instanceof Function && render.QuotaWindowCard instanceof Function
      && render.UsageTotals instanceof Function && render.UsageChart instanceof Function
      && render.SectionCard instanceof Function, JSON.stringify(Object.keys(render)));
  check("count renders its input rounded to 2 places",
    rendered(render.UsageTotals, { totals: { totalRequests: 12.345 }, label: "l", tt }).includes("12.35"),
    "count(12.345) should round to 2 places");
  check("count switches to thousands separators at 10 000",
    rendered(render.UsageTotals, { totals: { totalRequests: 60000 }, label: "l", tt }).includes("60,000"),
    "count(60000) should read 60,000");

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
    // The tab bar is part of the FIRST FRAME too, and that is a separate bug
    // from the one above. It used to live INSIDE the `data` branch, so a
    // console nobody had signed in to replaced the whole page with a form —
    // taking the API-key tab and the Raccoon tab down with it, neither of
    // which reads the console at all (ARCHITECTURE.md §5). "No snapshot yet"
    // and "no console account" must both leave the three tabs reachable.
    check("the first frame already carries all three tabs",
      firstFrame.includes("tab.quota") && firstFrame.includes("tab.api") && firstFrame.includes("tab.raccoon"),
      firstFrame.join("\n"));
    // …and the quota tab's body is a TAB's content, not the page: the loading
    // line renders inside the tab strip, so switching tabs is possible before
    // the first answer arrives.
    check("the first frame keeps the loading line inside the tab strip",
      firstFrame.indexOf("tab.raccoon") < firstFrame.indexOf("panel.loading"),
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

// === G9. the draw switch section is rendered and says which state it is in
// DrawSwitch IS mountable: `client-surface.js` installs a stand-in React whose
// `useState` returns the initial value and whose `useCallback` returns the
// callback, so the first frame renders exactly as it would in the browser.
// (The old note here claimed it could not be mounted, which is why the row
// regression below shipped green.)
{
  check("the draw switch component is exported by the client surface",
    typeof render.DrawSwitch === "function", String(typeof render.DrawSwitch));

  const drawLlm = {
    drawEnabled: true,
    hasApiKey: true,
    drawModel: "Agnes-u1.5-lite",
    drawCandidateIds: ["Agnes-u1-fast", "Agnes-u1.5-lite"],
    drawPreferredModel: "Agnes-u1.5-lite"
  };
  const drawTree = treeOf(render.DrawSwitch, { llm: drawLlm, tt });
  const drawText = texts(drawTree);

  // The auto row plus one row per candidate, and the status lead-in above them.
  const rows = findAll(drawTree, (props) => props.style?.borderBottom !== undefined);
  check("the draw picker draws the auto row plus every candidate",
    rows.length === 3, `rows=${rows.length}`);
  check("the draw section says it is on and names the list it introduces",
    drawText.includes("draw.onList"), drawText.join("\n"));
  check("the auto row offers the auto option",
    drawText.includes("draw.autoOption"), drawText.join("\n"));
  check("the pinned candidate is the one marked effective",
    drawText.join("").includes("draw.badge · draw.effective"), drawText.join("\n"));
  check("the auto row names the model the auto-pick addresses",
    drawText.join("").includes("draw.badge · Agnes-u1.5-lite"), drawText.join("\n"));
  check("the draw section's dictionary keys exist in zh",
    typeof surface.dictionaries.zh["draw.switch"] === "string" &&
      typeof surface.dictionaries.zh["draw.off"] === "string",
    JSON.stringify(Object.keys(surface.dictionaries.zh).filter((k) => k.startsWith("draw."))));

  // The row SHAPE is a contract, not a detail: `modelRow` is a column (a head
  // line over an optional parameter line), so the name and its badge must be
  // wrapped in `modelRowHead`. Left as bare siblings they stack, `modelName`'s
  // `flex: 0 1 auto` collapses to zero width, and the row renders as a mangled
  // two-line smear — which is exactly what shipped when `modelRow` became a
  // column and only `ModelRoster` was migrated.
  {
    const columnRows = findAll(drawTree, (props) => props.style?.flexDirection === "column"
      && props.style?.borderBottom !== undefined);
    check("the draw rows are the roster's column shape",
      columnRows.length === 3, `column rows=${columnRows.length}`);
    const bare = columnRows.filter((row) => {
      const kids = (Array.isArray(row.children) ? row.children.flat(Infinity) : [row.children ?? []])
        .filter((child) => child && typeof child === "object");
      return kids.some((child) => child.props?.style === S.modelName || child.props?.style === S.modelBadge);
    });
    check("no draw row leaves its name or badge outside modelRowHead",
      bare.length === 0, `${bare.length} row(s) stack their name/badge`);
    const heads = findAll(drawTree, (props) => props.style === S.modelRowHead);
    check("every draw row wraps its head in modelRowHead",
      heads.length === 3, `heads=${heads.length}`);
  }

  // The same contract for the two other `modelRow` consumers, so the next
  // change to the row shape cannot migrate one and forget the rest.
  {
    const rosterTree = treeOf(render.ModelRoster, {
      models: [{ id: "Agnes-6.8-flash-lite", name: "Agnes 6.8 Flash Lite", contextWindow: 262144, maxOutputLength: 65536 }],
      enabledIds: [], busy: false, tt
    });
    const raccoonTree = treeOf(render.RaccoonRoster, {
      models: [{ id: "raccoon-v1", name: "Raccoon v1", multiplier: 0, vision: true }], tt
    });
    for (const [name, tree] of [["ModelRoster", rosterTree], ["RaccoonRoster", raccoonTree]]) {
      const rowList = findAll(tree, (props) => props.style?.flexDirection === "column"
        && props.style?.borderBottom !== undefined);
      // Non-vacuity first: an empty tree would satisfy "no offenders" while
      // asserting nothing, which is how the draw regression shipped.
      check(`${name} renders its rows at all`,
        rowList.length === 1, `${name} rows=${rowList.length}`);
      const offenders = rowList.filter((row) => {
        const kids = (Array.isArray(row.children) ? row.children.flat(Infinity) : [row.children ?? []])
          .filter((child) => child && typeof child === "object");
        return kids.some((child) => child.props?.style === S.modelName || child.props?.style === S.modelBadge);
      });
      check(`${name} wraps every row's name/badge in modelRowHead`,
        offenders.length === 0, `${offenders.length} row(s) stack their name/badge`);
      check(`${name} names its model in the head line`,
        findAll(tree, (props) => props.style === S.modelName).length === 1,
        `${name} name spans=${findAll(tree, (props) => props.style === S.modelName).length}`);
    }
  }

  // The Raccoon roster's parameter line: the gateway ALREADY declares the
  // window and the output ceiling, the Host has normalized them since the
  // first release, and a name-only row was this component dropping data it
  // held. So the line is asserted in both directions — it must appear when
  // the figures are there, and must NOT appear empty when they are not.
  //
  // The thinking ladder is asserted ABSENT on purpose. This provider
  // registers `reasoning: false` (pi-ai cannot emit `extra_body.thinking`,
  // the gateway's only working channel), so quoting levels would promise a
  // selector the DSH picker never offers — the one thing worse than a sparse
  // row is a row that lies. `tt` returns the key verbatim here, so each
  // segment is pinned by WHICH template rendered, not by translated text.
  {
    const full = treeOf(render.RaccoonRoster, {
      models: [{ id: "sn-glm-5-3", name: "GLM-5.3", multiplier: 0.75, vision: true, contextWindow: 1_000_000, maxOutputLength: 65_536 }],
      tt
    });
    const meta = findAll(full, (props) => props.style === S.modelMeta);
    const metaText = meta.map((row) => texts(row).join("")).join(" | ");
    check("the raccoon row quotes the declared window and output ceiling",
      meta.length === 1 && metaText.includes("llm.contextBadge") && metaText.includes("llm.metaOutput"),
      `meta lines=${meta.length} text=${metaText}`);
    check("the raccoon row never quotes a thinking ladder",
      !texts(full).join("").includes("llm.metaLevels"),
      texts(full).join(" | "));
    check("the raccoon row draws a rate chip for a priced model",
      texts(full).join("").includes("×0.75"),
      texts(full).join(" | "));
    // The rate tooltip must be the RACCOON one. `llm.rosterRateTitle` calls the
    // figure a pseudo, operator-side number ("非官方") because the Token Plan
    // rate really is configured by the operator — but this rate comes straight
    // from the gateway catalogue, and reusing that string would libel real
    // data as invented. Cheap to share, expensive to get wrong.
    const rateChips = findAll(full, (props) => props.style === S.modelRate);
    check("the raccoon rate chip does not borrow the Token Plan's pseudo-rate tooltip",
      rateChips.length === 1 && rateChips[0].props?.title === "raccoon.rateTitle",
      `chips=${rateChips.length} title=${rateChips.map((chip) => chip.props?.title).join(",")}`);

    const bare = treeOf(render.RaccoonRoster, { models: [{ id: "x", name: "X" }], tt });
    check("a row with no declared figures draws no empty parameter line",
      findAll(bare, (props) => props.style === S.modelMeta).length === 0,
      texts(bare).join(" | "));
    check("a free model reads as free, not as a rate of zero",
      texts(treeOf(render.RaccoonRoster, { models: [{ id: "f", name: "F", multiplier: 0 }], tt })).join("").includes("raccoon.free"),
      texts(treeOf(render.RaccoonRoster, { models: [{ id: "f", name: "F", multiplier: 0 }], tt })).join(" | "));
  }
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
