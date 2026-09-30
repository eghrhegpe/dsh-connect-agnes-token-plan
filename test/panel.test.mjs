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
import { readFile } from "node:fs/promises";
import { decidePanelView, dictionaries, interpretSnapshot, tables, RENDER } from "./panel-decision.js";
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

// === B2. THE CLEARED-ACCOUNT LOCKOUT: `ok:true` empty snapshot after forget =
// "Forget the saved account" keeps the refresh grant breathing, so the next
// poll still answers `ok:true` with empty pools. `data` is non-null, so the
// `!data` setup form never mounts; if the account section card were gated on
// `hasAccount` alone (false right after a forget), the user was locked out
// of their own account — no re-entry path. The card must re-appear whenever
// the Host says "an account is required to read anything" (`needsAccount`),
// which is true the moment the grant dies and the stored token is reaped.
// The MIDDLE state (grant still alive: `hasAccount` false, `needsAccount`
// false, `configured` true) correctly keeps the card hidden: the panel still
// reads quota on its own and does not need the form.
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
  check("grant still alive: the account editor stays hidden", mid.canManageAccount === false,
    JSON.stringify(mid.auth));
  check("grant still alive: the panel still reads quota", mid.render === RENDER.PANELS, mid.render);
  const deadResult = view(dead);
  check("grant dead: the account editor re-appears", deadResult.canManageAccount === true,
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

// === F4. the panel's rhythm comes from the Host, not from a literal ======
// The bundle used to hold "poll every 30 s" and "cached 60s" as numbers while
// the Host held the real ones. Those are the kind of pair that drifts the first
// time either side is tuned, so the bundle is checked for literals rather than
// for behaviour it cannot exercise here.
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
    /cache:\s*data\?\.cacheSeconds/.test(source),
    (source.match(/cache:[^,}]*cacheSeconds[^)]*\)/g) ?? []).join(" | "));
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

console.log(JSON.stringify(results, null, 2));
const failedChecks = results.filter((r) => !r.pass);
if (failedChecks.length > 0) {
  console.error(`\n${failedChecks.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
