/**
 * The panel's own decisions, run against the code the browser actually loads.
 *
 * There is no mirror here AND no source-scraping: `panel-decision.js` loads
 * client.js as a module (via `client-surface.js`) and calls the functions the
 * browser calls, so these checks fail when the PANEL's behaviour changes —
 * not when a hand-written copy changes, and not when the client's formatting
 * changes. The cases that matter most are the throttle fields, which the old
 * mirror did not model at all: the greying-out added to stop a bad password
 * becoming a lockout was, as a consequence, entirely uncovered.
 */
import { readFile, readdir } from "node:fs/promises";
import { decidePanelView, agnescodeView, dictionaries, interpretSnapshot, tables, RENDER, viewOf as clientSurfaceViewOf } from "./panel-decision.js";
import { servedWaitUntil, servedWaitMs } from "../src/client/snapshot.ts";
import { AUTH_FAILURE_CODES, CODE, CREDENTIAL_REFUSALS, NO_LOGIN_CODES } from "../src/host/codes.ts";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

/**
 * Drive a raw Host response through the panel's own pipeline.
 *
 * This is the point of the module: the bytes below are what the Host actually
 * sends, and they go through the panel's REAL reading and REAL decision.
 * @param {unknown} body - the parsed snapshot response.
 * @returns {object} the view model.
 */
function view(body) {
  const read = interpretSnapshot(body);
  return decidePanelView(read.data, read.error);
}

const healthy = {
  ok: true,
  pools: { pools: [{ id: "pool-1", name: "通用池" }] },
  trend: { models: [] },
  auth: { configured: true, hasAccount: true, hasRefreshToken: true, needsAccount: false, ephemeral: false, retryAfterMs: null }
};

// === A. a working panel renders the pools ================================
{
  const result = view(healthy);
  check("a working panel renders the pools", result.render === RENDER.PANELS, result.render);
  check("a working panel is not asked for setup", result.needsSetup === false);
  check("the account editor is offered", result.canManageAccount === true);
  check("a healthy panel is not waiting", result.coolingMs === null, String(result.coolingMs));
  check("a healthy panel asks for nothing", result.needsUserAction === false);
}

// === B. THE REPORTED BUG: a Host response with no `auth` field ===========
// A Host whose response carried no `auth` left the panel with `auth === null`,
// and the form was then unreachable. This is the legacy shape: `ok:false` and
// nothing else. The missing field must not read as "everything is fine".
{
  const result = view({ ok: false, error: "no console account is configured", code: "not_configured" });
  check("a legacy payload without auth reaches the form", result.render === RENDER.FORM, result.render);
  check("the missing field reads as not needing setup", result.needsSetup === true);
  check("the reason still names the missing account", result.guidanceKey === "panel.jwtMissing",
    String(result.guidanceKey));
}

// === B2. THE CLEARED-ACCOUNT DEAD END: `ok:true` after forget ============
// "Forget the saved account" keeps the refresh grant breathing, so the next
// poll still answers `ok:true` with empty pools. `data` is non-null, so the
// `!data` setup form never mounts; if the account section card were gated on
// `hasAccount` alone (false right after a forget), the user was locked out
// of their own account — no re-entry path. The card is therefore shown
// UNCONDITIONALLY whenever the snapshot carries the Host's auth block:
// the MIDDLE state (grant still alive: `hasAccount` false, `needsAccount`
// false, `configured` true) and the dead-grant state both keep the editor
// on screen, so a cleared account always has a re-entry path.
{
  const midState = {
    ok: true,
    pools: { pools: [] },
    trend: { models: [] },
    auth: { configured: true, hasAccount: false, hasRefreshToken: true, needsAccount: false, retryAfterMs: null }
  };
  const dead = {
    ok: true,
    pools: { pools: [] },
    trend: { models: [] },
    auth: { configured: false, hasAccount: false, hasRefreshToken: false, needsAccount: true, retryAfterMs: null }
  };
  const mid = view(midState);
  check("grant still alive: the account editor stays on screen", mid.canManageAccount === true,
    JSON.stringify(mid.auth));
  check("grant still alive: the panel still reads quota", mid.render === RENDER.PANELS, mid.render);
  const deadResult = view(dead);
  check("grant dead: the account editor stays on screen", deadResult.canManageAccount === true,
    JSON.stringify(deadResult.auth));
  check("grant dead: the panel still answers (empty), no setup form",
    deadResult.render === RENDER.PANELS, deadResult.render);
}

// === C. a config error must NOT hide behind the form ====================
{
  const result = view({ ok: false, error: "bad endpoint override", code: "config_error" });
  check("a config error shows text, not the form", result.render === RENDER.TEXT, result.render);
  check("a config error still explains itself", result.guidanceKey === "panel.configError",
    String(result.guidanceKey));
}

// === D. a transport error and a malformed body are not success ===========
{
  const transport = decidePanelView(null, "network down");
  check("a transport error reaches the form", transport.render === RENDER.FORM, transport.render);
  check("a transport error carries no auth", transport.auth === null);
  // `ok` missing entirely: the Host never sends this, and it must not read as
  // a working panel.
  const malformed = view({ pools: {} });
  check("a body with no `ok` is not a working panel", malformed.render !== RENDER.PANELS, malformed.render);
  check("a body with no `ok` reaches the form", malformed.render === RENDER.FORM, malformed.render);
}

// === E. THE THROTTLE: a lockout greys the form, with the platform's number =
{
  const locked = {
    ok: false,
    error: "login failed: The account has been locked",
    code: "account_locked",
    auth: { configured: false, hasAccount: true, retryAfterMs: 8 * 60_000, needsUserAction: false }
  };
  const result = view(locked);
  check("a served wait reaches the panel", result.coolingMs === 8 * 60_000, String(result.coolingMs));
  check("a lockout does not ask for a corrected password", result.needsUserAction === false);
  check("a locked account reaches the form", result.render === RENDER.FORM, result.render);
  // The button is greyed while cooling, and the message states the platform's
  // own number so the reason it is disabled is never a mystery.
  const minutes = Math.max(1, Math.ceil(result.coolingMs / 60_000));
  check("a cooling panel shows the platform's own minutes", minutes === 8, String(minutes));
}

// === F. THE THROTTLE: a wrong password is parked, not counted down =======
// A countdown here would be a lie: when it reached zero no retry would happen,
// because waiting cannot make a wrong password right. The button must stay
// usable, because retyping IS the fix.
{
  const parked = {
    ok: false,
    error: "login failed: invalid account or password",
    code: "login_rejected",
    auth: { configured: false, hasAccount: true, retryAfterMs: null, needsUserAction: true }
  };
  const result = view(parked);
  check("a parked refusal shows no countdown", result.coolingMs === null, String(result.coolingMs));
  check("a parked refusal asks the user to act", result.needsUserAction === true);
  check("a parked refusal leaves the submit button usable", result.coolingMs === null);
  check("a wrong password still reaches the form", result.render === RENDER.FORM, result.render);
}

// === F1. THE SHAPE THAT SPLIT THE TWO COPIES =============================
// Sections E and F both pass against either implementation, and that is
// exactly why the duplication survived: E pairs a window with
// `needsUserAction: false`, F pairs `null` with `needsUserAction: true`, so
// neither one reaches the case where the two halves disagree.
//
// The Host itself never SERVES that shape — `inForceWaitMs` returns `null`
// whenever the throttle is parked, and `until` is `null` for a parked record —
// but the panel's own POST path does: `routes/account.ts` copies the platform's
// stated window into the response body while `needsUserAction` comes from the
// throttle's `parked` flag, so a captcha answered with `Retry-After: 7200`
// produces `parked: true` AND a two-hour window in the same body. That
// combination is what `AccountForm` now obeys, so it is the combination the
// view model has to answer for.
//
// Before the fix, this one input got two verdicts: `coolingMs` said "cooling,
// 2 hours" (it only looked at `retryAfterMs`) while the function the button
// actually obeys said "nothing pending" (it returns nothing for parked). The
// assertions below are the negative control that would have caught it.
{
  const both = {
    ok: false,
    error: "login failed: verification required",
    code: "verification_required",
    auth: { configured: false, hasAccount: true, retryAfterMs: 2 * 3600_000, needsUserAction: true }
  };
  const result = view(both);
  check("a parked refusal carrying a window counts down nothing (the two copies used to disagree)",
    result.coolingMs === null, String(result.coolingMs));
  // The wait is real on the wire and the button must be usable anyway: no clock
  // reaching zero will satisfy a captcha. This is the pair that says so out
  // loud, so it must be present even when the countdown is absent.
  check("that same refusal asks the user to act, not to wait",
    result.needsUserAction === true, String(result.needsUserAction));
  check("the view model agrees with the rule the button obeys",
    (result.coolingMs === null) === (servedWaitMs(both.auth) === null),
    `view=${String(result.coolingMs)} rule=${String(servedWaitMs(both.auth))}`);
}

// === F2. a console failure must NOT hide behind the login form ===========
// The old test read "any failure without data reaches the form", which made
// an unreachable console look like a sign-in problem: the user was asked for a
// password for an outage, and the reason was never on screen.
{
  const down = {
    ok: false,
    error: "console returned HTTP 502",
    code: "console_error",
    auth: { configured: true, hasAccount: true, hasRefreshToken: true, needsAccount: false, retryAfterMs: null }
  };
  const result = view(down);
  check("a console failure shows text, not the form", result.render === RENDER.TEXT, result.render);
  check("a console failure is not asked for setup", result.needsSetup === false);
  check("a console failure still says what happened",
    result.failure?.message === "console returned HTTP 502", String(result.failure?.message));
  // A locked account is the opposite case: the account IS the thing to fix.
  const locked = view({
    ok: false, error: "login failed: locked", code: "account_locked",
    auth: { configured: false, hasAccount: true, needsAccount: false, retryAfterMs: 8 * 60_000 }
  });
  check("a lockout still reaches the form", locked.render === RENDER.FORM, locked.render);
}

// === F2b. the panel only branches on codes the plugin declares ===========
// client.js is a browser bundle and cannot import codes.js, so it ships its
// own tables — GUIDANCE_BY_CODE, REFUSAL_TEXT, FORM_EXCLUDED_CODES. It cannot
// share the taxonomy, but it must not contradict one: these are semantic
// assertions on the REAL tables the browser uses (the old version regexed the
// source text for literals, which could only ever see spellings, never
// meaning).
{
  const declared = new Set(Object.values(CODE));
  const guided = Object.keys(tables.GUIDANCE_BY_CODE);
  const refusals = Object.keys(tables.REFUSAL_TEXT);
  const excluded = [...tables.FORM_EXCLUDED_CODES];
  const handled = [...new Set([...guided, ...refusals, ...excluded])];
  const unknown = handled.filter((code) => !declared.has(code));
  check("the panel's tables were read from the shipped client", handled.length >= 6,
    handled.join(", "));
  check("every code the panel branches on is declared in codes.js", unknown.length === 0, unknown.join(", "));
  // The REVERSE direction — the half that was missing, and the gap it hid was
  // found live rather than here. Every auth failure can now reach the panel as
  // `quota.error.code`, because the console probe degrades instead of rejecting
  // the whole body; before that change they all arrived as a whole-body
  // `ok:false`, where only the top-level `code` mattered and this table was
  // consulted for a much smaller set. A stored account whose sign-in the
  // platform refused answers `login_rejected` — which had no line, so the panel
  // fell back to a generic "console not connected" and lost the one thing the
  // reader needed (re-enter the password).
  //
  // The obligation is `AUTH_FAILURE_CODES ∪ NO_LOGIN_CODES`: a code that can be
  // reported to the reader must have something to say to them.
  const reachable = [...new Set([...AUTH_FAILURE_CODES, ...NO_LOGIN_CODES])];
  const unguided = reachable.filter((code) => !(code in tables.GUIDANCE_BY_CODE));
  check("every code that can reach the panel as quota.error has guidance",
    unguided.length === 0, unguided.join(", "));
  check("the panel can tell a console failure from an auth failure",
    handled.includes(CODE.CONSOLE_ERROR) && handled.includes(CODE.AUTH_ERROR),
    handled.join(", "));
  // The declaration lives in codes.js; the client copy is pinned to it, so a
  // code added to either side only fails here instead of quietly changing
  // what the form does.
  check("the form-excluded set equals codes.js NO_LOGIN_CODES",
    excluded.length === NO_LOGIN_CODES.size && excluded.every((code) => NO_LOGIN_CODES.has(code)),
    excluded.join(", "));
  // Every credential refusal is the user's to correct, so the form must have
  // a line of text for it — this is the check that would have caught the
  // historical bug where account_locked was produced but never recognised.
  const untexted = [...CREDENTIAL_REFUSALS].filter((code) => !(code in tables.REFUSAL_TEXT));
  check("every credential refusal has a form line", untexted.length === 0, untexted.join(", "));
  // No auth failure may be hidden behind the "no login can fix this" wall:
  // each of them is answered by signing in, which is what the form offers.
  const hidden = [...AUTH_FAILURE_CODES].filter((code) => tables.FORM_EXCLUDED_CODES.has(code));
  check("no auth-failure code is hidden from the form", hidden.length === 0, hidden.join(", "));

  // The tables cover every code, but the client also BRANCHES on one outside
  // them: which refusal starts the cooldown, which one the platform refused
  // without a reason this table knows, which status means the token is gone.
  // Those comparisons used to spell the code out at the call site — a fourth
  // copy nothing above looked at, so a rename in codes.ts would have sailed
  // through. Both are pinned here.
  const clientCodes = Object.values(tables.CLIENT_CODE ?? {});
  check("every code the client branches on outside the tables is declared",
    clientCodes.length > 0 && clientCodes.every((code) => declared.has(code)),
    clientCodes.join(", "));

  // The reverse direction, source-level: no component may spell a wire code
  // out as a string literal in a comparison. Comments are stripped first, so
  // the doc prose that QUOTES a code as an example stays untouched while the
  // real branches are what the check sees. Every client file is scanned, not a
  // hand list — a branch added to a file the list forgot would otherwise be
  // invisible to this fence — except `format.ts`, whose `code` is a CURRENCY
  // (`cny`/`rmb`/`usd`) and not a taxonomy.
  const stripped = (await Promise.all(
    (await readdir(new URL("../src/client/", import.meta.url)))
      .filter((f) => f.endsWith(".ts") && f !== "format.ts")
      .map((f) => readFile(new URL(`../src/client/${f}`, import.meta.url), "utf8"))
  )).join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const literals = [...stripped.matchAll(/code\s*(?:===|!==)\s*"([^"]+)"/g)].map((m) => m[1]);
  const undeclared = literals.filter((code) => !declared.has(code));
  // Liveness first: a scan that read nothing (a renamed directory, a missing
  // file) would pass on the empty set — the same §39 failure the anchors guard
  // against, so a file that must be scanned is named as the proof.
  const scanAlive = stripped.includes("CLIENT_CODE.LOGIN_FAILED");
  check("the wire-code scan read the client source", scanAlive, `read ${stripped.length} chars`);
  if (scanAlive) {
    check("no comparison spells a wire code out at the call site", undeclared.length === 0,
      undeclared.join(", "));
  }
}

// === F3. the two dictionaries carry the same keys ========================
// A key added to one language only is invisible in one and renders as a raw
// key in the other — which is how `panel.shapeDrift` shipped with a Chinese
// dictionary that could not display it.
{
  const zhKeys = Object.keys(dictionaries.zh).sort();
  const enKeys = Object.keys(dictionaries.en).sort();
  check("the dictionaries were read from the shipped client", zhKeys.length > 20 && enKeys.length > 20,
    `zh=${zhKeys.length} en=${enKeys.length}`);
  const onlyZh = zhKeys.filter((key) => !enKeys.includes(key));
  const onlyEn = enKeys.filter((key) => !zhKeys.includes(key));
  check("no key exists only in Chinese", onlyZh.length === 0, onlyZh.join(", "));
  check("no key exists only in English", onlyEn.length === 0, onlyEn.join(", "));
}

// === F3b. every dictionary key is reachable from the client ================
// The reverse of F3: a key nobody reads. Unlike the parity gap it never shows a
// symptom — a dead key renders nothing, so it is invisible in the UI and can
// keep asserting a state nobody sees. `entry.label` sat there for several
// releases naming a sidebar card the panel stopped having, and a dozen
// refactored keys (`quota.vision*` left behind by the `pool.` rename, the
// `badgeAuto`/`badgePinned` pair that `badge` + `effective` replaced) had
// collected around it. Reachability is checked the three ways the client
// actually reaches a key:
//   · the key's quoted form in src/client — covers `tt("k")`, a
//     `tt(cond ? "a" : "b")` branch, and the code→key tables (REFUSAL_TEXT,
//     GUIDANCE_BY_CODE) that hand a key to the caller's own `tt`
//   · a dynamic head from `tt(`head${x}`)` — the head is a live prefix, its
//     suffix comes from the Host's data and cannot be enumerated here
//   · `k("s")` = `tt(`${prefix}.${s}`)` composed with the prefix literals the
//     shared ToolSwitch receives at its two call sites ("draw", "video")
// A fourth indirection is a change to make here, not a reason to let the
// dictionary rot again.
{
  const source = (await Promise.all(
    (await readdir(new URL("../src/client/", import.meta.url)))
      .filter((name) => name.endsWith(".ts") && name !== "i18n.ts")
      .map((name) => readFile(new URL(`../src/client/${name}`, import.meta.url), "utf8"))
  )).join("\n");
  // `k()` in ToolSwitch is `tt(`${prefix}.${suffix}`)`, whose captured head is
  // EMPTY — and `key.startsWith("")` is true for every key, so an unfiltered
  // empty head makes this check able to fail on nothing. Those keys are the
  // `composed` set below, so the empty head is dropped, not kept.
  const dynHeads = [...new Set([...source.matchAll(/tt\(\s*`([^`$]*)\$\{/g)].map((m) => m[1]))]
    .filter((head) => head !== "");
  const composed = new Set(
    [...new Set([...source.matchAll(/\bk\(\s*"([^"]+)"/g)].map((m) => m[1]))].flatMap((suffix) =>
      [...new Set([...source.matchAll(/prefix:\s*"([^"]+)"/g)].map((m) => m[1]))]
        .map((prefix) => `${prefix}.${suffix}`)
    )
  );
  const dead = Object.keys(dictionaries.zh).sort().filter(
    (key) => !source.includes(`"${key}"`)
      && dynHeads.some((head) => key.startsWith(head)) === false
      && !composed.has(key)
  );
  check("every dictionary key is reachable from the client", dead.length === 0, dead.join(", "));
}

// === F4. the panel's rhythm comes from the Host, not from a literal ======
// The bundle used to hold "poll every 30 s" and "cached 60s" as numbers while
// the Host held the real ones. Those are the kind of pair that drifts the first
// time either side is tuned, so the bundle is checked for literals rather than
// for behaviour it cannot exercise here.
//
// The first version of this check only looked at `setInterval(run, …)` and at
// `cache: data?.cacheSeconds` — and BOTH literals it was written to kill
// survived it: `useState(30_000)` sat outside the regex's reach, and
// `?? 60` matched the cache pattern happily. A guard whose prose claims more
// than the guard checks is worse than no guard, so the three cases are now
// pinned separately, each against the shape that would reintroduce it.
//
// The check targets the POLL timer specifically: `setInterval(run, cadenceMs)`
// in `PanelPage`, whose cadence the Host states in every snapshot. The form's
// 1-second countdown timer is unrelated to polling and may stay a literal.
{
  const source = await readFile(new URL("../src/client/panel-page.ts", import.meta.url), "utf8");
  const pollTimers = source.match(/setInterval\(run,\s*[^)]*\)/g) ?? [];
  check("the poll timer takes a stated cadence, not a literal",
    pollTimers.length === 1 && /\d/.test(pollTimers[0]) === false,
    pollTimers.join(" | "));
  check("the cache note quotes the snapshot's own number",
    /format\(tt\("note"\),\s*\{\s*cache:\s*data\.cacheSeconds\s*\}\)/.test(source),
    (source.match(/cache:[^,}]*cacheSeconds[^)]*\)/g) ?? []).join(" | "));

  // The cadence STATE must start unknown, not at a number that duplicates the
  // Host's own default. `useState(30_000)` was exactly the second spelling of
  // `CONFIG_DEFAULTS.pollSeconds` this check was written to prevent, and it sat
  // one line above the timer the old pattern looked at.
  const cadenceInit = source.match(/\[cadenceMs,\s*setCadenceMs\]\s*=\s*useState[^;]*/);
  check("the cadence state starts unknown (null), not at a Host-default literal",
    cadenceInit !== null && /useState<number \| null>\(null\)/.test(cadenceInit[0]),
    cadenceInit === null ? "(no useState for cadenceMs found)" : cadenceInit[0]);

  // And the cache note must have no numeric fallback either: a `?? <number>`
  // here is the "cached 60s" literal wearing a different hat. A snapshot that
  // states no cache age gets the no-number variant instead.
  const noteLine = source.match(/tt\("note(?:\.noCache)?"\)[^;]*/g) ?? [];
  check("the cache note has no numeric fallback for an unstated age",
    noteLine.length > 0 && noteLine.every((line) => !/cacheSeconds\s*\?\?\s*\d/.test(line)),
    noteLine.join(" | "));
  check("an unstated cache age falls back to the numberless variant",
    /tt\("note\.noCache"\)/.test(source), noteLine.join(" | "));
}

// === F5. the API tab's card order and its open-by-default set ==============
// The three cards answer "what did the reader come here for", not "what
// depends on what": 语言模型 and 出图工具 lead and open, the API key editor
// trails because it is the PREREQUISITE they point back at. Both halves have
// drifted before — the cards were reordered once while a hint inside one of
// them still said 「在上方保存 API Key」, pointing at a card that had moved
// below it. So: pin the order, pin the defaults, and pin the hint to a CARD
// NAME rather than a direction (a name survives a reorder, "上方" does not).
{
  const source = await readFile(new URL("../src/client/panel-page.ts", import.meta.url), "utf8");
  const order = [...source.matchAll(/title:\s*tt\("([^"]+)"\)/g)].map((m) => m[1]);
  const at = (key) => order.indexOf(key);
  check("the API tab's three cards are all rendered as sections",
    at("llm.providerTitle") >= 0 && at("draw.title") >= 0 && at("llm.title") >= 0,
    order.join(" | "));
  check("语言模型 leads, 出图工具 follows, API Key trails last",
    at("llm.providerTitle") < at("draw.title") && at("draw.title") < at("llm.title"),
    `providerTitle@${at("llm.providerTitle")} draw@${at("draw.title")} llm@${at("llm.title")}`);

  // `openSections` is the FIRST half of a destructured pair, so the `=` sits
  // after `setOpenSections]` — anchoring on `openSections\s*=useState` matches
  // nothing and silently degrades to "no defaults found" (which reads as a
  // pass if the empty object is not itself checked).
  const defaults = Object.fromEntries(
    [...(source.match(/\[openSections,[^\n]*useState\(\{([^}]*)\}\)/)?.[1] ?? "")
      .matchAll(/(\w+):\s*(true|false)/g)].map((m) => [m[1], m[2] === "true"])
  );
  check("the panel's open-by-default map was actually read (not silently empty)",
    Object.keys(defaults).length >= 6, JSON.stringify(defaults));
  check("语言模型 and 出图工具 start expanded, the key editor starts collapsed",
    defaults.provider === true && defaults.draw === true && defaults.llm === false,
    JSON.stringify(defaults));

  // A cross-card hint must name the card, never point up or down: the two
  // cards it connects have already swapped places once.
  const dict = dictionaries.zh;
  check("the cross-card hint names the API Key card instead of a direction",
    /API Key/.test(dict["llm.rosterEmpty"] ?? "") && !/上方|下方/.test(dict["llm.rosterEmpty"] ?? ""),
    dict["llm.rosterEmpty"]);
  check("the English hint matches the Chinese one on this point",
    !/\babove\b|\bbelow\b/.test(dictionaries.en["llm.rosterEmpty"] ?? ""),
    dictionaries.en["llm.rosterEmpty"]);
}

// === F6. one route per tab, one status line per tab =======================
// The pinned bar is a shell now (`render.test.mjs` group H3 drives the decision
// behind it), and it can only say anything about AgnesCode if that tab — the
// only one with its own route and its own cadence — HANDS IT OVER. The handover
// and the failed-read line are hook-path wiring the render suite cannot mount
// (its React stand-in never runs effects), so they are pinned at the source:
// not behaviour, but the shape that behaviour needs.
{
  const source = await readFile(new URL("../src/client/agnescode-tab.ts", import.meta.url), "utf8");
  check("the AgnesCode tab publishes its own freshness + reload to the bar",
    /onStatus\?\.\(\{\s*updatedAt,\s*refresh/.test(source),
    (source.match(/onStatus[^\n]*/g) ?? []).join(" | "));
  check("that freshness is stamped when the tab's own read succeeds",
    /setUpdatedAt\(Date\.now\(\)\)/.test(source), "");
  // `error` used to be set and NEVER rendered: a failed read leaves `state`
  // null, which renders exactly like "not linked" — so the panel blamed the
  // user's desktop App for a Host that never answered.
  check("a failed /agnescode read is rendered instead of read as 'not linked'",
    /format\(tt\("agnescode\.error"\), \{ error \}\)/.test(source)
      && /state === null && error !== null/.test(source), "");

  // The shell side of the same handover, plus the annotation `docs.test.mjs`
  // check 9 derives its tab set from — naming the union would leave that check
  // with nothing to read, and it would read nothing as a pass.
  const panelSource = await readFile(new URL("../src/client/panel-page.ts", import.meta.url), "utf8");
  check("the shell passes the bar's publish callback to the AgnesCode tab",
    /AgnescodeTab, \{ tt, onStatus: publishTabStatus \}/.test(panelSource), "");
  // The refresh button used to be hard-wired to `load()` — the snapshot — so on
  // the AgnesCode tab it reloaded the data behind a tab nobody was looking at.
  check("the bar's refresh follows the plan instead of always reloading the snapshot",
    /const refresh = plan\.refresh === "agnescode"\s*\?\s*tabStatus\?\.refresh/.test(panelSource),
    (panelSource.match(/const refresh[^\n]*/g) ?? []).join(" | "));
  check("the active-tab union stays spelled out for the README check",
    /useState<"quota" \| "api" \| "agnescode">\("quota"\)/.test(panelSource), "");
}

// === G. the checks are running the shipped module, not a stale copy ======
// Reaching here at all means client.js loaded and materialized its factory.
{
  const result = view(healthy);
  check("the decision was read from the shipped client", typeof result === "object" && result !== null);
  check("the reader was read from the shipped client", typeof interpretSnapshot === "function");
  check("a successful body is read as data", interpretSnapshot(healthy).data === healthy);
  check("a failed body is read as an error", interpretSnapshot({ ok: false, code: "x" }).data === null);
}

// === The AgnesCode tab's own rendering decision =============================
//
// That tab reads its own route on its own cadence, so it never goes through
// `decidePanelView` — but what it SHOWS is the same kind of decision: a pure
// function of (last body, last error). Three of its answers were each a real
// repair, each explained at the function, and none of them had a test — so the
// next person to simplify the JSX could undo any of them silently.
//
// The load-bearing case is the middle one: a failed read leaves `state` at its
// LAST GOOD value (the tab never calls `setState(null)`), so the interesting
// input is not "never read" but "read once, then failed". Get that wrong in
// either direction and the tab either accuses a signed-in desktop App of being
// signed out, or hides an account that is still there.
{
  check("the AgnesCode view decision was read from the shipped client",
    typeof agnescodeView === "function", String(typeof agnescodeView));

  // 1. Never read, and the read failed: we know NOTHING. Withhold the card —
  //    `linked` is false, so the unlinked copy would accuse the reader's
  //    desktop App of not being signed in, the one reading we have no evidence
  //    for. The error line above is the honest statement.
  const coldFail = agnescodeView(null, "unable to reach the Host");
  check("a failed read with no prior reading withholds the credential card",
    coldFail.showError === true && coldFail.credentialCard === false && coldFail.linked === false,
    JSON.stringify(coldFail));

  // 2. Never read, no failure: the ordinary first frame. The card IS shown —
  //    the harvest affordance has to be reachable — and it says "not linked",
  //    which we DO have evidence for: the route answered.
  const cold = agnescodeView(null, null);
  check("no reading and no failure shows the card, unlinked",
    cold.showError === false && cold.credentialCard === true && cold.linked === false,
    JSON.stringify(cold));

  // 3. THE case: a reading landed, then a later poll failed. The card stays UP
  //    carrying the last known account, with the error line above it. Blanking
  //    here is exactly the regression that was repaired once already, so it is
  //    pinned rather than trusted.
  const stale = agnescodeView({ loggedIn: true, nickname: "小浣" }, "HTTP 500");
  check("a later failed poll keeps the last known account on screen",
    stale.showError === true && stale.credentialCard === true && stale.linked === true,
    JSON.stringify(stale));

  // 4. A successful read carries no error line — `load` sets the two together.
  const ok = agnescodeView({ loggedIn: true, nickname: "小浣" }, null);
  check("a successful read shows the account and no error",
    ok.showError === false && ok.credentialCard === true && ok.linked === true, JSON.stringify(ok));

  // 5. `linked` is read off the state, never inferred from the ABSENCE of an
  //    error. A route answering `loggedIn: false` is a real reading saying
  //    "signed out" — no error, and still unlinked.
  const signedOut = agnescodeView({ loggedIn: false }, null);
  check("an answered 'not logged in' is unlinked without being an error",
    signedOut.showError === false && signedOut.credentialCard === true && signedOut.linked === false,
    JSON.stringify(signedOut));
}

// === Z. the decision is the CLIENT'S, and its roster is checked ============
// `decidePanelView` used to re-declare `(auth) => auth !== null` behind a
// comment claiming it imported the single source. ADR-006 records the residue;
// nobody noticed because no check could see it — the duplicate was textually
// identical to the original, so the whole panel suite said nothing.
//
// These two are the guard PITFALLS §39 asks for: the guard must be able to fail
// on the real module, not on a copy. `shouldShowAccountManagement` is imported
// from the same pure module `panel-page.ts` imports, and `viewOf`'s roster is
// asserted member-for-member so the `PanelView` typedef in `client-surface.js`
// (which had drifted to five members that no longer exist) cannot rot quietly
// again.
{
  const clientAuth = await import("../src/client/snapshot.ts");
  const canManage = clientAuth.shouldShowAccountManagement;

  check("the single-source decision is the client's own export",
    typeof canManage === "function" && canManage.length === 1,
    `type=${typeof canManage} arity=${canManage?.length}`);

  // Same answers as the decision layer, for the two cases that matter: an
  // absent auth block (nobody signed in) and a present one.
  for (const [label, auth] of [["null", null], ["an auth block", { configured: true }]]) {
    const viaClient = canManage(auth);
    const viaPanel = decidePanelView({ ok: true, auth: auth ?? undefined, quota: { consoleConnected: true } }, null).canManageAccount;
    check(`canManageAccount agrees with the client for ${label}`,
      viaClient === viaPanel, `client=${viaClient} panel=${viaPanel}`);
  }
  // And the direction that once had to be asserted by proxy: no auth → no
  // account management. If the client ever inverts this, the panel follows it
  // automatically — which is the whole point of importing rather than copying.
  check("the client's rule still refuses management without an auth block",
    canManage(null) === false && canManage({ configured: true }) === true);

  // The typedef's roster, asserted against the real return value.
  const roster = Object.keys(viewOfKeysProbe()).sort();
  const EXPECTED_VIEWOF = ["auth", "failure", "guidance", "guidanceKey", "needsSetup", "shapeWarnings"];
  check("viewOf's roster matches the documented PanelView",
    JSON.stringify(roster) === JSON.stringify(EXPECTED_VIEWOF),
    `actual=${roster.join(",")} documented=${EXPECTED_VIEWOF.join(",")}`);
}

/** The client's own `viewOf`, called on a healthy body, for the roster check. */
function viewOfKeysProbe() {
  return clientSurfaceViewOf({ ok: true, auth: { configured: true }, quota: { consoleConnected: true } }, null, (k) => k);
}

// === P. the SERVED wait, which is what the form actually obeys ============
// Sections A–F assert the panel's VIEW MODEL: that a served `retryAfterMs`
// reaches `decidePanelView`'s `coolingMs`. What they could not reach is the
// form's own seed, which is what decides whether the submit button is enabled
// on a FRESH page — and that is the case that loses an account.
//
// The Host serves the throttle because it is shared: `throttle-store.ts` keeps
// it in ONE file for every profile and process, on purpose, so a 429 taken on
// the desktop profile is honoured on the web profile too (`token-store.ts`
// spells out the reason: "a second Host process shows the same countdown
// rather than inviting an attempt that would be refused"). `AccountForm` seeded
// `cooldownUntil` from `useState(0)` and only ever learned about a window from
// its OWN failed POST, so after a refresh — or on the other profile — the
// button read enabled inside a window the Host was still serving. Because
// `saveAccount` deliberately CLEARS the throttle ("a deliberate resubmit is the
// user acting on what the panel told them"), that click did not merely fail: it
// erased the record the other process was obeying and spent a real attempt
// against a possibly-locked account.
//
// `servedWaitUntil` is the single source for that seed, imported from the real
// module (ADR-006 judgement 1: a pure rule, importable from Node), so these
// cases fail on BEHAVIOUR — rename the export or change the arithmetic and
// they go red, rather than quietly matching edited source text.
{
  const T0 = 1_700_000_000_000;
  const served = (auth) => servedWaitUntil(auth, T0);

  // The bug's exact shape: a positive window the Host is serving.
  check("a served window becomes an absolute deadline",
    served({ configured: false, hasAccount: true, retryAfterMs: 8 * 60_000, needsUserAction: false }) === T0 + 8 * 60_000,
    String(served({ retryAfterMs: 8 * 60_000 })));
  check("no window means no deadline (the button stays usable)",
    served({ configured: true, hasAccount: true, retryAfterMs: null }) === 0,
    String(served({ retryAfterMs: null })));
  check("no auth block at all means no deadline",
    served(null) === 0, String(served(null)));
  check("a missing field is not read as a wait", served({ configured: true }) === 0, String(served({})));

  // The distinctions that keep a countdown from being a lie. A PARKED refusal
  // (wrong password, captcha, invented waits spent) has no deadline: showing
  // one would tick down into an attempt that can only fail again.
  check("a parked refusal is not given a countdown",
    served({ configured: false, hasAccount: true, retryAfterMs: 60_000, needsUserAction: true }) === 0,
    String(served({ retryAfterMs: 60_000, needsUserAction: true })));
  // The window the wire type declares is `number | null` and the Host computes
  // it as `max(0, until - now)`, so 0 and negatives are reachable shapes, not
  // typos. They must read as "no wait" rather than as a deadline in the past
  // that flips the button back on for a millisecond.
  check("an elapsed window reads as no wait", served({ retryAfterMs: 0 }) === 0, String(served({ retryAfterMs: 0 })));
  check("a negative window reads as no wait", served({ retryAfterMs: -5_000 }) === 0, String(served({ retryAfterMs: -5_000 })));
  check("a non-numeric window reads as no wait", served({ retryAfterMs: "60000" }) === 0, String(served({ retryAfterMs: "60000" })));
  check("a NaN window reads as no wait", served({ retryAfterMs: Number.NaN }) === 0, String(served({ retryAfterMs: Number.NaN })));

  // The seed is `now + remaining`, NOT the raw `remaining`. Getting that
  // backwards would put the deadline decades in the past — the button would
  // read enabled forever, which is the bug again wearing a different hat. The
  // arithmetic is pinned because only the sum is correct.
  check("the deadline is now PLUS the remaining window",
    served({ retryAfterMs: 1_000 }) - T0 === 1_000,
    `delta=${served({ retryAfterMs: 1_000 }) - T0}`);

  // The dictionary line the parked branch renders. Asserted against the REAL
  // dictionaries the browser uses, because a key that exists in one language
  // only shows as a raw key in the other — invisible in the language that has
  // it, which is why `panel.test.mjs` pins parity separately.
  check("the parked sentence exists in both dictionaries",
    typeof dictionaries.zh["auth.parked"] === "string" && dictionaries.zh["auth.parked"] !== "" &&
    typeof dictionaries.en["auth.parked"] === "string" && dictionaries.en["auth.parked"] !== "",
    JSON.stringify({ zh: dictionaries.zh["auth.parked"], en: dictionaries.en["auth.parked"] }));
  // It must be its OWN sentence, not a reuse of one that names a different
  // fact: `auth.locked` says the platform locked the ACCOUNT (a state the
  // panel cannot clear), and parked covers every non-waitable refusal.
  check("the parked sentence is not the account-locked one",
    dictionaries.zh["auth.parked"] !== dictionaries.zh["auth.locked"] &&
    dictionaries.en["auth.parked"] !== dictionaries.en["auth.locked"]);
}

console.log(JSON.stringify(results, null, 2));
const failedChecks = results.filter((r) => !r.pass);
if (failedChecks.length > 0) {
  console.error(`\n${failedChecks.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
