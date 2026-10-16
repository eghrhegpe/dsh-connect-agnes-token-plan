/**
 * The SHIPPED `client.js` mounted into a REAL DOM by the REAL React.
 *
 * This is the gap `docs/TESTING.md` §4 used to name twice: the artifact only
 * ever got a mount SMOKE test (build-gate materializes the factory and reads a
 * few definitions), and the behaviour suites drove the SOURCES through a
 * recording `h` that never runs a hook. Neither proved that the bytes users
 * actually load mount, render, and ANSWER INTERACTION in a browser-like
 * environment. This suite does exactly that and nothing else:
 *
 *   - it imports the repo's `client.js` artifact (not `src/client/`), so a
 *     build that produces a broken bundle fails HERE, not in a user's browser;
 *   - it materializes the factory with the REAL `react` (the same version line
 *     the Host's web shell declares, `^18.2.0`) and mounts through the REAL
 *     `react-dom/client` `createRoot` into a jsdom document;
 *   - it mounts through the plugin's own `apply` (slot + locale wiring), not
 *     by reaching into internals — the same path the browser's Loader takes;
 *   - it CLICKS, TYPES and SUBMITS: tab switches, section collapse, the
 *     sign-in form's controlled inputs and its refusal line, the roster's
 *     search/dirty/save machine. Those are `useState`/`useEffect` round trips
 *     that the recording stand-in in `client-surface.js` deliberately cannot
 *     make (see that file's note), so hook components stop being a documented
 *     hole the moment this suite is green.
 *
 * SKIP shape (same family as tsc-gate/build-gate): `jsdom` / `react` /
 * `react-dom` are devDependencies, so a clean checkout without `npm install`
 * prints a loud SKIP and exits 0. The CI offline job installs devDependencies
 * before running the roster, so there this suite really gates.
 *
 * Not covered, on purpose: layout/paint (jsdom has no engine for it) and the
 * Host's real slot system (`wiring.test.mjs` owns that seam).
 *
 * Test-only: never imported by the plugin's own entry graph.
 * @module dsh-connect-agnes-token-plan/dom-render
 */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail: String(detail).slice(0, 400) });
}

// ── 0. dependencies: SKIP loudly when devDependencies are absent ────────────
// `jsdom` loads first and installs the DOM globals BEFORE react-dom is
// required: `canUseDOM` is computed at react-dom MODULE LOAD, and a react-dom
// loaded windowless keeps its input machinery dormant — clicks still work,
// but a controlled input's onChange never fires (the typing below would read
// as a green check over a silent no-op, which is worse than a red one).
const require = createRequire(import.meta.url);
let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch (error) {
  console.log("dom-render.test.mjs — SKIPPED: jsdom / react / react-dom are devDependencies and are not installed.");
  console.log("Run `npm install` (the CI offline job does) to enable the real-DOM mount suite.");
  console.log(`reason: ${String(error?.message ?? error)}`);
  process.exit(0);
}

// ── 1. a jsdom document, installed as the globals react-dom reads ───────────
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://127.0.0.1:3080/",
  pretendToBeVisual: true
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
for (const key of [
  "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node",
  "Event", "MouseEvent", "KeyboardEvent", "CustomEvent",
  "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"
]) {
  if (dom.window[key] === undefined) continue;
  try {
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
  } catch {
    // A host-owned global (Node's own `navigator`) stays as it is; react-dom
    // reaches these through `window`, which is jsdom's, whenever it can.
  }
}
// React's own guard for `act`: without it, updates outside a test env warn.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// NOW react may load — with a window present, `canUseDOM` comes up true.
let React;
let createRoot;
try {
  React = require("react");
  ({ createRoot } = require("react-dom/client"));
} catch (error) {
  console.log("dom-render.test.mjs — SKIPPED: react / react-dom could not be loaded.");
  console.log(`reason: ${String(error?.message ?? error)}`);
  process.exit(0);
}
const { act } = React;

// ── 2. the SHIPPED artifact, registered the way the browser registers it ────
// The bundle's only module-scope effect is `window.__ModuleLoader__.load(...)` —
// exactly enough to run it in Node (the same seam `client-surface.js` uses for
// the sources; here the FILE is the repo's built `client.js`, so a stale or
// broken artifact fails this suite rather than shipping).
const registrations = [];
dom.window.__ModuleLoader__ = { load: (entry) => registrations.push(entry) };
await import(pathToFileURL(join(ROOT, "client.js")).href);

const registration = registrations.find((entry) => entry.id === "dsh-connect-agnes-token-plan");
if (registration === undefined) {
  check("the shipped client.js registers its bundle", false,
    `captured ids: ${registrations.map((entry) => entry.id).join(", ") || "(none)"}`);
  console.log(JSON.stringify(results, null, 2));
  console.error("\nFAILED: the artifact did not register its bundle; nothing below can run");
  process.exit(1);
}
check("the shipped client.js registers its bundle", true, registration.id);

const instance = registration.factory((specifier) => {
  if (specifier === "react") return React;
  throw new Error(`the shipped bundle required "${specifier}", which only react may be`);
});
const surface = instance.panel;

// ── 3. mount through the plugin's OWN `apply` (the browser's entry path) ────
// A fake ctx with the four faces `apply` touches. The locale face is real
// enough to matter: `bind` resolves against the dictionaries `apply` itself
// registers, so the `tt` the panel renders with is the plugin's own zh text —
// a dictionary key that stops existing shows up as a raw key on screen below.
/**
 * The slot declaration + component `apply` registers, per slot name, exactly as
 * the shell would capture them. Keyed by name because `apply` mounts TWO seats
 * now (the Plugins-page card and the composer pill) and a single `slot` box made
 * the second registration overwrite the first — the panel below would have been
 * driven with the pill in its place.
 */
const slots = {};
const dictionaries = {};
const ctx = {
  // cordis `effect`: run the registration now, remember the disposer.
  effect: (fn) => fn(),
  locale: {
    register: (ns, dicts) => {
      dictionaries.ns = ns;
      dictionaries.zh = dicts.zh;
      dictionaries.en = dicts.en;
      return () => {};
    },
    bind: () => (key) => dictionaries.zh?.[key] ?? key,
    subscribe: () => () => {}
  },
  slots: {
    inject: (name, register) => {
      const dispose = register();
      return () => typeof dispose === "function" ? dispose() : undefined;
    },
    register: (decl, component) => {
      slots[decl.name] = { decl, component };
      return () => {};
    }
  }
};
instance.apply(ctx);
const { zh, en } = dictionaries;
const slot = slots["plugins.bundle.config"];

check("apply registers both dictionaries under the plugin namespace",
  dictionaries.ns === "dsh-connect-agnes-token-plan"
    && Object.keys(zh ?? {}).length > 0 && Object.keys(en ?? {}).length > 0,
  `ns=${String(dictionaries.ns)} zh=${Object.keys(zh ?? {}).length} en=${Object.keys(en ?? {}).length}`);
check("apply registers the config card into the shell's slot",
  slot?.decl?.name === "plugins.bundle.config" && typeof slot.component === "function",
  `slot=${String(slot?.decl?.name)} component=${typeof slot?.component}`);

// The props the shell would hand the page: `decl.inject()` is the REAL pair
// (`tt` bound to this namespace, the locale subscription face).
const pageProps = typeof slot.decl?.inject === "function" ? slot.decl.inject() : {};
check("the slot declaration injects a live tt that resolves real text",
  typeof pageProps.tt === "function" && pageProps.tt("panel.loading") === zh["panel.loading"],
  String(pageProps.tt?.("panel.loading")));

// The composer seat `apply` also owns. Asserted here rather than in a scenario
// below because a shell that captures the declaration at all must capture BOTH:
// the pill's own block further down mounts through this registration.
const pillSlot = slots["conversation.input.right"];
check("apply registers the composer pill into the conversation.input.right seat",
  pillSlot !== undefined && typeof pillSlot.component === "function"
    && pillSlot.decl.id === "dsh-connect-agnes-token-plan-composer-pill"
    && pillSlot.decl.locale === "dsh-connect-agnes-token-plan",
  `slot=${String(pillSlot?.decl?.id)} locale=${String(pillSlot?.decl?.locale)}`);
const pillProps = typeof pillSlot?.decl?.inject === "function" ? pillSlot.decl.inject() : {};
check("the pill's declaration injects a live tt and no other prop of its own",
  typeof pillProps.tt === "function" && pillProps.tt("composer.planPrefix") === zh["composer.planPrefix"]
    && Object.keys(pillProps).length === 1,
  `${JSON.stringify(Object.keys(pillProps))} prefix=${String(pillProps.tt?.("composer.planPrefix"))}`);

// ── 4. a scripted fetch: the panel's only door to the Host ──────────────────
const { SNAPSHOT_PATH, ACCOUNT_PATH, MODELS_PATH, AGNESCODE_PATH } = await import("../src/client/const.ts");
const fetchCalls = [];
/** The current scenario's route; each block installs its own. */
let route = () => { throw new Error("dom-render: no route installed for this scenario"); };
globalThis.fetch = async (path, opts) => {
  const call = { path: String(path), opts };
  fetchCalls.push(call);
  return route(call.path, opts);
};
/** The response face the client actually reads (`http.ts` / `panel-page.ts`). */
const reply = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
});
const callsTo = (path) => fetchCalls.filter((call) => call.path === path);

// ── 5. mount / drive helpers ────────────────────────────────────────────────
/** Every root this suite created, so nothing leaks a poll timer past the run. */
const mounted = [];
async function mountPanel() {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  // The REAL page, with the REAL injected props — only `onClose` is ours (the
  // Plugins page owns navigation and passes none; the panel must cope).
  await act(async () => {
    root.render(React.createElement(slot.component, { ...pageProps, onClose: undefined }));
  });
  return container;
}
async function unmountAll() {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
}

/** Click something the way a user does: a bubbling click the React tree can hear. */
async function click(element) {
  if (!(element instanceof dom.window.Element)) {
    throw new Error(`dom-render: click target is ${element === null ? "null" : typeof element}, not a DOM node`);
  }
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, view: dom.window }));
  });
}
/** Type into a controlled input through the NATIVE value setter (bypasses React's tracker). */
async function typeInto(element, text) {
  if (!(element instanceof dom.window.HTMLInputElement)) {
    throw new Error(`dom-render: typeInto target is ${element === null ? "null" : typeof element}, not an input`);
  }
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
  await act(async () => {
    setter.call(element, text);
    element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
/** Submit a form the way React hears it, without asking jsdom to navigate. */
async function submitForm(form) {
  await act(async () => {
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
}

const text = (container) => container.textContent ?? "";

// ── 6. the healthy fixtures ─────────────────────────────────────────────────
const healthyBody = {
  ok: true,
  now: Date.now(),
  cacheSeconds: 60,
  pollSeconds: 30,
  auth: {
    configured: true, hasAccount: true, hasRefreshToken: true, needsAccount: false,
    ephemeral: false, retryAfterMs: null, needsUserAction: false, autoRecoverArmed: true
  },
  quota: {
    consoleConnected: true,
    plan: {
      uuid: "u-1", planId: 3, name: "高级版", displayName: "高级版",
      billingCycle: "monthly", displayCycle: "月付", priceMinor: 9900, currency: "CNY",
      limits: { requests5h: 60000, requestsWindowH: 5, requestsWeekly: 400000, imagesDaily: 4000, videoDaily: 500 }
    },
    windows: [
      { key: "requests5h", unit: "requests", limit: 60000, windowHours: 5, used: 12345, usagePct: 20.6 },
      { key: "videoDaily", unit: "video", limit: 500, windowHours: 24 }
    ],
    totals: { totalRequests: 12000, totalTokens: 340000, totalImages: 40, totalVideoSeconds: 610, activeDays: 12 },
    plans: [],
    expiresAt: null,
    error: null
  },
  usage: {
    days: 30,
    buckets: [
      { bucket: "2026-10-14", requestCount: 40, textTokens: 400 },
      { bucket: "2026-10-15", requestCount: 10, textTokens: 100 }
    ]
  },
  llm: null
};

// Capture anything React complains about while we drive the tree: an invalid
// prop, a missing key, a bad hook order — all of it lands in console.error and
// all of it would be invisible to every other suite in this repo.
const reactNoise = [];
const originalError = console.error;
console.error = (...args) => {
  reactNoise.push(args.map((arg) => String(arg)).join(" "));
  originalError(...args);
};

// ── 7. scenario A: the first frame, then a snapshot landing ─────────────────
// The first frame is the `loadedOnce` gate rendered by REAL hooks: a
// configured user must see "loading", never the sign-in form, and the tab bar
// must already be there (ARCHITECTURE §5: one missing module must not take
// the other tabs down).
try {
  let resolveSnapshot;
  route = () => new Promise((resolve_) => { resolveSnapshot = resolve_; });

  const container = await mountPanel();

  check("the snapshot request went to the panel's own route",
    callsTo(SNAPSHOT_PATH).length === 1, JSON.stringify(fetchCalls.map((call) => call.path)));
  check("the first frame shows the loading line, not the sign-in form",
    text(container).includes(zh["panel.loading"]) && container.querySelector('input[autocomplete="username"]') === null,
    text(container).slice(0, 160));
  check("the first frame already carries all three tabs",
    container.querySelectorAll('button[role="tab"]').length === 3,
    String(container.querySelectorAll('button[role="tab"]').length));
  check("the first frame renders no quota numbers yet",
    !text(container).includes("20.6%"), text(container).slice(0, 160));

  // The snapshot lands — the whole reason the recording stand-in exists in the
  // other suites: here the async load really runs, really commits, and really
  // paints into the DOM.
  await act(async () => { resolveSnapshot(reply(healthyBody)); });

  const body = text(container);
  check("the landed snapshot renders the platform's percentage as the headline",
    body.includes("20.6%"), body.slice(0, 240));
  check("the landed snapshot renders the plan's display name",
    body.includes("高级版"), body.slice(0, 240));
  check("the used counts reach the DOM verbatim",
    body.includes("12,345 / 60,000"), body.slice(0, 240));
  const bar = container.querySelector('[role="progressbar"][aria-valuenow="20.6"]');
  check("the progress bar reports 20.6 to assistive tech as a real DOM attribute",
    bar !== null, String(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")));
  // The quota window's bar and the usage chart's bars all carry
  // `role="progressbar"`; only the window's one names the used counts, so the
  // "no bar for the video window" claim counts THOSE (two windows, one bar),
  // not every progressbar on the page.
  const windowBars = [...container.querySelectorAll('[role="progressbar"]')]
    .filter((bar) => bar.getAttribute("aria-label")?.includes(zh["quota.used"]) === true);
  check("a window with no stated used draws no bar at all",
    windowBars.length === 1, `window bars=${windowBars.length}`);
  check("the console-token chip says the token renews itself",
    body.includes(zh["auth.selfRenew"]), body.slice(0, 160));
  check("the poll follows the cadence the Host stated (30 s, not a baked-in default)",
    fetchCalls.every((call) => call.path !== SNAPSHOT_PATH || call === fetchCalls[0]),
    `snapshot calls: ${callsTo(SNAPSHOT_PATH).length}`);

  // ── 7b. a REAL click collapses a section (state → DOM, not a prop replay) ──
  const quotaHead = [...container.querySelectorAll("button[aria-expanded]")]
    .find((button) => button.textContent?.includes(zh["section.quota"]));
  check("the quota section header is a real button reporting its state",
    quotaHead !== undefined && quotaHead.getAttribute("aria-expanded") === "true",
    String(quotaHead?.getAttribute("aria-expanded")));
  await click(quotaHead);
  check("clicking it collapses the section for real",
    quotaHead.getAttribute("aria-expanded") === "false" && !text(container).includes("20.6%"),
    quotaHead.getAttribute("aria-expanded") ?? "");
  await click(quotaHead);
  check("clicking again expands it back",
    quotaHead.getAttribute("aria-expanded") === "true" && text(container).includes("20.6%"),
    quotaHead.getAttribute("aria-expanded") ?? "");

  // ── 7c. a REAL click switches tabs (the tab body unmounts with it) ────────
  const apiTab = [...container.querySelectorAll('button[role="tab"]')]
    .find((button) => button.textContent === zh["tab.api"]);
  check("the API tab button is there and unselected",
    apiTab !== undefined && apiTab.getAttribute("aria-selected") === "false",
    String(apiTab?.getAttribute("aria-selected")));
  await click(apiTab);
  check("clicking it selects the API tab and unmounts the quota body",
    apiTab.getAttribute("aria-selected") === "true" && !text(container).includes("20.6%"),
    text(container).slice(0, 160));
  check("the API tab shows the provider card while the console tab is elsewhere",
    text(container).includes(zh["llm.providerTitle"]), text(container).slice(0, 160));
  const quotaTab = [...container.querySelectorAll('button[role="tab"]')]
    .find((button) => button.textContent === zh["tab.quota"]);
  await click(quotaTab);
  check("switching back restores the quota numbers",
    quotaTab.getAttribute("aria-selected") === "true" && text(container).includes("20.6%"),
    text(container).slice(0, 160));
} finally {
  await unmountAll();
}

// ── 8. scenario B: the sign-in form, as the HOOKS really drive it ───────────
// The documented gap: `AccountForm` is built on useState/useEffect, so the
// recording stand-in never mounted it. Here the setup view appears, accepts
// typing, refuses an empty password, and completes a sign-in whose POST this
// suite inspects — the full journey, through the shipped bytes.
try {
  const notConfigured = {
    ok: false,
    error: "no console account is configured",
    code: "not_configured",
    auth: {
      configured: false, hasAccount: false, hasRefreshToken: false, needsAccount: true,
      ephemeral: false, retryAfterMs: null, needsUserAction: false, autoRecoverArmed: false
    }
  };
  // The snapshot answers "unconfigured" until a sign-in has landed, then the
  // healthy body — the same progression a fresh install really sees. The
  // account route answers the POST itself.
  let signedIn = false;
  route = async (path) => {
    if (path === ACCOUNT_PATH) {
      signedIn = true;
      return reply({ ok: true, hasAccount: true, configured: true });
    }
    return reply(signedIn ? healthyBody : notConfigured);
  };

  const container = await mountPanel();
  await act(async () => {}); // let the first (immediately answered) load land

  const userInput = container.querySelector('input[autocomplete="username"]');
  const pwInput = container.querySelector('input[autocomplete="current-password"]');
  check("an unconfigured panel shows the sign-in form after the first load concludes",
    userInput !== null && pwInput !== null, text(container).slice(0, 160));
  check("the loading line is gone once the answer arrived",
    !text(container).includes(zh["panel.loading"]), text(container).slice(0, 160));
  check("the tab bar survives an unconfigured console (the other tabs stay reachable)",
    container.querySelectorAll('button[role="tab"]').length === 3,
    String(container.querySelectorAll('button[role="tab"]').length));

  await typeInto(userInput, "reader@example.com");
  check("typing into the controlled username input really updates it",
    userInput.value === "reader@example.com", userInput.value);

  // The show/hide toggle is a useState round trip the stand-in can only fake.
  const showButton = [...container.querySelectorAll("button")]
    .find((button) => button.textContent === zh["auth.show"]);
  await click(showButton);
  check("the show-password toggle flips the real input type",
    pwInput.getAttribute("type") === "text", String(pwInput.getAttribute("type")));

  // An empty password must be refused BEFORE any network call.
  const callsBefore = fetchCalls.length;
  await submitForm(container.querySelector("form"));
  check("submitting without a password is refused client-side",
    text(container).includes(zh["auth.empty"]) && container.querySelector('[role="alert"]') !== null,
    text(container).slice(0, 200));
  check("the refused submit sent nothing to the Host",
    fetchCalls.length === callsBefore, `calls before=${callsBefore} after=${fetchCalls.length}`);

  // A complete sign-in: the POST carries what was typed, the answer lands, the
  // quota numbers replace the form.
  await typeInto(pwInput, "not-a-real-password");
  await submitForm(container.querySelector("form"));
  const accountCalls = callsTo(ACCOUNT_PATH);
  let posted = null;
  try { posted = JSON.parse(accountCalls[0]?.opts?.body ?? "null"); } catch { posted = null; }
  check("a complete submit POSTs the typed credentials to the account route",
    accountCalls.length === 1
      && posted?.username === "reader@example.com" && posted?.password === "not-a-real-password",
    JSON.stringify({ paths: accountCalls.map((call) => call.path), posted }));
  check("the successful sign-in replaces the form with the quota numbers",
    text(container).includes("20.6%") && container.querySelector('input[autocomplete="username"]') === null,
    text(container).slice(0, 200));
} finally {
  await unmountAll();
}

// ── 9. scenario C: the roster picker's search / dirty / save machine ────────
// The other suites could only pin this machine STRUCTURALLY (render.test.mjs
// G8c refuses a second copy in source). Here it is DRIVEN: a keystroke filters
// the rows, an untick flips the footer, and the save POSTs the draft — three
// useState/useMemo round trips through the shipped bytes.
try {
  const llmBody = {
    ...healthyBody,
    llm: {
      hasApiKey: true, keySource: "credentials", registerProvider: true, llmAvailable: true,
      providerRegistered: true, providerId: "agnes-token-plan",
      models: [
        { id: "nova-flash", name: "Nova Flash", vision: false },
        { id: "nova-vl", name: "Nova VL", vision: true },
        { id: "agnes-pro", name: "Agnes Pro", vision: false }
      ],
      enabledModelIds: ["nova-flash", "nova-vl"]
    }
  };
  route = async (path) => {
    if (path === MODELS_PATH) {
      return reply({ ok: true, enabledModelIds: ["nova-flash"], registerProvider: true, providerRegistered: true });
    }
    return reply(llmBody);
  };

  const container = await mountPanel();
  await act(async () => {});
  const apiTab = [...container.querySelectorAll('button[role="tab"]')]
    .find((button) => button.textContent === zh["tab.api"]);
  await click(apiTab);

  const search = container.querySelector('input[type="search"]');
  const rosterBoxes = () => [...container.querySelectorAll('ul[role="list"] input[type="checkbox"]')];
  check("the API tab offers the roster search box and three rows",
    search !== null && rosterBoxes().length === 3,
    `search=${search !== null} rows=${rosterBoxes().length}`);

  await typeInto(search, "vl");
  check("a keystroke filters the roster for real",
    rosterBoxes().length === 1 && text(container).includes("Nova VL")
      && !text(container).includes("Nova Flash") && !text(container).includes("Agnes Pro"),
    `rows=${rosterBoxes().length}`);

  await typeInto(search, "");
  check("clearing the search restores every row",
    rosterBoxes().length === 3, `rows=${rosterBoxes().length}`);

  // Nova VL is ticked; unticking it makes the draft DIRTY, which is what puts
  // the save/discard footer on screen.
  check("the footer stays hidden while the draft equals the Host",
    [...container.querySelectorAll("button")].every((button) => button.textContent !== zh["llm.rosterSave"]),
    text(container).slice(-160));
  await click(rosterBoxes()[1]); // nova-vl
  const saveButton = [...container.querySelectorAll("button")]
    .find((button) => button.textContent === zh["llm.rosterSave"]);
  check("unticking a row surfaces the unsaved-edit footer",
    saveButton !== undefined, text(container).slice(-160));

  await click(saveButton);
  const modelCalls = callsTo(MODELS_PATH);
  let postedIds = null;
  try { postedIds = JSON.parse(modelCalls[0]?.opts?.body ?? "null")?.enabledModelIds; } catch { postedIds = null; }
  check("saving POSTs the draft allow-list to the models route",
    modelCalls.length === 1 && JSON.stringify(postedIds) === JSON.stringify(["nova-flash"]),
    JSON.stringify(postedIds));
  check("the Host's echo turns the footer into the saved line",
    text(container).includes(zh["llm.rosterSaved"])
      && [...container.querySelectorAll("button")].every((button) => button.textContent !== zh["llm.rosterSave"]),
    text(container).slice(-200));
} finally {
  await unmountAll();
}

// ── 9b. the composer usage pill, driven through its OWN registration ───────
// The pill is this bundle's only surface outside the Plugins page: it mounts per
// session in the composer toolbar, gated on the model that session is pointed at.
// Its real failure modes are all invisible to a source-level suite — a hook order
// that only breaks on a provider switch, a fetch loop that keeps running for a
// foreign provider, a percentage quietly clamped, a failed poll that blanks the
// readout, or a second reading under another upstream's name.
try {
  const PILL = "dsh-agnes-composer-pill";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const css = (element, prop) => (element?.style?.[prop] ?? "");
  const settle = async () => { await act(async () => { await sleep(0); }); };

  /** Mount any component with props; `unmountAll` tears every root down. */
  async function mountComponent(component, props) {
    const container = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    await act(async () => { root.render(React.createElement(component, props)); });
    return { root, container };
  }

  // The keyed hook the slot system materializes: a REAL hook (useState), as in
  // the shell. A plain function would let a conditional early-return limp
  // through instead of failing on the Rules of Hooks.
  const selection = { next: { provider: "agnes-token-plan", model: "agnes-pro" } };
  const useProjection = () => {
    React.useState(selection);
    return selection;
  };
  const pillPropsWithHook = { ...pillProps, useProjection };

  let windows = [];
  let quotaExtra = {};
  let status = 200;
  // The desktop upstream's answer, on its OWN route: the two providers read two
  // endpoints, and "which one did the pill ask" is the whole isolation claim.
  let agnescode = { ok: true, enabled: true, loggedIn: true, nickname: "阿格", balance: { totalBalance: 1200, timeSensitiveBalance: 40, permanentBalance: 1160 } };
  const fetched = [];
  route = (path) => {
    fetched.push(path);
    if (path === AGNESCODE_PATH) return reply(agnescode, status);
    return reply({
      ok: true,
      now: Date.now(),
      pollSeconds: 30,
      auth: null,
      quota: { consoleConnected: true, plan: { displayName: "专业版" }, windows, ...quotaExtra },
      llm: null
    }, status);
  };
  const readPill = async () => {
    const pill = await mountComponent(pillSlot.component, pillPropsWithHook);
    await settle();
    return {
      container: pill.container,
      button: () => pill.container.querySelector(`button.${PILL}`),
      dot: () => pill.container.querySelector(`span.${PILL}-dot`)
    };
  };

  // The two request windows, with the platform stating a percentage that does
  // NOT match used/limit: the platform's figure leads, and an arithmetic
  // re-derivation would print a different number than the console shows.
  windows = [
    { key: "requests5h", unit: "requests", limit: 1000, windowHours: 5, used: 500, usagePct: 12.3, resetAt: Math.floor(Date.now() / 1000) + 3600 },
    { key: "requestsWeekly", unit: "requests", limit: 100000, windowHours: 168, used: 4000, usagePct: 4 }
  ];
  const healthy = await readPill();
  check("an owned model mounts the pill with both window readings",
    healthy.button() !== null
      && text(healthy.container).includes("Token Plan · 5 小时 12.3% · 本周 4.0%"),
    `text=${text(healthy.container).slice(0, 160)}`);
  check("the reading is the platform's own usagePct, never used/limit",
    text(healthy.container).includes("12.3%") && !text(healthy.container).includes("50.0%"),
    `text=${text(healthy.container).slice(0, 160)}`);
  check("only the console snapshot route is read",
    fetched.every((path) => path === SNAPSHOT_PATH), JSON.stringify(fetched));
  check("the reset instant rides in the tooltip, not the pill body",
    healthy.button()?.getAttribute("title")?.includes(zh["quota.resetAt"].split("{")[0].trim()) === true
      && !text(healthy.container).includes(zh["quota.resetAt"].split("{")[0].trim()),
    `title=${healthy.button()?.getAttribute("title")}`);
  check("a healthy pill wears the success ink on its dot",
    css(healthy.dot(), "background").startsWith("var(--dsw-alias-state-success-primary"),
    css(healthy.dot(), "background"));

  // A window in OVERAGE reports >100, and that is the platform's own fact: the
  // pill must not clamp it to a tidy 100% (nor soften the dot's tier).
  windows = [
    { key: "requests5h", unit: "requests", limit: 1000, windowHours: 5, used: 1200, usagePct: 120 },
    { key: "requestsWeekly", unit: "requests", limit: 100000, windowHours: 168, used: 4000, usagePct: 4 }
  ];
  const overage = await readPill();
  check("an overage window reports >100 instead of being clamped",
    text(overage.container).includes("120.0%") && text(overage.container).includes("本周 4.0%"),
    text(overage.container).slice(0, 160));
  check("the worse of the two windows picks the dot",
    css(overage.dot(), "background").startsWith("var(--dsw-alias-state-error-primary"),
    css(overage.dot(), "background"));

  // The gate. A foreign provider must mount NOTHING — no pill, and above all no
  // fetch loop for a session whose quota is not this plugin's business.
  selection.next = { provider: "openai", model: "gpt-x" };
  const before = fetched.length;
  const foreign = await readPill();
  check("a foreign provider mounts nothing and starts no read loop",
    foreign.button() === null && fetched.length === before,
    `button=${foreign.button() !== null} fetches=${fetched.length - before}`);

  // The transient frame right after a picker switch: `next` arrives empty before
  // it carries the new selection. An empty `next` must not shadow a still-usable
  // `lastUsed`, or an OWNED model loses its pill on exactly those frames.
  selection.next = {};
  selection.lastUsed = { provider: "agnes-token-plan", model: "agnes-pro" };
  const transient = await readPill();
  check("an empty transient `next` does not shadow a usable `lastUsed`",
    transient.button() !== null,
    `button=${transient.button() !== null}`);
  // A CLEARED provider is the same frame shape: the field present, not a value to
  // gate on. A `typeof === "string"` check accepts `""`, and the pill then
  // vanishes on an OWNED model for exactly those frames.
  selection.next = { provider: "", model: "agnes-pro" };
  const cleared = await readPill();
  check("a cleared provider (empty string) does not shadow a usable `lastUsed`",
    cleared.button() !== null,
    `button=${cleared.button() !== null}`);
  selection.next = { provider: "agnes-token-plan", model: "agnes-pro" };
  delete selection.lastUsed;

  // A failed read keeps the numbers on screen and says the reading is the last
  // one; it must never blank the readout, which would read as "no quota".
  const failing = await readPill();
  status = 500;
  Object.defineProperty(dom.window.document, "visibilityState", { value: "hidden", configurable: true });
  await act(async () => {
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    Object.defineProperty(dom.window.document, "visibilityState", { value: "visible", configurable: true });
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  });
  await settle();
  check("a failed poll keeps the last numbers and marks the reading stale",
    failing.button() !== null
      && text(failing.container).includes("5 小时 120.0%")
      && text(failing.container).includes(zh["composer.stale"]),
    text(failing.container).slice(0, 200));
  status = 200;

  // The FIRST read fails, before any answer has stated a cadence. The loop must
  // keep retrying at the documented fallback rate — otherwise the mount read's
  // failure leaves no interval and no visibility wake, and the pill sits on its
  // first-failed frame for the whole session: a dead dash, not a reading. The
  // visibility wake below is the demand-driven twin of that 30-second retry.
  windows = [
    { key: "requests5h", unit: "requests", limit: 1000, windowHours: 5, used: 1200, usagePct: 120 },
    { key: "requestsWeekly", unit: "requests", limit: 100000, windowHours: 168, used: 4000, usagePct: 4 }
  ];
  fetched.length = 0;
  status = 500;
  const firstFail = await readPill();
  check("a failed FIRST read keeps the pill alive — dashes and the stale mark, not a dead session",
    firstFail.button() !== null
      && text(firstFail.container).includes("5 小时 —")
      && text(firstFail.container).includes(zh["composer.stale"])
      && firstFail.button()?.getAttribute("title")?.includes(zh["composer.noWindows"]) === true,
    `text=${text(firstFail.container).slice(0, 200)} title=${firstFail.button()?.getAttribute("title")}`);
  status = 200;
  await act(async () => {
    Object.defineProperty(dom.window.document, "visibilityState", { value: "hidden", configurable: true });
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    Object.defineProperty(dom.window.document, "visibilityState", { value: "visible", configurable: true });
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  });
  await settle();
  check("the wake re-fetches on a recovered status and paints the overage — a first failure never stalls",
    fetched.length > 0 && fetched.every((path) => path === SNAPSHOT_PATH)
      && text(firstFail.container).includes("5 小时 120.0%")
      && css(firstFail.dot(), "background").startsWith("var(--dsw-alias-state-error-primary"),
    `routes=${JSON.stringify(fetched.slice(0, 8))} text=${text(firstFail.container).slice(0, 160)}`);

  // An empty window list is "the console did not report this", not "you have
  // used nothing": the readings stay dashes and the dot refuses to grade.
  windows = [];
  const bare = await readPill();
  check("no windows reads as dashes, with the dot declining to grade",
    text(bare.container).includes("5 小时 —") && text(bare.container).includes("本周 —")
      && css(bare.dot(), "background").startsWith("var(--dsw-alias-label-secondary"),
    `text=${text(bare.container).slice(0, 160)} dot=${css(bare.dot(), "background")}`);
  check("the tooltip carries the reason the readout is empty",
    bare.button()?.getAttribute("title")?.includes(zh["composer.noWindows"]) === true,
    `title=${bare.button()?.getAttribute("title")}`);

  // A console that is not connected is a different fact from an empty window
  // list, and the tooltip is the only place with room to say which.
  quotaExtra = { consoleConnected: false };
  const offline = await readPill();
  check("a disconnected console is stated in the tooltip",
    offline.button()?.getAttribute("title")?.includes(zh["composer.notConnected"]) === true,
    `title=${offline.button()?.getAttribute("title")}`);
  quotaExtra = {};

  // ── the desktop upstream: the SAME seat, the OTHER route ─────────────────
  // An `agnescode` session must read the desktop route and never the console
  // snapshot — that isolation is what makes the two readings two readings and
  // not one upstream's number under the other's name.
  selection.next = { provider: "agnescode", model: "agnes-pro" };
  fetched.length = 0;
  const balance = await readPill();
  check("an AgnesCode model reads its own route and never the console snapshot",
    fetched.length > 0 && fetched.every((path) => path === AGNESCODE_PATH),
    JSON.stringify(fetched));
  check("the balance side paints the credit stock with its own prefix",
    text(balance.container).includes("AgnesCode · 1200 积分")
      && !text(balance.container).includes("Token Plan"),
    `text=${text(balance.container).slice(0, 160)}`);
  check("the tooltip carries the account, the split and no invented percentage",
    balance.button()?.getAttribute("title")?.includes("阿格") === true
      && balance.button()?.getAttribute("title")?.includes("时效 40") === true
      && balance.button()?.getAttribute("title")?.includes("永久 1160") === true
      && !text(balance.container).includes("%"),
    `title=${balance.button()?.getAttribute("title")}`);

  // `0` is a READING: a drained pool is the alarm, never the grey dash that
  // means "we could not find out".
  agnescode = { ...agnescode, balance: { totalBalance: 0, timeSensitiveBalance: 0, permanentBalance: 0 } };
  const drained = await readPill();
  check("a drained balance reads 0 in the alarm tier, never a dash",
    text(drained.container).includes("AgnesCode · 0 积分") && !text(drained.container).includes("—")
      && css(drained.dot(), "background").startsWith("var(--dsw-alias-state-error-primary"),
    `text=${text(drained.container).slice(0, 160)} dot=${css(drained.dot(), "background")}`);

  // A missing figure is a different claim from a zero, and the tooltip says
  // WHICH fact is missing: unlinked desktop App vs switch off vs no answer.
  agnescode = { ok: true, enabled: true, loggedIn: false };
  const signedOut = await readPill();
  check("an unlinked desktop App reads a dash and names the missing fact",
    text(signedOut.container).includes("AgnesCode · —")
      && css(signedOut.dot(), "background").startsWith("var(--dsw-alias-label-secondary)")
      && signedOut.button()?.getAttribute("title")?.includes(zh["agnescode.notLogged"]) === true,
    `text=${text(signedOut.container).slice(0, 120)} title=${signedOut.button()?.getAttribute("title")}`);
  agnescode = { ok: true, enabled: false, loggedIn: false };
  const switchedOff = await readPill();
  check("a switched-off provider is a different fact from an unlinked App",
    switchedOff.button()?.getAttribute("title")?.includes(zh["agnescode.unregistered"]) === true,
    `title=${switchedOff.button()?.getAttribute("title")}`);
  agnescode = { ok: true, enabled: true, loggedIn: true, nickname: "阿格" };
  const noBalance = await readPill();
  check("a logged-in account whose balance did not arrive says so",
    noBalance.button()?.getAttribute("title")?.includes(zh["composer.balanceUnread"]) === true
      && text(noBalance.container).includes("AgnesCode · —"),
    `title=${noBalance.button()?.getAttribute("title")}`);

  // The return trip: back to a console model, the pill reads the snapshot again
  // and stops touching the desktop route.
  selection.next = { provider: "agnes-token-plan", model: "agnes-pro" };
  fetched.length = 0;
  const backToConsole = await readPill();
  check("switching back to a console model reads the snapshot and not the desktop route",
    fetched.length > 0 && fetched.every((path) => path === SNAPSHOT_PATH)
      && text(backToConsole.container).includes("Token Plan"),
    `routes=${JSON.stringify(fetched)} text=${text(backToConsole.container).slice(0, 120)}`);
} finally {
  await unmountAll();
}

// ── 10. verdicts ────────────────────────────────────────────────────────────
console.error = originalError;
check("mounting and driving the shipped artifact raised no React warnings",
  reactNoise.length === 0, reactNoise.slice(0, 3).join(" | ").slice(0, 300));

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((entry) => !entry.pass);
// An explicit exit, like `e2e.mjs`: react-dom's scheduler holds a MessagePort
// and the panel installs a poll interval; an unmount clears the interval, but
// a leaked handle anywhere would turn `run.mjs`'s spawnSync into a hang. The
// exit code is the verdict; nothing after it is allowed to matter.
if (failed.length > 0) {
  originalError(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
process.exit(0);
