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
/** The slot declaration + component `apply` registers, exactly as the shell would capture them. */
const slot = {};
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
      slot.name = name;
      const dispose = register();
      return () => typeof dispose === "function" ? dispose() : undefined;
    },
    register: (decl, component) => {
      slot.decl = decl;
      slot.component = component;
      return () => {};
    }
  }
};
instance.apply(ctx);
const { zh, en } = dictionaries;

check("apply registers both dictionaries under the plugin namespace",
  dictionaries.ns === "dsh-connect-agnes-token-plan"
    && Object.keys(zh ?? {}).length > 0 && Object.keys(en ?? {}).length > 0,
  `ns=${String(dictionaries.ns)} zh=${Object.keys(zh ?? {}).length} en=${Object.keys(en ?? {}).length}`);
check("apply registers the config card into the shell's slot",
  slot.name === "plugins.bundle.config" && typeof slot.component === "function",
  `slot=${String(slot.name)} component=${typeof slot.component}`);

// The props the shell would hand the page: `decl.inject()` is the REAL pair
// (`tt` bound to this namespace, the locale subscription face).
const pageProps = typeof slot.decl?.inject === "function" ? slot.decl.inject() : {};
check("the slot declaration injects a live tt that resolves real text",
  typeof pageProps.tt === "function" && pageProps.tt("panel.loading") === zh["panel.loading"],
  String(pageProps.tt?.("panel.loading")));

// ── 4. a scripted fetch: the panel's only door to the Host ──────────────────
const { SNAPSHOT_PATH, ACCOUNT_PATH, MODELS_PATH } = await import("../src/client/const.ts");
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
