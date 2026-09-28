/**
 * End-to-end checks of the Host routes, driving the real index.js.
 *
 * Two dimensions matter here and neither was covered before:
 *
 *   1. the token lifecycle against a fake console (401 → renew → retry), and
 *   2. the panel's own decision about whether to show the account form,
 *      replayed against the response the Host actually produces.
 *
 * The second is the regression guard for the reported bug: a Host whose
 * response carried no `auth` field left the panel with `auth === null`, and
 * the form was then unreachable.
 */
import { loadPeer, installNetworkGuard, isolateHostEnv, isolateStateDir } from "./peer-roots.mjs";

/** Installed before anything runs, so an unstubbed call cannot escape. */
const releaseNetworkGuard = installNetworkGuard();
/** The host's own SenseNova keys must not steer a check. See isolateHostEnv. */
const restoreHostEnv = isolateHostEnv();

const { credentialKey } = await loadPeer("dsh-credentials");
const { interpretSnapshot, decidePanelView } = await import("../panel-decision.js");

/** After the peers are found: the throttle is real state, kept off the real Home. */
const restoreStateDir = isolateStateDir();

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

const SNAPSHOT_PATH = "/api/dsh-connect-sensenova-token-plan/snapshot";
const ACCOUNT_PATH = "/api/dsh-connect-sensenova-token-plan/account";
const RECORD_KEY = credentialKey("dsh-connect-sensenova-token-plan", "sensenova-console");

const POOL_BODY = {
  plan: { id: "p1", name: "TokenPlan", type: "token_plan" },
  pools: [{
    id: "pool-1", name: "通用池", pool_type: "default", model_ids: ["SenseNova-Lite"],
    window_5h: { limit: 60000, used: 12345, remaining: 47655, reset_at: "1800000000" },
    window_7d: { limit: 600000, used: 12345, remaining: 587655, reset_at: "1800600000" },
    grant_balance: 0
  }]
};
const TREND_BODY = { series: [{ model_id: "SenseNova-Lite", points: [{ credits: 12.5 }] }] };

function jwtExpiring(minutes) {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + minutes * 60 })).toString("base64url");
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`;
}

const storedGrant = (accessToken, refreshToken, expiresIn) => ({
  kind: "grant",
  payload: { version: 1, accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 }
});

/** A fake credentials service covering both halves of the seam. */
function makeCredentials(initial, opts = {}) {
  const records = new Map();
  const refs = new Map(Object.entries(opts.refs ?? {}));
  if (initial) records.set(RECORD_KEY, initial);
  return {
    records, refs,
    async readRecord(k) { return records.get(k); },
    async modifyRecord(k, mutate) {
      const next = await mutate(records.get(k));
      if (next === undefined) return records.get(k);
      records.set(k, next);
      return next;
    },
    async deleteRecord(k) { records.delete(k); },
    async resolve(ref) {
      const v = refs.get(ref);
      return typeof v === "string" && v.length > 0 ? { value: v, source: "file" } : undefined;
    },
    async set(ref, value) { refs.set(ref, value); },
    async unset(ref) { refs.delete(ref); }
  };
}

function makeRequest(extra = {}) {
  return { method: "GET", headers: { host: "127.0.0.1:19387", ...extra } };
}

function makePost(body, extraHeaders = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    method: "POST",
    headers: { host: "127.0.0.1:19387", "content-type": "application/json", ...extraHeaders },
    async *[Symbol.asyncIterator]() { yield Buffer.from(text, "utf8"); }
  };
}

function makeResponse() {
  return {
    statusCode: null, headers: null, payload: null, writes: 0,
    // Counted because a real ServerResponse throws ERR_HTTP_HEADERS_SENT on a
    // second write, while this object would happily accept one: without the
    // count, a handler that answers twice passes here and breaks in the Host.
    writeHead(status, headers) { this.writes += 1; this.statusCode = status; this.headers = headers; },
    end(text) { this.payload = text === undefined ? null : JSON.parse(text); }
  };
}

/** Mount the real routes; `credentials: null` models a Host without them. */
async function mount(credentials, config = {}) {
  const host = await import(`../index.js?route=${Math.random()}`);
  const handlers = new Map();
  host.apply({
    get: (s) => (s === "credentials" ? credentials : undefined),
    effect: () => () => {},
    webServer: { register(spec) { handlers.set(spec.path, spec.handler); return () => {}; } }
  }, { consoleBase: "https://console.test", cacheSeconds: 5, ...config });
  return async (path, request) => {
    const response = makeResponse();
    await handlers.get(path)(request, response);
    return response;
  };
}

/**
 * The panel's own decision, lifted out of client.js.
 *
 * This used to be a hand-written copy labelled "mirrored from PanelPage" — the
 * same drift `panel-decision.js` exists to abolish. A mirror that lives in the
 * route tests is worse than none: it asserts about a panel nobody ships.
 */
function panelDecision(body) {
  const read = interpretSnapshot(body);
  const decided = decidePanelView(read.data, read.error);
  return {
    data: read.data,
    failure: decided.failure,
    auth: decided.auth,
    needsSetup: decided.needsSetup,
    renders: decided.render
  };
}

/** A console stub that can refuse the first token it is shown. */
function consoleStub({ rejectFirstToken = null } = {}) {
  const calls = [];
  const stub = async (url, init) => {
    const auth = init?.headers?.authorization ?? "";
    const target = String(url);
    calls.push({ target, auth });
    if (rejectFirstToken !== null && auth === `Bearer ${rejectFirstToken}`) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
    }
    if (target.includes("pool-usage")) {
      return new Response(JSON.stringify(POOL_BODY), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("credit-usage-trend")) {
      return new Response(JSON.stringify(TREND_BODY), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };
  stub.calls = calls;
  return stub;
}

/** A full login-flow stub. */
async function loginNetwork({ loginOk = true } = {}) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" },
    true, ["encrypt", "decrypt"]
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const log = { logins: 0, tokens: 0 };
  const stub = async (url) => {
    const target = String(url);
    if (target.includes("jwks.json")) {
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "public:hydra.openid.id-token", use: "sig" }] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("/oauth2/auth")) {
      return new Response("", {
        status: 302,
        headers: {
          location: "https://platform.sensenova.cn/login?login_challenge=chal-123",
          "set-cookie": "oauth2_authentication_csrf=abc; Path=/"
        }
      });
    }
    if (target.includes("iam.sensecoreapi.cn")) {
      log.logins += 1;
      return loginOk
        ? new Response(JSON.stringify({ redirect: "https://platform.sensenova.cn/cb?code=the-code" }),
            { status: 200, headers: { "content-type": "application/json" } })
        // The real IAM envelope, not a guess: the cause lives in details[].
        : new Response(JSON.stringify({
            code: 3, message: "InvalidArgument",
            details: [
              { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "invalidAccountOrPassword", domain: "iam" },
              { "@type": "type.googleapis.com/google.rpc.LocalizedMessage", locale: "en", message: "invalid account or password" }
            ]
          }), { status: 400, headers: { "content-type": "application/json" } });
    }
    if (target.includes("oauth2/token")) {
      log.tokens += 1;
      return new Response(
        JSON.stringify({ access_token: jwtExpiring(180), refresh_token: `granted-${log.tokens}`, expires_in: 10800 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (target.includes("pool-usage")) {
      return new Response(JSON.stringify(POOL_BODY), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("credit-usage-trend")) {
      return new Response(JSON.stringify(TREND_BODY), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };
  stub.log = log;
  return stub;
}

async function withNetwork(stub, body) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await body();
  } finally {
    globalThis.fetch = realFetch;
  }
}

// === A. a fresh stored token reaches the console and returns pools ========
{
  const token = jwtExpiring(120);
  const credentials = makeCredentials(storedGrant(token, "r1", 7200));
  const stub = consoleStub();
  await withNetwork(stub, async () => {
    const response = await (await mount(credentials))(SNAPSHOT_PATH, makeRequest());
    check("snapshot succeeds", response.payload.ok === true, JSON.stringify(response.payload).slice(0, 120));
    check("pool name is returned", response.payload?.pools?.pools?.[0]?.name === "通用池");
    check("5h window is parsed", response.payload?.pools?.pools?.[0]?.window5h?.used === 12345);
    check("7d reset_at string becomes a number",
      response.payload?.pools?.pools?.[0]?.window7d?.resetAt === 1800600000,
      String(response.payload?.pools?.pools?.[0]?.window7d?.resetAt));
    check("trend is parsed", response.payload?.trend?.models?.[0]?.credits === 12.5);
    check("console saw the stored token", stub.calls.every((c) => c.auth === `Bearer ${token}`));
    check("a working panel does not show the form",
      panelDecision(response.payload).renders === "pools");
  }).catch((error) => fail("A: fresh token", error));
}

// === A2. the trend cache actually hits across polls ====================
// The trend endpoint carries a 5-minute cache, but the request used to bake
// `now` (to the second) into `end_time`, so the URL differed on every poll and
// the cache never matched. Snapping `end_time` to the granularity boundary
// makes polls inside the same hour bucket share one URL and one cached body.
{
  const token = jwtExpiring(120);
  const credentials = makeCredentials(storedGrant(token, "r", 7200));
  const stub = consoleStub();
  await withNetwork(stub, async () => {
    const call = await mount(credentials, { cacheSeconds: 5 });
    const first = await call(SNAPSHOT_PATH, makeRequest());
    const second = await call(SNAPSHOT_PATH, makeRequest());
    const trendCalls = stub.calls.filter((c) => c.target.includes("credit-usage-trend"));
    check("both polls succeed", first.payload.ok === true && second.payload.ok === true,
      `${first.payload.ok}/${second.payload.ok}`);
    check("the trend response is served from cache on the second poll",
      trendCalls.length === 1, `trend console calls=${trendCalls.length}`);
    check("the second poll still carries trend data",
      second.payload?.trend?.models?.[0]?.credits === 12.5);
    // The property that makes the URL stable: end_time lands on the hour edge.
    const endParam = new URL(trendCalls[0].target).searchParams.get("end_time");
    check("the trend end_time is snapped to the hour boundary",
      Number(endParam) % 3600 === 0, `end_time=${endParam}`);
  }).catch((error) => fail("A2: trend cache hit", error));
}

// === A3. concurrent polls share one console call (single-flight) ========
// Many open panels or tabs poll at once. Without request coalescing, N panels
// would each hit the console — and the platform's own rate limiter, which this
// plugin goes to some length to avoid tripping. One in-flight fetch per URL
// means concurrent polls inside the same window collapse onto a single call.
{
  const token = jwtExpiring(120);
  const credentials = makeCredentials(storedGrant(token, "r", 7200));
  const stub = consoleStub();
  await withNetwork(stub, async () => {
    const call = await mount(credentials, { cacheSeconds: 5 });
    // Fire two snapshots at once so both enter fetchConsole before either
    // resolves and sets its cache.
    const [first, second] = await Promise.all([
      call(SNAPSHOT_PATH, makeRequest()),
      call(SNAPSHOT_PATH, makeRequest())
    ]);
    const poolCalls = stub.calls.filter((c) => c.target.includes("pool-usage"));
    const trendCalls = stub.calls.filter((c) => c.target.includes("credit-usage-trend"));
    check("both concurrent polls succeed",
      first.payload.ok === true && second.payload.ok === true,
      `${first.payload.ok}/${second.payload.ok}`);
    check("pool-usage was fetched once, not twice",
      poolCalls.length === 1, `pool calls=${poolCalls.length}`);
    check("credit-usage-trend was fetched once, not twice",
      trendCalls.length === 1, `trend calls=${trendCalls.length}`);
    check("both polls still carry trend data",
      first.payload?.trend?.models?.[0]?.credits === 12.5 &&
      second.payload?.trend?.models?.[0]?.credits === 12.5);
  }).catch((error) => fail("A3: single-flight", error));
}

// === B. a 401 triggers one renewal and a successful retry =================
{
  const dead = jwtExpiring(120);
  const credentials = makeCredentials(storedGrant(dead, "old-refresh", 7200));
  let refreshed = false;
  const stub = consoleStub({ rejectFirstToken: dead });
  await withNetwork(async (url, init) => {
    if (String(url).includes("oauth2/token")) {
      refreshed = true;
      return new Response(
        JSON.stringify({ access_token: jwtExpiring(180), refresh_token: "rotated", expires_in: 10800 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return stub(url, init);
  }, async () => {
    const response = await (await mount(credentials))(SNAPSHOT_PATH, makeRequest());
    check("401 is recovered", response.payload.ok === true, JSON.stringify(response.payload).slice(0, 160));
    check("a refresh happened", refreshed === true);
    check("the rotated refresh token is persisted",
      (await credentials.readRecord(RECORD_KEY))?.payload?.refreshToken === "rotated");
    // Two console endpoints; single-flight means only the initial attempts
    // carry the dead token, and only one renewal happens.
    check("only the initial attempt uses the dead token",
      stub.calls.filter((c) => c.auth === `Bearer ${dead}`).length === 2,
      `rejected=${stub.calls.filter((c) => c.auth === `Bearer ${dead}`).length}`);
  }).catch((error) => fail("B: 401 recovery", error));
}

// === C. a persistent rejection reports jwt_expired =======================
{
  const dead = jwtExpiring(120);
  const credentials = makeCredentials(storedGrant(dead, "old", 7200));
  let refreshes = 0;
  await withNetwork(async (url) => {
    if (String(url).includes("oauth2/token")) {
      refreshes += 1;
      return new Response(
        JSON.stringify({ access_token: jwtExpiring(180), refresh_token: `r${refreshes}`, expires_in: 10800 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
  }, async () => {
    const response = await (await mount(credentials))(SNAPSHOT_PATH, makeRequest());
    check("a persistent rejection fails cleanly", response.payload.ok === false);
    check("the code is jwt_expired", response.payload.code === "jwt_expired", response.payload.code);
    check("the failure carries auth state", response.payload.auth !== undefined);
    check("no refresh storm", refreshes <= 2, `refreshes=${refreshes}`);
  }).catch((error) => fail("C: persistent 401", error));
}

// === D. a cross-origin request is refused ================================
{
  const token = jwtExpiring(120);
  const credentials = makeCredentials(storedGrant(token, "r", 7200));
  const host = await import(`../index.js?origin=${Math.random()}`);
  let handler = null;
  host.apply({
    get: (s) => (s === "credentials" ? credentials : undefined),
    effect: () => () => {},
    webServer: { register(spec) { handler = spec.handler; return () => {}; } }
  }, { consoleBase: "https://console.test" });
  const response = makeResponse();
  await handler(makeRequest({ origin: "https://evil.test" }), response);
  check("cross-origin is refused", response.statusCode === 403, String(response.statusCode));
}

// === D2. DNS rebinding: the two headers AGREE, and that is the trap ======
// The obvious fence compares `Origin` to `Host`. Under rebinding the attacker
// rebinds its own name to the loopback, so the browser sends the attacker's
// name for BOTH and the comparison waves the request through while it lands on
// the Host. Only refusing a Host this Host does not answer as turns it away —
// which matters here because the account route writes.
{
  const net = await loginNetwork();
  await withNetwork(net, async () => {
    const token = jwtExpiring(120);
    const credentials = makeCredentials(storedGrant(token, "r", 7200));
    const call = await mount(credentials);

    const rebound = await call(SNAPSHOT_PATH,
      makeRequest({ host: "attacker.test", origin: "https://attacker.test" }));
    check("a rebound host is refused even though Origin agrees with it",
      rebound.statusCode === 403, String(rebound.statusCode));

    // Brackets and ports are not part of the name, so a rebound Host cannot
    // smuggle itself in by spelling the loopback a different way.
    const bracketed = await call(SNAPSHOT_PATH,
      makeRequest({ host: "[::1]:19387", origin: "http://[::1]:19387" }));
    check("the loopback is still admitted when spelled with brackets and a port",
      bracketed.statusCode === 200, String(bracketed.statusCode));

    // The operator's list is added to the defaults, not substituted: naming a
    // LAN host must not lock the panel out of itself.
    const widened = await mount(credentials, { allowedHosts: ["panel.internal"] });
    const lan = await widened(SNAPSHOT_PATH,
      makeRequest({ host: "panel.internal", origin: "https://panel.internal" }));
    check("a host the operator added is admitted", lan.statusCode !== 403, String(lan.statusCode));
    const stillLoopback = await widened(SNAPSHOT_PATH, makeRequest());
    check("widening the list does not evict the loopback",
      stillLoopback.statusCode === 200, String(stillLoopback.statusCode));
  }).catch((error) => fail("D2: DNS rebinding", error));
}

// === D3. the snapshot states its own rhythm =============================
// The panel used to poll every 30 s and quote "cached 60s" in its note, both
// written down in the browser bundle while the Host kept the real numbers. The
// Host now ships them and the panel follows, so changing either is one edit.
{
  const net = await loginNetwork();
  await withNetwork(net, async () => {
    const token = jwtExpiring(120);
    const call = await mount(makeCredentials(storedGrant(token, "r", 7200)));
    const snapshot = await call(SNAPSHOT_PATH, makeRequest());
    check("the snapshot states the cache age", snapshot.payload.cacheSeconds === 5,
      String(snapshot.payload.cacheSeconds));
    check("the snapshot states the poll cadence", snapshot.payload.pollSeconds === 30,
      String(snapshot.payload.pollSeconds));

    const retuned = await mount(makeCredentials(storedGrant(token, "r", 7200)),
      { cacheSeconds: 120, pollSeconds: 45 });
    const second = await retuned(SNAPSHOT_PATH, makeRequest());
    check("both follow the operator's values",
      second.payload.cacheSeconds === 120 && second.payload.pollSeconds === 45,
      `${second.payload.cacheSeconds}/${second.payload.pollSeconds}`);
  }).catch((error) => fail("D2: DNS rebinding", error));
}

// === E. THE REPORTED BUG: a Host without the credentials service ========
// Before this fix the snapshot answered `auth_unavailable`, which the panel
// rendered as plain text with no way to sign in, and a response with no
// `auth` field at all left `auth === null` and so never reached the form.
{
  const net = await loginNetwork();
  await withNetwork(net, async () => {
    const call = await mount(null);
    const snapshot = await call(SNAPSHOT_PATH, makeRequest());
    check("a Host without credentials still answers", snapshot.statusCode === 200, String(snapshot.statusCode));
    check("it is not the auth_unavailable dead end", snapshot.payload.code !== "auth_unavailable",
      String(snapshot.payload.code));
    check("it reports not_configured", snapshot.payload.code === "not_configured", String(snapshot.payload.code));
    check("the response carries auth state", snapshot.payload.auth !== undefined);
    check("it is marked ephemeral", snapshot.payload.auth?.ephemeral === true, JSON.stringify(snapshot.payload.auth));

    const decision = panelDecision(snapshot.payload);
    check("THE FORM IS REACHABLE", decision.renders === "AccountForm", decision.renders);
    check("the panel is told to ask for the account", decision.needsSetup === true);

    // And the account route must accept a post, so the form can do its job.
    const posted = await call(ACCOUNT_PATH, makePost({ username: "u", password: "p" }));
    check("the account route accepts a post", posted.statusCode === 200, String(posted.statusCode));
    check("the post produced a grant", posted.payload.hasRefreshToken === true, JSON.stringify(posted.payload).slice(0, 160));

    // A restart-free second read now works off the in-memory grant.
    const second = await call(SNAPSHOT_PATH, makeRequest());
    check("the snapshot works right after signing in", second.payload.ok === true,
      JSON.stringify(second.payload).slice(0, 140));
  }).catch((error) => fail("E: a Host without credentials", error));
}

// === F. a response with no auth field still reaches the form =============
// The shape an older Host produced: `ok:false` and nothing else. The panel
// must not treat the missing field as "everything is fine".
{
  const decision = panelDecision({ ok: false, error: "no console account is configured", code: "not_configured" });
  check("a legacy payload without auth reaches the form", decision.renders === "AccountForm", decision.renders);
  check("the missing field reads as not needing setup", decision.needsSetup === true);
}

// === G. the account route, with a credentials service ====================
{
  const credentials = makeCredentials(null);
  const net = await loginNetwork();
  await withNetwork(net, async () => {
    const call = await mount(credentials);
    const before = await call(ACCOUNT_PATH, makeRequest());
    check("account GET succeeds", before.payload.ok === true);
    check("it reports no account", before.payload.hasAccount === false);
    check("it reports the panel needs setup", before.payload.needsAccount === true);
    check("it never returns a secret",
      !("password" in before.payload) && !("accessToken" in before.payload) && !("refreshToken" in before.payload));
    check("it is not ephemeral with the service", before.payload.ephemeral === false);

    const saved = await call(ACCOUNT_PATH, makePost({ username: "u@x", password: "p" }));
    check("a valid account is accepted", saved.payload.ok === true, JSON.stringify(saved.payload).slice(0, 160));
    check("the account is stored", saved.payload.hasAccount === true);
    check("a refresh token is held", saved.payload.hasRefreshToken === true);
    check("the panel no longer needs setup", saved.payload.needsAccount === false);
  }).catch((error) => fail("G: account route", error));
}

// === H. a rejected password is reported, not swallowed ===================
{
  const credentials = makeCredentials(null);
  const net = await loginNetwork({ loginOk: false });
  await withNetwork(net, async () => {
    const call = await mount(credentials);
    const response = await call(ACCOUNT_PATH, makePost({ username: "u", password: "wrong" }));
    check("a rejected password fails cleanly", response.payload.ok === false);
    check("the code is login_rejected", response.payload.code === "login_rejected", response.payload.code);
    // The reported reason must survive the state spread, or the panel can
    // never explain itself — and it must be the platform's own words.
    check("the reason reaches the user", /invalid account or password/i.test(response.payload.error),
      response.payload.error);
    check("the generic status string is not what the user is shown",
      !response.payload.error.includes("InvalidArgument"), response.payload.error);
    check("no grant is left behind", credentials.records.has(RECORD_KEY) === false);
  }).catch((error) => fail("H: rejected password", error));
}

// === I. body handling ====================================================
{
  const credentials = makeCredentials(null);
  const call = await mount(credentials);
  check("invalid JSON is a 400", (await call(ACCOUNT_PATH, makePost("{not json"))).statusCode === 400);
  check("a JSON array is a 400", (await call(ACCOUNT_PATH, makePost([1, 2, 3]))).statusCode === 400);
  check("an oversized body is a 400",
    (await call(ACCOUNT_PATH, makePost({ username: "u", password: "x".repeat(9000) }))).statusCode === 400);
  check("nothing was stored", credentials.refs.size === 0);

  const foreign = await call(ACCOUNT_PATH, makePost({ username: "attacker", password: "x" }, { origin: "https://evil.test" }));
  check("a cross-origin post is refused", foreign.statusCode === 403, String(foreign.statusCode));
  check("no account was written by the cross-origin post", credentials.refs.size === 0);
}

// === J. forget keeps the grant ==========================================
{
  const credentials = makeCredentials(storedGrant(jwtExpiring(120), "keep-me", 7200), {
    refs: { SENSENOVA_USERNAME: "u", SENSENOVA_PASSWORD: "p" }
  });
  const call = await mount(credentials);
  const response = await call(ACCOUNT_PATH, makePost({ forget: true }));
  check("forget succeeds", response.payload.ok === true);
  check("the account is gone", response.payload.hasAccount === false);
  check("the grant survives", response.payload.hasRefreshToken === true);
  check("the panel is not asked for setup", response.payload.needsAccount === false);
}

// === K. one response per request ========================================
// Saving an account used to answer twice: the success `writeJson` sat inside
// the `try` with no `return`, so the flow fell through to a second one. A real
// ServerResponse throws ERR_HTTP_HEADERS_SENT on the second write — an
// unhandled rejection in the Host that the user never sees, because the first
// answer already reached the browser. These checks passed throughout, because
// the fake response accepted both writes.
{
  const credentials = makeCredentials(null);
  const net = await loginNetwork();
  await withNetwork(net, async () => {
    const call = await mount(credentials);
    const saved = await call(ACCOUNT_PATH, makePost({ username: "u@x", password: "p" }));
    check("saving an account succeeds", saved.payload.ok === true, JSON.stringify(saved.payload).slice(0, 120));
    check("a saved account answers exactly once", saved.writes === 1, `writes=${saved.writes}`);

    const forgotten = await call(ACCOUNT_PATH, makePost({ forget: true }));
    check("a forgotten account answers exactly once", forgotten.writes === 1, `writes=${forgotten.writes}`);

    const rejected = await call(ACCOUNT_PATH, makePost({ username: "u", password: "" }));
    check("an empty password answers exactly once", rejected.writes === 1, `writes=${rejected.writes}`);

    const snapshot = await call(SNAPSHOT_PATH, makeRequest());
    check("a snapshot answers exactly once", snapshot.writes === 1, `writes=${snapshot.writes}`);
  }).catch((error) => fail("K: one response per request", error));
}

// The Host routes are exercised against a stubbed console; nothing here may
// reach the real one. See the same guard in test/auth.test.mjs.
const unstubbed = releaseNetworkGuard();
restoreHostEnv();
check("no check escaped its stub to the network", unstubbed.length === 0, unstubbed.join(", "));

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
