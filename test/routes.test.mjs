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
import { createFileThrottleStore } from "../src/host/throttle-store.ts";

/** Installed before anything runs, so an unstubbed call cannot escape. */
const releaseNetworkGuard = installNetworkGuard();
/** The host's own Agnes keys must not steer a check. See isolateHostEnv. */
const restoreHostEnv = isolateHostEnv();

const { credentialKey } = await loadPeer("dsh-credentials");
const { interpretSnapshot, decidePanelView } = await import("./panel-decision.js");

/** After the peers are found: the throttle is real state, kept off the real Home. */
const restoreStateDir = isolateStateDir();

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

const SNAPSHOT_PATH = "/api/dsh-connect-agnes-token-plan/snapshot";
const ACCOUNT_PATH = "/api/dsh-connect-agnes-token-plan/account";
const API_KEY_PATH = "/api/dsh-connect-agnes-token-plan/api-key";
const PROVIDER_PATH = "/api/dsh-connect-agnes-token-plan/provider";
const MODELS_PATH = "/api/dsh-connect-agnes-token-plan/models";
const DRAW_PATH = "/api/dsh-connect-agnes-token-plan/draw";
const VIDEO_PATH = "/api/dsh-connect-agnes-token-plan/video";
const RECORD_KEY = credentialKey("dsh-connect-agnes-token-plan", "agnes-console");

// Agnes answers every backend route in one `{code, message, data}` envelope,
// so the fixtures below are the envelope, not the bare payload: the plugin's
// `unwrapEnvelope` is on the path these checks exercise, and a fixture that
// handed back bare data would let a broken unwrap pass.
const OVERVIEW_BODY = {
  code: 200,
  message: "ok",
  data: { total_requests: 12345, total_tokens: 6789012, total_images: 42, total_video_seconds: 99, active_days: 7 }
};
const SERIES_BODY = {
  code: 200,
  message: "ok",
  data: {
    items: [
      { bucket: "2026-09-29", request_count: 100, text_tokens: 2000, image_count: 1, video_seconds: 3 },
      { bucket: "2026-09-30", request_count: 250, text_tokens: 5000, image_count: 2, video_seconds: 4 }
    ]
  }
};
// One tier is enough to prove the shape; the real catalogue has six.
const PLAN = {
  id: 1,
  uuid: "plan-starter",
  name: "入门版",
  display_name: "入门版",
  billing_cycle: "monthly",
  display_cycle: "1个月",
  price_minor: 2500,
  currency: "cny",
  concurrency_limit: 1500,
  concurrency_window_h: 5,
  text_weekly_limit: 15000,
  image_daily_limit: 4000,
  video_daily_limit: 500,
  usage_limit_text: "1500 次模型请求 / 5 小时",
  feature_texts: ["1500 次模型请求 / 5 小时"]
};
const PLANS_BODY = { code: 200, message: "ok", data: [PLAN] };
// The subscription's real shape, observed live 2026-10-01 (docs/AGNES-API.md §4):
// the identity keys the matcher reads, plus the `usage` block that carries the
// platform's own per-window consumption. The fake keeps both so the panel is
// exercised against the same field names the console uses.
const SUBSCRIPTION_BODY = {
  code: 200,
  message: "ok",
  data: {
    plan_uuid: "plan-starter",
    plan_name: "入门版",
    billing_cycle: "monthly",
    usage: {
      text_generation: {
        windowed: { used: 548, limit: 1500, time_range_start: "2026-10-01T10:00:00", time_range_end: "2026-10-01T15:00:00", reset_at: "2026-10-01T15:00:00", reset_in_seconds: 692, usage_pct: 36.5 },
        weekly: { used: 4454, limit: 15000, reset_at: "2026-10-05T00:00:00", reset_in_seconds: 292292, usage_pct: 29.7 }
      },
      image_generation: { daily: { used: 8, limit: 4000, reset_at: "2026-10-02T00:00:00", usage_pct: 0.2 } },
      video_generation: { daily: { used: 28, limit: 500, reset_at: "2026-10-02T00:00:00", usage_pct: 5.6 } }
    }
  }
};

/** The paths the authenticated console stub answers, in match order. */
const CONSOLE_ROUTES = [
  ["/api/cn/user/subscription/plans", PLANS_BODY],
  ["/api/cn/user/subscription", SUBSCRIPTION_BODY],
  ["/api/usage/overview", OVERVIEW_BODY],
  ["/api/usage/series", SERIES_BODY]
];

/** One console answer for a URL, or null when the stub has no route for it. */
function consoleAnswer(target) {
  for (const [path, body] of CONSOLE_ROUTES) {
    // `/plans` must be tested before `/subscription`: the former contains the
    // latter, so a naive `includes` order would answer the catalogue for both.
    if (target.includes(path)) return body;
  }
  return null;
}

/** A JSON `Response` in the platform's envelope. */
function envelope(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

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

/**
 * Mount the real routes; `credentials: null` models a Host without them.
 * @param {object|null} credentials - the fake credentials service.
 * @param {object} [config] - raw row config.
 * @param {object} [deps] - extra seam wiring:
 *   `llm` a fake llm service, `loadAdapterModule` the peer adapter seam.
 */
async function mount(credentials, config = {}, deps = {}) {
  const host = await import(`../src/host/index.ts?route=${Math.random()}`);
  const handlers = new Map();
  const services = { credentials, llm: deps.llm };
  host.apply({
    get: (s) => services[s],
    emit: deps.emit ?? (() => {}),
    effect: () => () => {},
    webServer: { register(spec) { handlers.set(spec.path, spec.handler); return () => {}; } }
  }, { consoleBase: "https://console.test", cacheSeconds: 5, ...config }, {
    loadAdapterModule: deps.loadAdapterModule,
    catalogStore: deps.catalogStore
  });
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
    renders: decided.render,
    consoleConnected: decided.consoleConnected
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
      // The platform's own refusal, in its own envelope — the shape
      // `fetchConsole` has to recognise at BOTH layers (HTTP status and code).
      return envelope({ code: 401, message: "Not logged in or invalid token", data: null }, 401);
    }
    const answer = consoleAnswer(target);
    if (answer !== null) return envelope(answer);
    return new Response("{}", { status: 404 });
  };
  stub.calls = calls;
  return stub;
}

/** A login-flow stub: Agnes answers ONE POST /api/user/login. */
async function loginNetwork({ loginOk = true } = {}) {
  const log = { logins: 0, tokens: 0 };
  const stub = async (url, init) => {
    const target = String(url);
    if (target.includes("/api/user/login")) {
      log.logins += 1;
      return loginOk
        ? envelope({ code: 200, message: "ok", data: { access_token: jwtExpiring(180), user: { id: 1 } } })
        // Agnes's own refusal, verbatim: a bad pair answers exactly this.
        : envelope({ code: 401, message: "Invalid username or password", data: null }, 401);
    }
    const answer = consoleAnswer(target);
    if (answer !== null) return envelope(answer);
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

// === A. a fresh stored token reaches the console and returns the quota =====
{
  const token = jwtExpiring(120);
  const credentials = makeCredentials(storedGrant(token, "r1", 7200));
  const stub = consoleStub();
  await withNetwork(stub, async () => {
    const response = await (await mount(credentials))(SNAPSHOT_PATH, makeRequest());
    check("snapshot succeeds", response.payload.ok === true, JSON.stringify(response.payload).slice(0, 120));
    check("the current plan is identified from the catalogue",
      response.payload?.quota?.plan?.name === "入门版",
      JSON.stringify(response.payload?.quota?.plan));
    check("the four quota windows are built from the plan's own limits",
      JSON.stringify((response.payload?.quota?.windows ?? []).map((w) => [w.key, w.limit])) ===
        JSON.stringify([["requests5h", 1500], ["requestsWeekly", 15000], ["imagesDaily", 4000], ["videoDaily", 500]]),
      JSON.stringify(response.payload?.quota?.windows));
    // The windows also carry the platform's own per-window consumption, merged
    // from the SAME subscription fetch the plan identity came from — quoted
    // verbatim, never a `limit - total` this plugin computed.
    check("each window carries the platform's own used figure",
      JSON.stringify((response.payload?.quota?.windows ?? []).map((w) => [w.key, w.used])) ===
        JSON.stringify([["requests5h", 548], ["requestsWeekly", 4454], ["imagesDaily", 8], ["videoDaily", 28]]),
      JSON.stringify((response.payload?.quota?.windows ?? []).map((w) => [w.key, w.used])));
    check("the 5-hour window carries its reset moment and range",
      (() => {
        const w = (response.payload?.quota?.windows ?? []).find((x) => x.key === "requests5h");
        return w?.resetInSeconds === 692 && w?.usagePct === 36.5 &&
          new Date(w?.resetAt * 1000).toISOString() === "2026-10-01T07:00:00.000Z";
      })(),
      JSON.stringify((response.payload?.quota?.windows ?? []).find((x) => x.key === "requests5h")));
    check("the account totals are parsed",
      response.payload?.quota?.totals?.totalRequests === 12345 &&
      response.payload?.quota?.totals?.activeDays === 7,
      JSON.stringify(response.payload?.quota?.totals));
    check("the usage series is parsed into buckets, in time order",
      response.payload?.usage?.buckets?.length === 2 &&
      response.payload?.usage?.buckets?.[0]?.bucket === "2026-09-29" &&
      response.payload?.usage?.windowTotals?.totalRequests === 350,
      JSON.stringify(response.payload?.usage));
    check("the plan catalogue reaches the panel",
      response.payload?.quota?.plans?.length === 1 &&
      response.payload?.quota?.plans?.[0]?.limits?.requests5h === 1500);
    check("a working panel does not show the form",
      panelDecision(response.payload).renders === "pools");
    // The three authenticated calls carry the stored token; the catalogue is
    // anonymous ON PURPOSE — sending a Bearer to it would be a needless
    // credential exposure on a route that does not want one.
    const authed = stub.calls.filter((c) => !c.target.includes("/plans"));
    check("console saw the stored token",
      authed.length === 3 && authed.every((c) => c.auth === `Bearer ${token}`),
      JSON.stringify(authed.map((c) => c.auth)));
    check("the public catalogue was fetched without a token",
      stub.calls.some((c) => c.target.includes("/plans") && c.auth === ""));
  }).catch((error) => fail("A: fresh token", error));
}

// === A2. the series cache actually hits across polls =====================
// The series endpoint carries a 5-minute cache. Its URL is built from
// `start_date`/`end_date`, so it is stable for the whole day: two polls in the
// same day must share one console call. A URL that baked in `Date.now()` would
// differ on every poll and the cache would never match.
{
  const token = jwtExpiring(120);
  const credentials = makeCredentials(storedGrant(token, "r", 7200));
  const stub = consoleStub();
  await withNetwork(stub, async () => {
    const call = await mount(credentials, { cacheSeconds: 5 });
    const first = await call(SNAPSHOT_PATH, makeRequest());
    const second = await call(SNAPSHOT_PATH, makeRequest());
    const seriesCalls = stub.calls.filter((c) => c.target.includes("/api/usage/series"));
    check("both polls succeed", first.payload.ok === true && second.payload.ok === true,
      `${first.payload.ok}/${second.payload.ok}`);
    check("the series response is served from cache on the second poll",
      seriesCalls.length === 1, `series console calls=${seriesCalls.length}`);
    check("the second poll still carries the charted buckets",
      second.payload?.usage?.buckets?.length === 2);
    // The property that makes the URL stable: a whole-day window, in dates.
    const query = new URL(seriesCalls[0].target).searchParams;
    const start = query.get("start_date");
    const end = query.get("end_date");
    check("the series window is stated as dates, not timestamps",
      /^\d{4}-\d{2}-\d{2}$/.test(start ?? "") && /^\d{4}-\d{2}-\d{2}$/.test(end ?? ""),
      `start=${start} end=${end}`);
    check("the window is the configured number of days",
      Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) === 29,
      `${start}..${end}`);
  }).catch((error) => fail("A2: series cache hit", error));
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
    const overviewCalls = stub.calls.filter((c) => c.target.includes("/api/usage/overview"));
    const seriesCalls = stub.calls.filter((c) => c.target.includes("/api/usage/series"));
    check("both concurrent polls succeed",
      first.payload.ok === true && second.payload.ok === true,
      `${first.payload.ok}/${second.payload.ok}`);
    check("the usage overview was fetched once, not twice",
      overviewCalls.length === 1, `overview calls=${overviewCalls.length}`);
    check("the usage series was fetched once, not twice",
      seriesCalls.length === 1, `series calls=${seriesCalls.length}`);
    check("both polls still carry the charted buckets",
      first.payload?.usage?.buckets?.length === 2 &&
      second.payload?.usage?.buckets?.length === 2);
  }).catch((error) => fail("A3: single-flight", error));
}

// === B. a 401 triggers one fresh sign-in and a successful retry ===========
// Agnes issues no refresh token, so a refused token is replaced by signing in
// again with the stored account. The environment is the only durable password
// source, so this block arms AGNES_PASSWORD for its own run and restores it
// afterwards (the suite-wide env is otherwise isolated by isolateHostEnv).
{
  const dead = jwtExpiring(120);
  const credentials = makeCredentials(storedGrant(dead, "", 7200), {
    refs: { AGNES_USERNAME: "u" }
  });
  const savedUser = process.env.AGNES_USERNAME;
  const savedPass = process.env.AGNES_PASSWORD;
  process.env.AGNES_USERNAME = "u";
  process.env.AGNES_PASSWORD = "p";
  let logins = 0;
  const stub = consoleStub({ rejectFirstToken: dead });
  try {
    await withNetwork(async (url, init) => {
      if (String(url).includes("/api/user/login")) {
        logins += 1;
        return envelope({ code: 200, message: "ok", data: { access_token: jwtExpiring(180), user: { id: 1 } } });
      }
      return stub(url, init);
    }, async () => {
      const response = await (await mount(credentials))(SNAPSHOT_PATH, makeRequest());
      check("401 is recovered", response.payload.ok === true, JSON.stringify(response.payload).slice(0, 160));
      check("a fresh sign-in recovered it", logins === 1, `logins=${logins}`);
      // EXACTLY ONE rejection, not one per endpoint. The usage overview is the
      // auth probe and runs alone, so the dead token is presented once; by the
      // time the series and the subscription are fetched the store has already
      // healed. The catalogue is anonymous and never carries a token at all.
      // A number above 1 here means the probe stopped gating the batch, and the
      // plugin is spending a rejected platform call per source.
      const rejected = stub.calls.filter((c) => c.auth === `Bearer ${dead}`);
      check("the dead token is presented exactly once",
        rejected.length === 1, `rejected=${rejected.length}`);
    }).catch((error) => fail("B: 401 recovery", error));
  } finally {
    if (savedUser === undefined) delete process.env.AGNES_USERNAME; else process.env.AGNES_USERNAME = savedUser;
    if (savedPass === undefined) delete process.env.AGNES_PASSWORD; else process.env.AGNES_PASSWORD = savedPass;
  }
}

// === C. a persistent rejection reports auth state, not a refresh storm =====
// Agnes has no refresh token to storm with: a console that keeps refusing the
// token, with no account to re-sign-in from, degrades to "needs an account".
//
// DEGRADES, not refuses. The whole-body `ok:false` this block used to pin was
// the all-or-nothing shape: one missing module (the console) took down three
// tabs, two of which never read it. The reason now rides on the quota source
// (`quota.error.code`) with `quota.consoleConnected:false`, and the panel says
// so in place — ARCHITECTURE.md §5.
{
  const dead = jwtExpiring(120);
  const credentials = makeCredentials(storedGrant(dead, "", 7200));
  await withNetwork(async (url) => {
    if (String(url).includes("/api/user/login")) {
      return new Response(JSON.stringify({ code: 401, message: "Invalid username or password", data: null }),
        { status: 401, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
  }, async () => {
    const response = await (await mount(credentials))(SNAPSHOT_PATH, makeRequest());
    check("a persistent rejection degrades cleanly", response.payload.ok === true,
      JSON.stringify(response.payload).slice(0, 160));
    check("it reports not_configured on the quota source (Agnes cannot refresh)",
      response.payload.quota?.error?.code === "not_configured", String(response.payload.quota?.error?.code));
    check("it says the console is not connected",
      response.payload.quota?.consoleConnected === false, String(response.payload.quota?.consoleConnected));
    // The honesty patch: a usage figure nobody could read must NOT come out as
    // a zeroed block. `parseUsageOverview({})` would print "0 requests /
    // 0 tokens" and turn a failure into a measurement.
    check("the totals are absent, not zeroed", response.payload.quota?.totals === null,
      JSON.stringify(response.payload.quota?.totals));
    check("the failure carries auth state", response.payload.auth !== undefined);
    // Several sources fail at once here (every authenticated one, plus the
    // console-shaped answer the public catalogue got). `quota.error` can only
    // name one of them, which is a lossy answer to "what is wrong" — so the
    // whole set rides alongside it, and the single line stays the first of it.
    check("every failed source is reported, not just the first",
      Array.isArray(response.payload.quota?.errors) && response.payload.quota.errors.length >= 2,
      JSON.stringify(response.payload.quota?.errors));
    check("the one-line error is the first of the set",
      response.payload.quota?.errors?.[0]?.source === response.payload.quota?.error?.source
        && response.payload.quota?.errors?.[0]?.code === response.payload.quota?.error?.code,
      JSON.stringify(response.payload.quota?.errors?.[0]));
    check("no failure in the set carries an unredacted text",
      response.payload.quota?.errors?.every((entry) => typeof entry.message === "string") !== false,
      JSON.stringify(response.payload.quota?.errors?.map((e) => e.message)));

    const decision = panelDecision(response.payload);
    check("the panel is still told the account is the next action", decision.needsSetup === true);
    check("the panel reads the console as not connected", decision.consoleConnected === false,
      String(decision.consoleConnected));
  }).catch((error) => fail("C: persistent rejection", error));
}

// === D. a cross-origin request is refused ================================
{
  const token = jwtExpiring(120);
  const credentials = makeCredentials(storedGrant(token, "r", 7200));
  const host = await import(`../src/host/index.ts?origin=${Math.random()}`);
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

    // Bare IPv6: the whitelist carries "::1" alongside "[::1]", and both
    // spellings must reach it. hostName() used to return "" for "::1" (the
    // first split segment of "::1"), which made the bare entry unreachable —
    // a host the operator named but no request could ever match.
    const bare = await call(SNAPSHOT_PATH, makeRequest({ host: "::1" }));
    check("a bare \"::1\" host is admitted", bare.statusCode === 200, String(bare.statusCode));
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
//
// Since the panel learned to degrade, the same situation answers `ok:true`
// with `quota.consoleConnected:false` — the account is still the next action,
// but the two tabs that never read the console stay reachable.
{
  const net = await loginNetwork();
  await withNetwork(net, async () => {
    const call = await mount(null);
    const snapshot = await call(SNAPSHOT_PATH, makeRequest());
    check("a Host without credentials still answers", snapshot.statusCode === 200, String(snapshot.statusCode));
    check("it degrades instead of refusing", snapshot.payload.ok === true,
      JSON.stringify(snapshot.payload).slice(0, 140));
    check("it is not the auth_unavailable dead end", snapshot.payload.code !== "auth_unavailable",
      String(snapshot.payload.code));
    check("it reports not_configured on the quota source",
      snapshot.payload.quota?.error?.code === "not_configured", String(snapshot.payload.quota?.error?.code));
    check("it says the console is not connected",
      snapshot.payload.quota?.consoleConnected === false, String(snapshot.payload.quota?.consoleConnected));
    check("the totals are absent, not zeroed", snapshot.payload.quota?.totals === null,
      JSON.stringify(snapshot.payload.quota?.totals));
    check("the response carries auth state", snapshot.payload.auth !== undefined);
    check("it is marked ephemeral", snapshot.payload.auth?.ephemeral === true, JSON.stringify(snapshot.payload.auth));

    const decision = panelDecision(snapshot.payload);
    check("THE FORM IS REACHABLE", decision.renders === "AccountForm", decision.renders);
    check("the panel is told to ask for the account", decision.needsSetup === true);
    check("the panel reads the console as not connected", decision.consoleConnected === false,
      String(decision.consoleConnected));

    // And the account route must accept a post, so the form can do its job.
    const posted = await call(ACCOUNT_PATH, makePost({ username: "u", password: "p" }));
    check("the account route accepts a post", posted.statusCode === 200, String(posted.statusCode));
    check("the post produced a grant", posted.payload.configured === true, JSON.stringify(posted.payload).slice(0, 160));

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
    check("no refresh token is held (Agnes issues none)", saved.payload.hasRefreshToken === false);
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
    check("the reason reaches the user", /invalid username or password/i.test(response.payload.error),
      response.payload.error);
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
    refs: { AGNES_USERNAME: "u", AGNES_PASSWORD: "p" }
  });
  const call = await mount(credentials);
  const response = await call(ACCOUNT_PATH, makePost({ forget: true }));
  check("forget succeeds", response.payload.ok === true);
  check("the account is gone", response.payload.hasAccount === false);
  check("the grant survives", response.payload.hasRefreshToken === true);
  check("the panel is not asked for setup", response.payload.needsAccount === false);
}

// === L2. the snapshot's contract fields are present and correct ===========
// Three fields ride on every successful snapshot and the panel branches on
// each: `shapeWarnings` (PITFALLS §12 — a renamed console field must read as
// drift, not "no usage"), and `catalogAvailable` (the optional model catalog).
// None had a direct assertion before, so a rename or a dropped field stayed
// invisible until it reached a user. This drives them through the real route
// with the network stubbed.
{
  // A drifted pair of payloads, still inside the platform's envelope: the
  // parsers return what they understood, but `total_requests` / `items` — the
  // keys `EXPECTED_SHAPES` declares — are gone.
  const DRIFT_OVERVIEW_BODY = { code: 200, message: "ok", data: { result: { data: [] } } };
  const DRIFT_SERIES_BODY = { code: 200, message: "ok", data: { series: [] } };
  // A token unique to this block. index.js is a module singleton across mounts,
  // so `invalidate()` records refused tokens process-wide; reusing a JWT an
  // earlier section had its console reject would make getToken throw "not being
  // retried" here for a reason unrelated to the fields under test.
  const l2Token = jwtExpiring(120) + "-l2";
  // The throttle file is shared across mounts too (same isolated DSH_HOME), and
  // an earlier section parks a credential refusal that never expires on its own.
  // Clear it so these contract-field checks start from a clean slate rather than
  // inheriting another test's parked refusal.
  await createFileThrottleStore().clear();
  const driftStub = async (url) => {
    const target = String(url);
    if (target.includes("/api/usage/overview")) return envelope(DRIFT_OVERVIEW_BODY);
    if (target.includes("/api/usage/series")) return envelope(DRIFT_SERIES_BODY);
    const answer = consoleAnswer(target);
    if (answer !== null) return envelope(answer);
    return new Response("{}", { status: 404 });
  };
  await withNetwork(driftStub, async () => {
    const call = await mount(makeCredentials(storedGrant(l2Token, "r", 7200)));
    const snapshot = await call(SNAPSHOT_PATH, makeRequest());
    check("a drifted poll still succeeds", snapshot.payload.ok === true, JSON.stringify(snapshot.payload).slice(0, 120));
    check("shapeWarnings is an array", Array.isArray(snapshot.payload.shapeWarnings),
      JSON.stringify(snapshot.payload.shapeWarnings));
    const warnKeys = snapshot.payload.shapeWarnings.map((w) => `${w.api}:${w.missing}`).sort();
    check("the missing overview keys are reported as drift",
      warnKeys.includes("usage-overview:total_requests") && warnKeys.includes("usage-overview:total_tokens"),
      JSON.stringify(warnKeys));
    check("the missing series key is reported as drift",
      warnKeys.includes("usage-series:items"), JSON.stringify(warnKeys));
    check("the panel surfaces the drift rather than reading empty",
      panelDecision(snapshot.payload).renders === "pools");
  }).catch((error) => fail("L2: shapeWarnings", error));

  // The healthy path: no drift, and no API key means the catalog degrades to
  // `catalogAvailable:false` rather than throwing.
  await withNetwork(consoleStub(), async () => {
    const call = await mount(makeCredentials(storedGrant(l2Token, "r", 7200)));
    const snapshot = await call(SNAPSHOT_PATH, makeRequest());
    check("a clean poll reports no drift",
      Array.isArray(snapshot.payload.shapeWarnings) && snapshot.payload.shapeWarnings.length === 0,
      JSON.stringify(snapshot.payload.shapeWarnings));
    check("without an API key the catalog is unavailable", snapshot.payload.catalogAvailable === false,
      String(snapshot.payload.catalogAvailable));
    check("the quota still arrives without any API key",
      snapshot.payload?.quota?.windows?.length === 4,
      JSON.stringify(snapshot.payload?.quota?.windows));
  }).catch((error) => fail("L2: clean + no-catalog", error));

  // traceFile: a rejected password must leave the caller a pointer to the
  // sanitized trace. DSH_HOME is already isolated by isolateStateDir(), so this
  // writes into a scratch dir, never the real Home.
  const rejectCredentials = makeCredentials(null);
  const rejectNet = await loginNetwork({ loginOk: false });
  await withNetwork(rejectNet, async () => {
    const call = await mount(rejectCredentials);
    const response = await call(ACCOUNT_PATH, makePost({ username: "u", password: "wrong" }));
    check("a rejected sign-in fails cleanly", response.payload.ok === false);
    check("the failure carries a traceFile pointer",
      typeof response.payload.traceFile === "string" && response.payload.traceFile.length > 0,
      String(response.payload.traceFile));
  }).catch((error) => fail("L2: traceFile", error));
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

// === M. vision step two: the settings-row publish does not leak into the
// poll or crash a Host without a settings service =========================
// `visionPublish.current` is wired from `ctx.get("settings")` in apply(). The
// fake ctx in this suite has no settings service, so the publish stays null
// and a poll with a catalog must still succeed — the write is an enhancement
// that degrades to "the info layer only", never a dependency of the response.
{
  const credentials = makeCredentials(storedGrant(jwtExpiring(120), "r", 7200));
  // Give the credentials service the API key ref so the catalog is computed.
  credentials.refs.set("AGNES_TOKEN_PLAN_API_KEY", "sk-test-key-for-routing-only");
  // Build on top of a real login stub so the token flow works; extend it
  // with the /v1/models answer.
  const net = await loginNetwork();
  const extendedStub = async (url, init) => {
    const target = String(url);
    if (target.includes("/v1/models") || target.includes("/models")) {
      return new Response(JSON.stringify({
        data: [
          { id: "Agnes-6.8-flash-lite", input_modalities: ["text", "image"] },
          { id: "Agnes-u1.5-lite", input_modalities: ["text"], output_modalities: ["image"] }
        ]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return net(url, init);
  };
  await withNetwork(extendedStub, async () => {
    const call = await mount(credentials, { writeImageModelIds: true });
    const snapshot = await call(SNAPSHOT_PATH, makeRequest());
    // The poll still answers even though no settings service is present.
    check("a poll with writeImageModelIds still succeeds", snapshot.statusCode === 200,
      String(snapshot.statusCode));
    check("the poll reports ok", snapshot.payload.ok === true,
      JSON.stringify(snapshot.payload).slice(0, 120));
    // The vision identification reached the snapshot as before.
    check("the snapshot still carries visionModels",
      Array.isArray(snapshot.payload.visionModels) &&
      snapshot.payload.visionModels.length === 1 &&
      snapshot.payload.visionModels[0].id === "Agnes-6.8-flash-lite",
      JSON.stringify(snapshot.payload.visionModels));
    // Step three status rides the same poll: the key ref is recognized, the
    // counts follow the catalog, and the opt-in defaults to off.
    const llm = snapshot.payload.llm;
    check("the snapshot carries the secret-free llm block",
      llm && llm.ok === undefined && typeof llm.hasApiKey === "boolean", JSON.stringify(llm));
    check("the llm block sees the credential reference",
      llm.hasApiKey === true && llm.keySource === "credentials", JSON.stringify(llm));
    check("the llm block counts models and vision models",
      llm.modelCount === 1 && llm.visionCount === 1, JSON.stringify(llm));
    // The image-output model (Agnes-u1.5-lite) is not a chat model and
    // must not appear in the picker roster (isChatModel, 2026-09-29).
    check("the roster excludes the image-output model",
      JSON.stringify(llm.models?.map((m) => m.id)) === JSON.stringify(["Agnes-6.8-flash-lite"]),
      JSON.stringify(llm.models));
    check("the provider stays unregistered with the switch off",
      llm.registerProvider === false && llm.providerRegistered === false, JSON.stringify(llm));
    // 0.4.2: the llm block now also carries the draw-tool switch's effective
    // value and source. Without a saved panel value they are the config
    // defaults.
    check("the llm block carries the draw switch state",
      llm.drawEnabled === false && llm.drawSource === "config",
      JSON.stringify({ drawEnabled: llm.drawEnabled, drawSource: llm.drawSource }));
    // 0.4.2+: the draw block is emitted whenever the catalog is present — an
    // AUTO pick (no configured drawModelId) still addresses the catalog's
    // first image model, so `drawModel` + the candidate set are deployment
    // facts, not operator preferences. Only `drawPreferredModel` is
    // preference-shaped and absent here.
    check("auto-pick still reports drawModel + candidates when the catalog exists",
      llm.drawModel === "Agnes-u1.5-lite" &&
      llm.drawCandidateCount === 1 &&
      JSON.stringify(llm.drawCandidateIds) === JSON.stringify(["Agnes-u1.5-lite"]),
      JSON.stringify({ drawModel: llm.drawModel, candidates: llm.drawCandidateIds }));
    check("auto-pick carries no operator preference",
      !("drawPreferredModel" in llm), JSON.stringify(llm.drawPreferredModel));
    // The video block rides the same poll and the same catalog. This fixture
    // holds no video model at all, so the block must report an EMPTY candidate
    // set and no `videoModel` — the shape that tells the panel "this plan has
    // no video model", as opposed to a stale or borrowed id.
    check("the llm block carries the video switch state",
      llm.videoEnabled === false && llm.videoSource === "config",
      JSON.stringify({ videoEnabled: llm.videoEnabled, videoSource: llm.videoSource }));
    check("a catalog with no video model reports an empty video candidate set",
      llm.videoModel === undefined && llm.videoCandidateCount === 0 &&
        JSON.stringify(llm.videoCandidateIds) === JSON.stringify([]) &&
        JSON.stringify(llm.video25ModelIds) === JSON.stringify([]),
      JSON.stringify({ model: llm.videoModel, count: llm.videoCandidateCount, ids: llm.videoCandidateIds }));
    check("the llm block never carries the key",
      !JSON.stringify(llm).includes("sk-test-key-for-routing-only"));
  }).catch((error) => fail("M: vision publish without settings service", error));
}

// === M2. the snapshot reports the full video catalog and names the 2.5 ======
// The tool now drives BOTH parameter families: V2.0 (`width`/`num_frames`/
// `frame_rate`) and 2.5 (`mode`/`seconds`/`size`/`aspect_ratio`). They are
// mutually exclusive on the wire, and `defineVideoTool` picks the matching
// body builder per model — so the panel's picker must offer EVERY video model
// (`videoCandidateIds` = all of them), and `video25ModelIds` names the 2.5
// subset so the card can say which ones take the seconds scheme.
{
  const credentials = makeCredentials(null);
  credentials.refs.set("AGNES_TOKEN_PLAN_API_KEY", "sk-test-key-for-routing-only");
  const net = await loginNetwork();
  const stub = async (url, init) => {
    const target = String(url);
    if (target.includes("/v1/models") || target.includes("/models")) {
      return new Response(JSON.stringify({
        data: [
          { id: "Agnes-6.8-flash-lite", input_modalities: ["text"] },
          { id: "agnes-image-2.1-flash" },
          { id: "agnes-video-v2.0" },
          { id: "agnes-video-v2.0-flash" },
          { id: "agnes-video-2.5" },
          { id: "agnes-video-2.5-flash" }
        ]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return net(url, init);
  };
  await withNetwork(stub, async () => {
    const call = await mount(credentials);
    const snapshot = await call(SNAPSHOT_PATH, makeRequest());
    const llm = snapshot.payload.llm;
    check("M2 the poll succeeds against a mixed catalog", snapshot.payload.ok === true,
      JSON.stringify(snapshot.payload).slice(0, 120));
    check("M2 the video candidates are ALL video models (both families are drivable)",
      JSON.stringify(llm.videoCandidateIds) === JSON.stringify(["agnes-video-v2.0", "agnes-video-v2.0-flash", "agnes-video-2.5", "agnes-video-2.5-flash"]) &&
        llm.videoCandidateCount === 4,
      JSON.stringify({ ids: llm.videoCandidateIds, count: llm.videoCandidateCount }));
    check("M2 the 2.5 family is named separately as the seconds-scheme subset",
      JSON.stringify(llm.video25ModelIds) === JSON.stringify(["agnes-video-2.5", "agnes-video-2.5-flash"]),
      JSON.stringify(llm.video25ModelIds));
    check("M2 auto-pick still prefers a V2.0 model when one is present",
      llm.videoModel === "agnes-video-v2.0", String(llm.videoModel));
    check("M2 no video id is a chat model, and no image id is a video candidate",
      JSON.stringify(llm.models?.map((m) => m.id)) === JSON.stringify(["Agnes-6.8-flash-lite"]) &&
        JSON.stringify(llm.drawCandidateIds) === JSON.stringify(["agnes-image-2.1-flash"]),
      JSON.stringify({ roster: llm.models?.map((m) => m.id), draw: llm.drawCandidateIds }));
  }).catch((error) => fail("M2: the video catalog report", error));
}

// === N. the inference API-key route: save / state / forget / fence =========
// The `sk-` key is a credential REFERENCE the catalog poll and the registered
// provider share. These checks pin the three sources (reference, memory, env),
// the no-echo contract, and the same-origin fence the account route has.
{
  // N1. a credentials-backed Host: reference save and forget.
  try {
    const credentials = makeCredentials(storedGrant(jwtExpiring(120), "r", 7200));
    const call = await mount(credentials);
    const initial = await call(API_KEY_PATH, makeRequest());
    check("N1 GET reports no key initially",
      initial.payload.ok === true && initial.payload.hasApiKey === false &&
      initial.payload.keySource === null && initial.payload.ephemeral === false,
      JSON.stringify(initial.payload));
    check("N1 the state never echoes a value field",
      !("value" in initial.payload) && !("apiKey" in initial.payload));

    const blank = await call(API_KEY_PATH, makePost({ apiKey: "   " }));
    check("N1 a whitespace key is refused", blank.payload.ok === false && typeof blank.payload.error === "string",
      JSON.stringify(blank.payload));

    const saved = await call(API_KEY_PATH, makePost({ apiKey: "sk-panel-saved" }));
    check("N1 save stores the shared reference",
      saved.payload.ok === true && saved.payload.hasApiKey === true &&
      saved.payload.keySource === "credentials" && credentials.refs.get("AGNES_TOKEN_PLAN_API_KEY") === "sk-panel-saved",
      JSON.stringify(saved.payload));
    check("N1 the save response carries no echo",
      !JSON.stringify(saved.payload).includes("sk-panel-saved"));

    // The catalog poll resolves the SAME reference (the two surfaces share one
    // stored value): the snapshot's secret-free state agrees.
    const net = await loginNetwork();
    await withNetwork(async (url, init) => {
      const target = String(url);
      if (target.includes("/v1/models") || target.includes("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "m1", input_modalities: ["text"] }] }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      return net(url, init);
    }, async () => {
      const polled = await call(SNAPSHOT_PATH, makeRequest());
      check("N1 the snapshot sees the panel-saved key",
        polled.payload.ok === true && polled.payload.llm?.keySource === "credentials" &&
        polled.payload.catalogAvailable === true, JSON.stringify(polled.payload.llm));
    });

    const forgotten = await call(API_KEY_PATH, makePost({ forget: true }));
    check("N1 forget clears the reference",
      forgotten.payload.ok === true && forgotten.payload.hasApiKey === false &&
      !credentials.refs.has("AGNES_TOKEN_PLAN_API_KEY"), JSON.stringify(forgotten.payload));
  } catch (error) { fail("N1: credentials-backed API-key route", error); }

  // N2. a Host with no credentials service: memory + ephemeral.
  try {
    const call = await mount(null);
    const saved = await call(API_KEY_PATH, makePost({ apiKey: "sk-memory" }));
    check("N2 a keyless-service host keeps the key in memory and says so",
      saved.payload.ok === true && saved.payload.hasApiKey === true &&
      saved.payload.keySource === "memory" && saved.payload.ephemeral === true,
      JSON.stringify(saved.payload));
    const forgotten = await call(API_KEY_PATH, makePost({ forget: true }));
    check("N2 forget clears the in-memory key",
      forgotten.payload.ok === true && forgotten.payload.hasApiKey === false,
      JSON.stringify(forgotten.payload));
  } catch (error) { fail("N2: memory API-key route", error); }

  // N3. the environment fallback stays authoritative without a reference.
  {
    process.env.AGNES_TOKEN_PLAN_API_KEY = "sk-from-env";
    try {
      const credentials = makeCredentials(null);
      const call = await mount(credentials);
      const state = await call(API_KEY_PATH, makeRequest());
      check("N3 an env key is reported with its source",
        state.payload.hasApiKey === true && state.payload.keySource === "env",
        JSON.stringify(state.payload));
      await call(API_KEY_PATH, makePost({ forget: true }));
      const after = await call(API_KEY_PATH, makeRequest());
      check("N3 forget leaves the environment value standing",
        after.payload.hasApiKey === true && after.payload.keySource === "env",
        JSON.stringify(after.payload));
    } catch (error) {
      fail("N3: env fallback", error);
    } finally {
      delete process.env.AGNES_TOKEN_PLAN_API_KEY;
    }
  }

  // N4. the trust fence: a foreign page cannot plant or read the key.
  try {
    const call = await mount(makeCredentials(null));
    const foreign = await call(API_KEY_PATH, {
      method: "POST",
      headers: { host: "127.0.0.1:19387", origin: "https://evil.example", "content-type": "application/json" },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ apiKey: "sk-x" }), "utf8"); }
    });
    check("N4 a cross-origin API-key POST is refused", foreign.statusCode === 403,
      String(foreign.statusCode));
  } catch (error) { fail("N4: API-key trust fence", error); }
}

// === O. step three registration: the opt-in drives the llm service =========
// The peer-dependent adapter never loads in this suite: a fake factory is
// injected through apply's third argument, so what is asserted here is the
// WIRING — register/re-register with the catalog, the event, teardown on
// forget, and graceful absence of an llm service. The real peer assembly is
// covered by test/e2e.mjs.
{
  const makeFakeLlm = () => {
    const calls = { adapter: [], directory: [], releases: 0, events: [] };
    const llm = {
      calls,
      registerAdapter(ids, adapter) {
        calls.adapter.push({ ids, adapter });
        return () => { calls.releases += 1; };
      },
      registerConfigurableProviders(rows) {
        calls.directory.push(rows);
        return () => { calls.releases += 1; };
      }
    };
    return llm;
  };
  const makeFakeAdapterDeps = () => {
    const builds = [];
    return {
      builds,
      loadAdapterModule: async () => ({
        createAgnesAdapter(options) {
          builds.push(options);
          return { providerIds: ["agnes-token-plan"], adapter: { fake: true, builtFrom: options.entries.length } };
        }
      })
    };
  };

  // O1. enabled + llm service + a catalog poll: one registration for the set.
  try {
    const credentials = makeCredentials(storedGrant(jwtExpiring(120), "r", 7200));
    credentials.refs.set("AGNES_TOKEN_PLAN_API_KEY", "sk-routing");
    const llm = makeFakeLlm();
    const adapterDeps = makeFakeAdapterDeps();
    const events = [];
    const net = await loginNetwork();
    await withNetwork(async (url, init) => {
      const target = String(url);
      if (target.includes("/v1/models") || target.includes("/models")) {
        return new Response(JSON.stringify({
          data: [
            { id: "Agnes-Lite", input_modalities: ["text"] },
            { id: "Agnes-Vision", input_modalities: ["text", "image"] }
          ]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return net(url, init);
    }, async () => {
      const call = await mount(credentials, { registerProvider: true }, {
        llm, ...adapterDeps, emit: (event) => events.push(event)
      });
      // Let the mount seed (reads the private catalog store) settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const snapshot = await call(SNAPSHOT_PATH, makeRequest());
      check("O1 the snapshot reports the provider registered",
        snapshot.payload.llm?.registerProvider === true &&
        snapshot.payload.llm?.llmAvailable === true &&
        snapshot.payload.llm?.providerRegistered === true, JSON.stringify(snapshot.payload.llm));
      check("O1 the adapter was registered under the own (non-colliding) id",
        llm.calls.adapter.length >= 1 &&
        JSON.stringify(llm.calls.adapter.at(-1).ids) === JSON.stringify(["agnes-token-plan"]),
        JSON.stringify(llm.calls.adapter.map((c) => c.ids)));
      check("O1 the provider directory row was declared",
        llm.calls.directory.length >= 1 &&
        llm.calls.directory.at(-1)[0]?.provider === "agnes-token-plan",
        JSON.stringify(llm.calls.directory));
      const lastBuild = adapterDeps.builds.at(-1);
      check("O1 the adapter was built from the two catalog models at apiBase",
        lastBuild.entries.length === 2 && lastBuild.baseUrl === "https://api.agnes-ai.cn/v1",
        JSON.stringify({ count: lastBuild.entries.length, baseUrl: lastBuild.baseUrl }));
      check("O1 the rebuild notified catalog readers",
        events.includes("llm/adapters-updated"), JSON.stringify(events));

      // A second identical poll must NOT rebuild: the signature gate.
      const again = await call(SNAPSHOT_PATH, makeRequest());
      const buildsAfterSecond = adapterDeps.builds.length;
      await call(SNAPSHOT_PATH, makeRequest());
      check("O1 an unchanged catalog does not rebuild the provider",
        adapterDeps.builds.length === buildsAfterSecond,
        `${buildsAfterSecond} -> ${adapterDeps.builds.length}`);
      check("O1 the repeated poll still reports registered", again.payload.llm?.providerRegistered === true);

      // Forgetting the key tears the offer down (empty model list).
      await call(API_KEY_PATH, makePost({ forget: true }));
      check("O1 forget republishes with an empty model set",
        adapterDeps.builds.at(-1).entries.length === 0,
        String(adapterDeps.builds.at(-1).entries.length));
      check("O1 the previous registration pair was released on republish",
        llm.calls.releases >= 2, String(llm.calls.releases));
    });
  } catch (error) { fail("O1: provider registration on catalog poll", error); }

  // O2. enabled on a Host WITHOUT an llm service degrades, never crashes.
  try {
    const credentials = makeCredentials(storedGrant(jwtExpiring(120), "r", 7200));
    credentials.refs.set("AGNES_TOKEN_PLAN_API_KEY", "sk-routing2");
    const adapterDeps = makeFakeAdapterDeps();
    const net = await loginNetwork();
    await withNetwork(async (url, init) => {
      const target = String(url);
      if (target.includes("/v1/models") || target.includes("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "m1" }] }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      return net(url, init);
    }, async () => {
      const call = await mount(credentials, { registerProvider: true }, adapterDeps);
      const snapshot = await call(SNAPSHOT_PATH, makeRequest());
      check("O2 no llm service means registered=false but the poll survives",
        snapshot.payload.ok === true && snapshot.payload.llm?.registerProvider === true &&
        snapshot.payload.llm?.llmAvailable === false &&
        snapshot.payload.llm?.providerRegistered === false, JSON.stringify(snapshot.payload.llm));
      check("O2 the peer adapter is never built without an llm service",
        adapterDeps.builds.length === 0, String(adapterDeps.builds.length));
    });
  } catch (error) { fail("O2: registration without llm service", error); }
}

// === P. the provider switch route: the panel value beats the config default
// (docs/PROVIDER-HOT-RELOAD.md). The switch persists in the plugin state file
// and a POST republishes immediately — no llm service here, so publishing
// degrades to llmAvailable=false while the SAVED value still reports.
{
  try {
    const credentials = makeCredentials(null);
    const call = await mount(credentials);

    const initial = await call(PROVIDER_PATH, makeRequest());
    check("P1 GET reports the config default with source config",
      initial.payload.ok === true && initial.payload.registerProvider === false &&
      initial.payload.registerSource === "config", JSON.stringify(initial.payload));

    const bad = await call(PROVIDER_PATH, makePost({ enabled: "yes" }));
    check("P2 a non-boolean enabled is refused",
      bad.statusCode === 400 && bad.payload.ok === false, JSON.stringify(bad.payload));

    const on = await call(PROVIDER_PATH, makePost({ enabled: true }));
    check("P3 POST saves the panel value and reports it as source panel",
      on.payload.ok === true && on.payload.registerProvider === true &&
      on.payload.registerSource === "panel", JSON.stringify(on.payload));

    // A second mount (fresh plugin instance, same state file) must read the
    // persisted switch — the value outlives one Host process.
    const call2 = await mount(makeCredentials(null));
    const again = await call2(PROVIDER_PATH, makeRequest());
    check("P4 the panel value survives a remount",
      again.payload.registerProvider === true && again.payload.registerSource === "panel",
      JSON.stringify(again.payload));

    const off = await call2(PROVIDER_PATH, makePost({ enabled: false }));
    check("P5 switching off reports the off state with source panel",
      off.payload.ok === true && off.payload.registerProvider === false &&
      off.payload.registerSource === "panel", JSON.stringify(off.payload));

    // The GET after the flip is the same effective-value logic the snapshot's
    // `llm` block uses (this mount has no console account, so a snapshot here
    // would not carry an llm block at all — see group E).
    const offGet = await call2(PROVIDER_PATH, makeRequest());
    check("P6 GET after the flip reports the saved value",
      offGet.payload.registerProvider === false && offGet.payload.registerSource === "panel",
      JSON.stringify(offGet.payload));

    const other = await call2(PROVIDER_PATH, makePost({ forget: true }));
    check("P7 an unrelated body is refused",
      other.statusCode === 400 && other.payload.ok === false, JSON.stringify(other.payload));
  } catch (error) { fail("P: the provider switch route", error); }
}

// === Q. the model roster route: which of this key's models get offered =====
// The third way the picker writes: POST /models replaces the curated
// allow-list and republishes immediately. Three properties matter and none of
// them is covered by the other groups: the fence (a foreign page must not
// choose this Host's model list), the immediate publish (the offer must not
// wait for the next poll), and the signature handoff (the poll after a save
// must not churn the registration).
{
  const makeFakeLlm = () => {
    const calls = { adapter: [], directory: [], releases: 0, events: [] };
    return {
      calls,
      registerAdapter(ids, adapter) { calls.adapter.push({ ids, adapter }); return () => { calls.releases += 1; }; },
      registerConfigurableProviders(rows) { calls.directory.push(rows); return () => { calls.releases += 1; }; }
    };
  };
  const makeFakeAdapterDeps = () => {
    const builds = [];
    return {
      builds,
      loadAdapterModule: async () => ({
        createAgnesAdapter(options) {
          builds.push(options);
          return { providerIds: ["agnes-token-plan"], adapter: { fake: true } };
        }
      })
    };
  };

  // Q1. the fence and the method gate, before any body is trusted.
  try {
    const call = await mount(makeCredentials(null), { registerProvider: true });
    const foreign = await call(MODELS_PATH, makePost({ enabledModelIds: [] }, { origin: "https://evil.test" }));
    check("Q1 a cross-origin save is refused",
      foreign.statusCode === 403 && foreign.payload.ok === false, JSON.stringify(foreign.payload));
    const get = await call(MODELS_PATH, makeRequest());
    check("Q1 GET is not an allowed method here",
      get.statusCode === 405 && get.payload.ok === false, JSON.stringify(get.payload));
  } catch (error) { fail("Q1: the roster route fence", error); }

  // Q2-Q7. with a real session, a catalog, and an llm service.
  try {
    const credentials = makeCredentials(storedGrant(jwtExpiring(120), "r", 7200));
    credentials.refs.set("AGNES_TOKEN_PLAN_API_KEY", "sk-roster");
    const llm = makeFakeLlm();
    const adapterDeps = makeFakeAdapterDeps();
    const net = await loginNetwork();
    await withNetwork(async (url, init) => {
      const target = String(url);
      if (target.includes("/v1/models") || target.includes("/models")) {
        return new Response(JSON.stringify({
          data: [
            { id: "Agnes-Lite", input_modalities: ["text"] },
            { id: "Agnes-Vision", input_modalities: ["text", "image"] },
            { id: "Agnes-Pro", input_modalities: ["text"] }
          ]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return net(url, init);
    }, async () => {
      const call = await mount(credentials, { registerProvider: true }, {
        llm, ...adapterDeps, emit: () => {}
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The state file is shared across the whole suite, so the panel switch
      // may still be off from group P: turn it on the way a panel would.
      const enableSwitch = await call(PROVIDER_PATH, makePost({ enabled: true }));
      check("Q2 the panel switch can be turned on in the same session",
        enableSwitch.statusCode === 200 && enableSwitch.payload.ok === true &&
          enableSwitch.payload.registerProvider === true, JSON.stringify(enableSwitch.payload));

      // Q2. The picker's own read: the snapshot hands the roster to it.
      // Rows carry the per-model availability markers (ROADMAP §2.2): the
      // panel shows every chat model, greyed with the reason when its pool
      // is exhausted, so `available`/`quotaExhausted` travel even when true.
      // `contextWindow` rides too: the catalog stub declares no context
      // field, so every row carries `contextWindowOf`'s 128k fallback.
      // `maxOutputLength` is 0 (nothing declared); no `multiplier` rides at
      // all, because `trendMultipliers` defaults to `{}` — the ×N badge is the
      // operator's own annotation, and an unmatched row gets no badge rather
      // than a guessed 1. One matcher serves both the roster and the chart.
      // `thinkingLevels` is the Agnes safe-set for an unprobed id: off→none,
      // plus low/medium/high (the provider row advertises these); xhigh/max
      // stay closed until a live-contract probe proves them on a specific
      // model. These fake-catalog ids are not in the probe table
      // (PROBED_EFFORT), so they ride exactly that set.
      const snapshot = await call(SNAPSHOT_PATH, makeRequest());
      check("Q2 the snapshot hands the picker the whole roster with a vision verdict",
        JSON.stringify(snapshot.payload.llm?.models) === JSON.stringify([
          { id: "Agnes-Lite", name: "Agnes-Lite", vision: false, available: true, quotaExhausted: false, contextWindow: 128000, maxOutputLength: 0, thinkingLevels: ["off", "low", "medium", "high"] },
          { id: "Agnes-Vision", name: "Agnes-Vision", vision: true, available: true, quotaExhausted: false, contextWindow: 128000, maxOutputLength: 0, thinkingLevels: ["off", "low", "medium", "high"] },
          { id: "Agnes-Pro", name: "Agnes-Pro", vision: false, available: true, quotaExhausted: false, contextWindow: 128000, maxOutputLength: 0, thinkingLevels: ["off", "low", "medium", "high"] }
        ]), JSON.stringify(snapshot.payload.llm?.models));
      check("Q2 the snapshot quotes the profile's pinned thinking default",
        snapshot.payload.llm?.thinkingDefault === "high",
        String(snapshot.payload.llm?.thinkingDefault));
      check("Q2 an uncurated install reports an empty allow-list",
        JSON.stringify(snapshot.payload.llm?.enabledModelIds) === JSON.stringify([]),
        JSON.stringify(snapshot.payload.llm?.enabledModelIds));
      check("Q2 an empty allow-list still offers every model",
        snapshot.payload.llm?.modelCount === 3 && snapshot.payload.llm?.visionCount === 1,
        JSON.stringify({ m: snapshot.payload.llm?.modelCount, v: snapshot.payload.llm?.visionCount }));

      // Q3. Save a curation: it publishes immediately, with the new list.
      const buildCount = adapterDeps.builds.length;
      const save = await call(MODELS_PATH, makePost({ enabledModelIds: ["Agnes-Vision"] }));
      check("Q3 a save reports the saved allow-list",
        save.statusCode === 200 && save.payload.ok === true &&
          JSON.stringify(save.payload.enabledModelIds) === JSON.stringify(["Agnes-Vision"]),
        JSON.stringify(save.payload));
      check("Q3 the offer was republished on the request that carried the save",
        adapterDeps.builds.length === buildCount + 1 &&
          JSON.stringify(adapterDeps.builds.at(-1).enabledIds) === JSON.stringify(["Agnes-Vision"]),
        JSON.stringify({ builds: adapterDeps.builds.length, ids: adapterDeps.builds.at(-1)?.enabledIds }));

      // Q4. The poll after the save sees the curation without a fresh catalog.
      const poll = await call(SNAPSHOT_PATH, makeRequest());
      check("Q4 the poll reports the curation",
        JSON.stringify(poll.payload.llm?.enabledModelIds) === JSON.stringify(["Agnes-Vision"]),
        JSON.stringify(poll.payload.llm?.enabledModelIds));
      check("Q4 the offer is narrowed to the ticked model",
        poll.payload.llm?.modelCount === 1 && poll.payload.llm?.visionCount === 1,
        JSON.stringify({ m: poll.payload.llm?.modelCount, v: poll.payload.llm?.visionCount }));
      check("Q4 the poll still shows the WHOLE roster",
        JSON.stringify(poll.payload.llm?.models.map((model) => model.id)) ===
          JSON.stringify(["Agnes-Lite", "Agnes-Vision", "Agnes-Pro"]),
        JSON.stringify(poll.payload.llm?.models));

      // Q5. The signature handoff: a poll that brings the same catalogue and
      // the same allow-list must not rebuild the provider.
      const settled = adapterDeps.builds.length;
      await call(SNAPSHOT_PATH, makeRequest());
      await call(SNAPSHOT_PATH, makeRequest());
      check("Q5 a save does not turn every later poll into a republish",
        adapterDeps.builds.length === settled,
        `${settled} -> ${adapterDeps.builds.length}`);

      // Q6. The sentinel: "temporarily push no models at all" must be
      // expressible, which an empty list cannot mean.
      const hide = await call(MODELS_PATH, makePost({ enabledModelIds: ["__hide_all__"] }));
      check("Q6 the hide-all sentinel is accepted and reported",
        hide.payload.ok === true && JSON.stringify(hide.payload.enabledModelIds) === JSON.stringify(["__hide_all__"]),
        JSON.stringify(hide.payload));
      check("Q6 the offer collapses to nothing",
        JSON.stringify(adapterDeps.builds.at(-1).enabledIds) === JSON.stringify(["__hide_all__"]),
        JSON.stringify(adapterDeps.builds.at(-1)?.enabledIds));
      const hidden = await call(SNAPSHOT_PATH, makeRequest());
      check("Q6 the snapshot counts zero registered models",
        hidden.payload.llm?.modelCount === 0 && hidden.payload.llm?.visionCount === 0,
        JSON.stringify({ m: hidden.payload.llm?.modelCount, v: hidden.payload.llm?.visionCount }));
      check("Q6 the roster itself is still complete",
        hidden.payload.llm?.models.length === 3, String(hidden.payload.llm?.models?.length));

      // Q7. Junk bodies are refused before anything is written.
      const missing = await call(MODELS_PATH, makePost({}));
      check("Q7 a missing field is refused, not read as 'all models'",
        missing.statusCode === 400 && missing.payload.ok === false, JSON.stringify(missing.payload));
      const wrong = await call(MODELS_PATH, makePost({ enabledModelIds: "Agnes-Lite" }));
      check("Q7 a non-array field is refused",
        wrong.statusCode === 400 && wrong.payload.ok === false, JSON.stringify(wrong.payload));
      const junk = await call(MODELS_PATH, makePost({ enabledModelIds: "not json" }));
      check("Q7 an unreadable body is refused",
        junk.statusCode === 400 && junk.payload.ok === false, JSON.stringify(junk.payload));
      const tooLong = await call(MODELS_PATH,
        makePost({ enabledModelIds: Array.from({ length: 501 }, (_, index) => `m${index}`) }));
      check("Q7 an oversized allow-list is refused",
        tooLong.statusCode === 400 && JSON.stringify(tooLong.payload).includes("too long"),
        JSON.stringify(tooLong.payload));
      check("Q7 nothing was written by the refused bodies",
        JSON.stringify(adapterDeps.builds.at(-1).enabledIds) === JSON.stringify(["__hide_all__"]),
        JSON.stringify(adapterDeps.builds.at(-1)?.enabledIds));

      // Q8. Curation survives a remount (the same state file as the switch).
      const call2 = await mount(makeCredentials(storedGrant(jwtExpiring(120), "r", 7200)),
        { registerProvider: true }, { llm: makeFakeLlm(), ...makeFakeAdapterDeps(), emit: () => {} });
      const persisted = await call2(SNAPSHOT_PATH, makeRequest());
      check("Q8 the curation outlives one Host process",
        JSON.stringify(persisted.payload.llm?.enabledModelIds) === JSON.stringify(["__hide_all__"]),
        JSON.stringify(persisted.payload.llm?.enabledModelIds));

      // Q9. Forgetting the key also forgets the curation: a new key starts
      // uncurated, not under a filter the previous key's owner set.
      await call(MODELS_PATH, makePost({ enabledModelIds: ["Agnes-Lite"] }));
      await call(API_KEY_PATH, makePost({ forget: true }));
      const after = await call(SNAPSHOT_PATH, makeRequest());
      check("Q9 forgetting the key clears the curation with it",
        JSON.stringify(after.payload.llm?.enabledModelIds) === JSON.stringify([]),
        JSON.stringify(after.payload.llm?.enabledModelIds));
    });
  } catch (error) { fail("Q: the model roster route", error); }
}

// === S. PITFALLS §40: a swallowed catalog write must not advance the signature
// `replace()`/`setEnabledIds()` swallow a write failure by contract — a
// read-only Home must not break the panel. If the caller advanced the publish
// signature anyway, that signature would describe a catalog the disk does NOT
// hold, and its one job is "equal → skip publish": the next poll, serving the
// same catalog from cache, would then skip the very write that fixes it, and
// the disk would keep the old catalog until a restart re-seeds it. Inject a
// store that never persists and assert the NEXT identical poll republishes.
{
  try {
    // Local fakes, the same shape the O/Q groups use (they are block-scoped
    // there, so they cannot be shared across groups).
    const makeFakeLlm = () => {
      const calls = { adapter: [], directory: [], releases: 0, events: [] };
      const llm = {
        calls,
        registerAdapter(ids, adapter) { calls.adapter.push({ ids, adapter }); return () => { calls.releases += 1; }; },
        registerConfigurableProviders(rows) { calls.directory.push(rows); return () => { calls.releases += 1; }; }
      };
      return llm;
    };
    const makeFakeAdapterDeps = () => {
      const builds = [];
      return {
        builds,
        loadAdapterModule: async () => ({
          createAgnesAdapter(options) {
            builds.push(options);
            return { providerIds: ["agnes-token-plan"], adapter: { fake: true } };
          }
        })
      };
    };
    const credentials = makeCredentials(storedGrant(jwtExpiring(120), "r", 7200));
    credentials.refs.set("AGNES_TOKEN_PLAN_API_KEY", "sk-failing");
    const llm = makeFakeLlm();
    const adapterDeps = makeFakeAdapterDeps();
    const net = await loginNetwork();
    // The failing store: memory updates, disk never does — exactly what a
    // swallowed write failure produces, reported honestly as `false`.
    const failingCatalogStore = {
      held: null,
      async list() { return this.held?.entries ?? []; },
      async listEnabledIds() { return this.held?.enabledModelIds ?? []; },
      async replace(entries, enabledModelIds) {
        this.held = { entries, enabledModelIds: enabledModelIds ?? [] };
        return false;
      },
      async setEnabledIds() { return false; },
      async clear() { this.held = null; }
    };
    await withNetwork(async (url, init) => {
      const target = String(url);
      if (target.includes("/v1/models") || target.includes("/models")) {
        return new Response(JSON.stringify({
          data: [
            { id: "Agnes-Lite", input_modalities: ["text"] },
            { id: "Agnes-Vision", input_modalities: ["text", "image"] }
          ]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return net(url, init);
    }, async () => {
      const call = await mount(credentials, { registerProvider: true }, {
        llm, ...adapterDeps, emit: () => {}, catalogStore: failingCatalogStore
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await call(SNAPSHOT_PATH, makeRequest());
      const afterFirst = adapterDeps.builds.length;
      check("S1 the first poll publishes the fresh catalog",
        afterFirst >= 1, String(afterFirst));
      // The write failed, so the signature must NOT have advanced: the same
      // catalog from the next poll has to republish rather than be skipped.
      await call(SNAPSHOT_PATH, makeRequest());
      check("S2 a failed write does not let the next poll skip the republish",
        adapterDeps.builds.length === afterFirst + 1,
        `${afterFirst} -> ${adapterDeps.builds.length}`);
      // Graceful degradation stands: the panel still reads the catalog it was
      // handed, even though the disk never took it.
      const snapshot = await call(SNAPSHOT_PATH, makeRequest());
      check("S3 the panel still reports the offered models",
        snapshot.payload.ok === true && snapshot.payload.llm?.modelCount === 2,
        JSON.stringify({ ok: snapshot.payload.ok, n: snapshot.payload.llm?.modelCount }));
    });
  } catch (error) { fail("S: PITFALLS §40 signature after a swallowed write", error); }
}

// === R. the draw switch route: the panel value beats the config default ====
// Same discipline as group P (the provider switch): a value saved from the
// panel lives in the plugin's own state file and wins over the patch's
// `drawEnabled`; a POST lands without a restart. The draw tool itself still
// needs the Host's tools service, but the SWITCH state is plain state — this
// group proves the round trip and the persistence across remounts.
{
  try {
    const credentials = makeCredentials(null);
    const call = await mount(credentials);

    const initial = await call(DRAW_PATH, makeRequest());
    check("R1 GET reports the config default with source config",
      initial.payload.ok === true && initial.payload.drawEnabled === false &&
        initial.payload.drawSource === "config", JSON.stringify(initial.payload));

    const bad = await call(DRAW_PATH, makePost({ enabled: "yes" }));
    check("R2 a non-boolean enabled is refused",
      bad.statusCode === 400 && bad.payload.ok === false, JSON.stringify(bad.payload));

    const on = await call(DRAW_PATH, makePost({ enabled: true }));
    check("R3 POST saves the panel value and reports it as source panel",
      on.payload.ok === true && on.payload.drawEnabled === true &&
        on.payload.drawSource === "panel", JSON.stringify(on.payload));

    // A second mount (fresh plugin instance, same state file) must read the
    // persisted switch — the value outlives one Host process.
    const call2 = await mount(credentials);
    const again = await call2(DRAW_PATH, makeRequest());
    check("R4 the panel value survives a remount",
      again.payload.drawEnabled === true && again.payload.drawSource === "panel",
      JSON.stringify(again.payload));

    const off = await call2(DRAW_PATH, makePost({ enabled: false }));
    check("R5 switching off reports the off state with source panel",
      off.payload.ok === true && off.payload.drawEnabled === false &&
        off.payload.drawSource === "panel", JSON.stringify(off.payload));

    // Forget the panel value so R6 can exercise the "untouched state file"
    // path: without this, R3's save would still be sitting in the shared
    // state file and R6 would read source "panel" instead of "config".
    const forget = await call2(DRAW_PATH, makePost({ forget: true }));
    check("R5b forgetting the panel value returns to the config default",
      forget.payload.ok === true && forget.payload.drawSource === "config",
      JSON.stringify(forget.payload));

    // A config-driven deployment keeps its operator decision when the panel
    // has never written a value: mount with `drawEnabled: true` in the patch
    // and GET the /draw route — source must say "config".
    const call3 = await mount(credentials, { drawEnabled: true });
    const configBacked = await call3(DRAW_PATH, makeRequest());
    check("R6 an untouched state file falls back to the config value",
      configBacked.payload.drawEnabled === true && configBacked.payload.drawSource === "config",
      JSON.stringify(configBacked.payload));
    // A panel-saved value still beats the config in the same room.
    const flipped = await call3(DRAW_PATH, makePost({ enabled: false }));
    check("R7 a panel save overrides the config default",
      flipped.payload.drawEnabled === false && flipped.payload.drawSource === "panel",
      JSON.stringify(flipped.payload));

    // The trust fence: a foreign page cannot flip the switch.
    const foreign = await call(DRAW_PATH, makePost({ enabled: true }, { origin: "https://evil.test" }));
    check("R8 a cross-origin draw POST is refused",
      foreign.statusCode === 403 && foreign.payload.ok === false, JSON.stringify(foreign.payload));
  } catch (error) { fail("R: the draw switch route", error); }
}

// === S. the video switch route: same handler, SEPARATE store ===============
// `/draw` and `/video` are served by ONE handler body
// (`registerToolSwitchRoute`), so the only things keeping their state apart
// are the key names and the store each closure captured. S1–S5 pin the switch
// and model round trips; S6 is the isolation check the shared handler makes
// necessary — the key names are load-bearing, and a copy-paste that reused
// `drawModelId` would silently give both tools the same model.
{
  try {
    const credentials = makeCredentials(null);
    const call = await mount(credentials);

    const initial = await call(VIDEO_PATH, makeRequest());
    check("S1 GET reports the config default with source config",
      initial.payload.ok === true && initial.payload.videoEnabled === false &&
        initial.payload.videoSource === "config", JSON.stringify(initial.payload));

    const bad = await call(VIDEO_PATH, makePost({ enabled: "yes" }));
    check("S2 a non-boolean enabled is refused",
      bad.statusCode === 400 && bad.payload.ok === false, JSON.stringify(bad.payload));

    const on = await call(VIDEO_PATH, makePost({ enabled: true }));
    check("S3 POST saves the panel value and reports it as source panel",
      on.payload.ok === true && on.payload.videoEnabled === true &&
        on.payload.videoSource === "panel", JSON.stringify(on.payload));

    // A second mount (fresh plugin instance, same state file) must read the
    // persisted switch — the value outlives one Host process.
    const call2 = await mount(credentials);
    const again = await call2(VIDEO_PATH, makeRequest());
    check("S4 the panel value survives a remount",
      again.payload.videoEnabled === true && again.payload.videoSource === "panel",
      JSON.stringify(again.payload));

    // The model pick: a string pins one, `null` returns to auto-pick. The
    // handler validates the SHAPE only (non-empty string or null); whether the
    // id is in the catalogue is the tool's business at call time.
    const pinned = await call2(VIDEO_PATH, makePost({ videoModelId: "agnes-video-v2.0" }));
    check("S5 a model id is saved and reported with source panel",
      pinned.payload.ok === true && pinned.payload.videoModelId === "agnes-video-v2.0" &&
        pinned.payload.videoModelSource === "panel", JSON.stringify(pinned.payload));

    const blank = await call2(VIDEO_PATH, makePost({ videoModelId: "  " }));
    check("S5b a blank model id is refused rather than saved",
      blank.statusCode === 400 && blank.payload.ok === false, JSON.stringify(blank.payload));

    const auto = await call2(VIDEO_PATH, makePost({ videoModelId: null }));
    // A `null` save is INDISTINGUISHABLE from an untouched state file — the
    // store normalizes it away, so the value comes back as the config default
    // ("") with source "config". That is the right answer rather than a lost
    // one: both states resolve to auto-pick, which is what the panel's radio
    // row reads. The source tag reports where the VALUE came from, not who
    // last wrote.
    check("S5c a null model id returns to auto-pick",
      auto.payload.ok === true && auto.payload.videoModelId === "" &&
        auto.payload.videoModelSource === "config", JSON.stringify(auto.payload));

    // THE ISOLATION CHECK. One handler body serves both routes, so nothing but
    // the key name and the captured store stops a draw POST from landing in
    // the video store. Pin a DIFFERENT model on each and read both back: each
    // route must report its own, and neither may report the other's.
    const crossVideo = await call2(VIDEO_PATH, makePost({ drawModelId: "Agnes-image-2.1-flash" }));
    check("S6 the video route does not accept the draw key",
      crossVideo.payload.ok === false || crossVideo.payload.videoModelId !== "Agnes-image-2.1-flash",
      JSON.stringify(crossVideo.payload));
    const crossDraw = await call2(DRAW_PATH, makePost({ videoModelId: "agnes-video-v2.0" }));
    check("S6b the draw route does not accept the video key",
      crossDraw.payload.ok === false || crossDraw.payload.drawModelId !== "agnes-video-v2.0",
      JSON.stringify(crossDraw.payload));

    await call2(VIDEO_PATH, makePost({ videoModelId: "agnes-video-v2.0" }));
    await call2(DRAW_PATH, makePost({ drawModelId: "Agnes-image-2.1-flash" }));
    const videoRead = await call2(VIDEO_PATH, makeRequest());
    const drawRead = await call2(DRAW_PATH, makeRequest());
    check("S7 the two routes keep separate model stores",
      videoRead.payload.videoModelId === "agnes-video-v2.0" &&
        drawRead.payload.drawModelId === "Agnes-image-2.1-flash",
      `video=${JSON.stringify(videoRead.payload)} draw=${JSON.stringify(drawRead.payload)}`);

    // Forget the panel value so S8 can exercise the "untouched state file"
    // path — without this the saved value would still be in the state file.
    const forget = await call2(VIDEO_PATH, makePost({ forget: true }));
    check("S7b forgetting the panel value returns to the config default",
      forget.payload.ok === true && forget.payload.videoSource === "config",
      JSON.stringify(forget.payload));

    const call3 = await mount(credentials, { videoEnabled: true });
    const configBacked = await call3(VIDEO_PATH, makeRequest());
    check("S8 an untouched state file falls back to the config value",
      configBacked.payload.videoEnabled === true && configBacked.payload.videoSource === "config",
      JSON.stringify(configBacked.payload));
    const flipped = await call3(VIDEO_PATH, makePost({ enabled: false }));
    check("S9 a panel save overrides the config default",
      flipped.payload.videoEnabled === false && flipped.payload.videoSource === "panel",
      JSON.stringify(flipped.payload));

    // The trust fence: a foreign page cannot flip the switch.
    const foreign = await call(VIDEO_PATH, makePost({ enabled: true }, { origin: "https://evil.test" }));
    check("S10 a cross-origin video POST is refused",
      foreign.statusCode === 403 && foreign.payload.ok === false, JSON.stringify(foreign.payload));
  } catch (error) { fail("S: the video switch route", error); }
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
