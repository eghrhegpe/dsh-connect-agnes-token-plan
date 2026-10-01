/**
 * Offline checks for agnes-auth.js — the console sign-in the whole quota half
 * depends on.
 *
 * Every request is served by a local stub and every token is fabricated here:
 * no real account is used and nothing leaves the machine. The network guard is
 * installed first, so a check that forgets to stub its fetch fails loudly
 * instead of quietly reaching the platform.
 */
import {
  createAuth, loginWith, resolveAuthConfig, classifyLoginFailure, readJwtExpiry,
  parseRetryAfterMs, AUTH_DEFAULTS
} from "../src/host/agnes-auth.ts";
import { CODE } from "../src/host/codes.ts";
import { installNetworkGuard } from "./peer-roots.mjs";

/** Installed before anything runs, so an unstubbed call cannot escape. */
const releaseNetworkGuard = installNetworkGuard();
const guardFetch = globalThis.fetch;

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

/** Serve one canned response and record what was sent. */
function stubFetch(response) {
  const seen = { url: "", init: null };
  globalThis.fetch = async (input, init) => {
    seen.url = typeof input === "string" ? input : String(input?.url ?? input);
    seen.init = init ?? null;
    if (response instanceof Error) throw response;
    const headers = new Map(Object.entries(response.headers ?? {}));
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
      async text() { return response.body; },
      async json() { return JSON.parse(response.body); }
    };
  };
  return seen;
}

function restore() {
  globalThis.fetch = guardFetch;
}

const CFG = resolveAuthConfig({});
const ACCOUNT = { username: "probe@example.com", password: "s3cret-pw" };

/** A JWT-shaped token with a readable `exp`, so the expiry path is exercised. */
function jwtWithExp(expSeconds) {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ exp: expSeconds })}.sig`;
}

// --- 1. config resolution -------------------------------------------------
{
  try {
    check("the default origin is the BACKEND host, not the console front-end",
      AUTH_DEFAULTS.consoleOrigin === "https://platform-backend.agnes-ai.cn", AUTH_DEFAULTS.consoleOrigin);
    check("an empty override keeps the shipped default",
      CFG.consoleOrigin === AUTH_DEFAULTS.consoleOrigin, CFG.consoleOrigin);
    check("a trailing slash is stripped so the path never doubles",
      resolveAuthConfig({ consoleOrigin: "https://stub.invalid/" }).consoleOrigin === "https://stub.invalid");

    // The origin is where the PASSWORD is posted, so a broken one must throw
    // rather than silently fall back to the real platform.
    let threw = false;
    try {
      resolveAuthConfig({ consoleOrigin: "not a url" });
    } catch {
      threw = true;
    }
    check("an unparseable origin throws instead of falling back", threw);

    // "" means "the operator set nothing", which is NOT the same as a typo:
    // it must fall back to the shipped default rather than throw.
    const emptyResolved = resolveAuthConfig({ consoleOrigin: "" });
    check("an explicitly empty origin falls back to the shipped default",
      emptyResolved.consoleOrigin === AUTH_DEFAULTS.consoleOrigin, emptyResolved.consoleOrigin);
  } catch (error) { fail("1: config resolution", error); }
}

// --- 2. JWT expiry reading ------------------------------------------------
{
  try {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    check("a JWT exp is read back in MILLIS (matching the store's expiresAt)",
      readJwtExpiry(jwtWithExp(exp)) === exp * 1000, String(readJwtExpiry(jwtWithExp(exp))));
    check("an opaque (non-JWT) token reports no expiry", readJwtExpiry("cpk-opaque-token-value") === null);
    check("a malformed JWT reports no expiry rather than throwing",
      readJwtExpiry("a.b.c") === null && readJwtExpiry("") === null && readJwtExpiry(undefined) === null);
  } catch (error) { fail("2: jwt expiry", error); }
}

// --- 3. failure classification --------------------------------------------
{
  try {
    check("Agnes's own 401 wording parks as a credential refusal",
      classifyLoginFailure(401, "Invalid username or password") === CODE.LOGIN_REJECTED);
    check("a lock is named even when it arrives as a 400",
      classifyLoginFailure(400, "Account locked") === CODE.ACCOUNT_LOCKED);
    check("a rate limit is named even when it arrives as a 400",
      classifyLoginFailure(400, "too many attempts") === CODE.RATE_LIMITED);
    check("HTTP 429 alone is a rate limit",
      classifyLoginFailure(429, "") === CODE.RATE_LIMITED);
    check("an unnamed 401 is still a credential refusal",
      classifyLoginFailure(401, "") === CODE.LOGIN_REJECTED);
    check("a 5xx is a generic login failure, never parked",
      classifyLoginFailure(500, "") === CODE.LOGIN_FAILED);
    check("the parked set is exactly the credential-shaped refusals",
      classifyLoginFailure(401, "Invalid username or password") === CODE.LOGIN_REJECTED &&
      classifyLoginFailure(429, "") !== CODE.LOGIN_REJECTED);
  } catch (error) { fail("3: classification", error); }
}

// --- 4. a successful sign-in ---------------------------------------------
{
  try {
    const exp = Math.floor(Date.now() / 1000) + 7200;
    const token = jwtWithExp(exp);
    const seen = stubFetch({ status: 200, body: JSON.stringify({ code: 200, message: "ok", data: { access_token: token, user: { id: 1 } } }) });
    const traces = [];
    const out = await loginWith(CFG, ACCOUNT, { onTrace: (trace, error) => traces.push({ trace, error }) });
    restore();

    check("the POST lands on the configured origin + login path",
      seen.url === `${AUTH_DEFAULTS.consoleOrigin}/api/user/login`, seen.url);
    check("it is a POST with a JSON body",
      seen.init?.method === "POST" && String(seen.init?.headers?.["content-type"]).includes("application/json"),
      JSON.stringify(seen.init?.method));
    const sent = JSON.parse(String(seen.init?.body));
    check("the body carries the account verbatim",
      sent.username === ACCOUNT.username && sent.password === ACCOUNT.password, JSON.stringify(Object.keys(sent)));

    check("the access token comes back", out.accessToken === token);
    check("refreshToken is the empty string — Agnes issues none",
      out.refreshToken === "", JSON.stringify(out.refreshToken));
    check("expiresIn is derived from the token's own exp",
      out.expiresIn > 7100 && out.expiresIn <= 7200, String(out.expiresIn));

    check("the trace fires once on success with a null error",
      traces.length === 1 && traces[0].error === null, JSON.stringify(traces.length));
    const flat = JSON.stringify(traces[0].trace);
    check("the trace never carries the password", !flat.includes(ACCOUNT.password), flat.slice(0, 200));
    check("the trace never carries the token itself", !flat.includes(token), flat.slice(0, 200));
    check("the trace does name the account (masked) so a report is diffable",
      flat.includes("pr***@example.com"), flat.slice(0, 200));
  } catch (error) { fail("4: successful sign-in", error); restore(); }
}

// --- 5. an opaque token gets the long fallback ----------------------------
{
  try {
    const seen = stubFetch({ status: 200, body: JSON.stringify({ code: 200, data: { access_token: "cpk-opaque-value" } }) });
    const out = await loginWith(CFG, ACCOUNT, {});
    restore();
    check("a non-JWT token falls back to the LONG default, never a short guess",
      out.expiresIn === AUTH_DEFAULTS.fallbackExpiresInSeconds, String(out.expiresIn));
    check("the fallback is measured in days, so a live token is never re-logged-in hourly",
      AUTH_DEFAULTS.fallbackExpiresInSeconds >= 86_400, String(AUTH_DEFAULTS.fallbackExpiresInSeconds));
    check("the stub was actually used", seen.url.endsWith("/api/user/login"));
  } catch (error) { fail("5: opaque token", error); restore(); }
}

// --- 6. refusals carry the right code ------------------------------------
{
  try {
    const cases = [
      [{ status: 401, body: JSON.stringify({ code: 401, message: "Invalid username or password", data: null }) }, CODE.LOGIN_REJECTED],
      [{ status: 429, body: JSON.stringify({ code: 429, message: "rate limited", data: null }) }, CODE.RATE_LIMITED],
      [{ status: 500, body: "boom" }, CODE.LOGIN_FAILED]
    ];
    for (const [response, expected] of cases) {
      stubFetch(response);
      let caught = null;
      try {
        await loginWith(CFG, ACCOUNT, {});
      } catch (error) {
        caught = error;
      }
      restore();
      check(`HTTP ${response.status} maps to ${expected}`, caught?.code === expected, String(caught?.code));
    }

    stubFetch(new Error("ECONNREFUSED"));
    let netErr = null;
    try {
      await loginWith(CFG, ACCOUNT, {});
    } catch (error) {
      netErr = error;
    }
    restore();
    check("a transport failure is LOGIN_FAILED (retryable), not a credential refusal",
      netErr?.code === CODE.LOGIN_FAILED, String(netErr?.code));

    stubFetch({ status: 200, body: JSON.stringify({ code: 200, message: "ok", data: {} }) });
    let emptyErr = null;
    try {
      await loginWith(CFG, ACCOUNT, {});
    } catch (error) {
      emptyErr = error;
    }
    restore();
    check("a 200 without an access_token is a contract break, not a silent empty Bearer",
      emptyErr?.code === CODE.LOGIN_FAILED, String(emptyErr?.code));
  } catch (error) { fail("6: refusal codes", error); restore(); }
}

// --- 7. missing credentials, and the failure trace ------------------------
{
  try {
    const traces = [];
    let caught = null;
    try {
      await loginWith(CFG, { username: "", password: "" }, { onTrace: (trace, error) => traces.push({ trace, error }) });
    } catch (error) {
      caught = error;
    }
    check("an empty account is MISSING_CREDENTIALS", caught?.code === CODE.MISSING_CREDENTIALS, String(caught?.code));
    check("the failure trace still fires (a failed attempt must be diffable)",
      traces.length === 1 && traces[0].error !== null, JSON.stringify(traces.length));

    stubFetch({ status: 401, body: JSON.stringify({ code: 401, message: "Invalid username or password" }) });
    const failTraces = [];
    let refused = null;
    try {
      await loginWith(CFG, ACCOUNT, { onTrace: (trace, error) => failTraces.push({ trace, error }) });
    } catch (error) {
      refused = error;
    }
    restore();
    const flat = JSON.stringify(failTraces[0]?.trace);
    check("a refused attempt also traces, and still hides the password",
      failTraces.length === 1 && !flat.includes(ACCOUNT.password), flat.slice(0, 200));
    check("the refusal keeps the platform's own wording for the panel",
      String(refused?.message).includes("Invalid username or password"), String(refused?.message));
  } catch (error) { fail("7: missing credentials + trace", error); restore(); }
}

// --- 8. createAuth's shape is what token-store calls ---------------------
{
  try {
    const auth = createAuth({ consoleOrigin: "https://stub.invalid" });
    check("createAuth exposes a resolved config", auth.config.consoleOrigin === "https://stub.invalid");

    let refreshErr = null;
    try {
      await auth.refresh("whatever");
    } catch (error) {
      refreshErr = error;
    }
    // This is load-bearing, not a stub: acquire.ts catches NO_REFRESH_TOKEN and
    // falls through to a password login — the only renewal path Agnes has.
    check("refresh() throws NO_REFRESH_TOKEN so the store falls through to re-login",
      refreshErr?.code === CODE.NO_REFRESH_TOKEN, String(refreshErr?.code));

    stubFetch({ status: 200, body: JSON.stringify({ code: 200, data: { access_token: "tok" } }) });
    const out = await auth.login(ACCOUNT, {});
    restore();
    check("auth.login delegates to the same code path", out.accessToken === "tok");
  } catch (error) { fail("8: createAuth shape", error); restore(); }
}

// --- 9. a stated wait is carried on the error ----------------------------
{
  try {
    // The store's throttle reads `error.retryAfterMs` and honours it verbatim
    // instead of its own doubling backoff — truncating a stated lock walks
    // straight back into it. So this number has to survive the login call.
    stubFetch({
      status: 429,
      headers: { "retry-after": "7200" },
      body: JSON.stringify({ code: 429, message: "rate limited", data: null })
    });
    let byHeader = null;
    try { await loginWith(CFG, ACCOUNT, {}); } catch (error) { byHeader = error; }
    restore();
    check("a Retry-After header (delta-seconds) reaches the error as milliseconds",
      byHeader?.retryAfterMs === 7_200_000, String(byHeader?.retryAfterMs));

    stubFetch({
      status: 429,
      headers: { "retry-after": new Date(Date.now() + 90_000).toUTCString() },
      body: JSON.stringify({ code: 429, message: "rate limited", data: null })
    });
    let byDate = null;
    try { await loginWith(CFG, ACCOUNT, {}); } catch (error) { byDate = error; }
    restore();
    check("an HTTP-date Retry-After is converted to a positive delta",
      byDate?.retryAfterMs > 80_000 && byDate?.retryAfterMs <= 90_000, String(byDate?.retryAfterMs));

    // No header: a duration written into the message is the other shape.
    stubFetch({
      status: 403,
      body: JSON.stringify({ code: 403, message: "Account locked, try again in 2 hours", data: null })
    });
    let byMessage = null;
    try { await loginWith(CFG, ACCOUNT, {}); } catch (error) { byMessage = error; }
    restore();
    check("a duration stated in the message is read whole",
      byMessage?.retryAfterMs === 7_200_000, String(byMessage?.retryAfterMs));
    check("that refusal is classified as a lock, not a generic failure",
      byMessage?.code === CODE.ACCOUNT_LOCKED, String(byMessage?.code));

    stubFetch({
      status: 401,
      body: JSON.stringify({ code: 401, message: "Invalid username or password" })
    });
    let noWindow = null;
    try { await loginWith(CFG, ACCOUNT, {}); } catch (error) { noWindow = error; }
    restore();
    check("an UNSTATED window stays absent, so the store uses its own backoff",
      noWindow?.retryAfterMs === undefined, String(noWindow?.retryAfterMs));

    // "m" is minutes in some phrasings and months in others — reading it as a
    // unit would turn a 30-minute lock into a 30-month park.
    check("a bare 'm' is NOT treated as a unit",
      parseRetryAfterMs({ headers: { get: () => null } }, "try again in 30m") === null,
      String(parseRetryAfterMs({ headers: { get: () => null } }, "try again in 30m")));
    check("a stated Chinese duration is read",
      parseRetryAfterMs({ headers: { get: () => null } }, "请 30 分钟后重试") === 1_800_000,
      String(parseRetryAfterMs({ headers: { get: () => null } }, "请 30 分钟后重试")));
  } catch (error) { fail("9: stated wait", error); restore(); }
}

// --- report ---------------------------------------------------------------
releaseNetworkGuard();
const failed = results.filter((r) => !r.pass);
for (const r of results) {
  if (!r.pass) console.error(`FAIL  ${r.name}${r.detail ? `\n      ${r.detail}` : ""}`);
}
console.log(`\nagnes-auth: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
