/**
 * A fake Agnes platform for the end-to-end run.
 *
 * It answers everything the panel asks for — the one-shot login, the console
 * usage/subscription reads, the anonymous plan catalogue and the API-key model
 * list — so the panel can reach a genuinely WORKING state and the test can
 * assert on real numbers coming out of a real Host. The password it accepts is
 * a fixed test string; it is not an account, and the e2e run sets no real
 * credentials at all.
 *
 * The real Host is booted against this on 127.0.0.1, so even a bug that tried
 * to sign in would land here rather than at the platform.
 *
 * ## What it checks, not just what it answers
 *
 * A fake that answers everything is a channel for bugs to reach users. Two
 * properties are therefore VERIFIED here rather than assumed:
 *
 * 1. **The console token.** Every authenticated route refuses a request that
 *    does not carry the exact bearer this fake issued. Without that, a plugin
 *    that sent no `authorization` header at all would still get its numbers and
 *    the run would be green.
 * 2. **The series window.** `/api/usage/series` takes DATES
 *    (`start_date`/`end_date`), not the hours the SenseNova trend took. The
 *    fake records the query it received so the test can assert the shape — a
 *    plugin that reverted to timestamps would get a 200 from a fake that did
 *    not look.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_PORT ?? 19399);
const PASSWORD = "e2e-test-password";

/** Counters the test asserts on, so "did it log in?" is answerable. */
export const log = {
  login: 0,
  overview: 0,
  series: 0,
  subscription: 0,
  plans: 0,
  catalog: 0,
  badPassword: 0,
  /** Console calls that arrived without the token this fake issued. */
  unauthenticated: 0
};

/**
 * The last credential the fake actually received, verbatim.
 *
 * Agnes ships no JWE walk: the password reaches the backend as typed over TLS,
 * so there is nothing to open — but there IS a property worth pinning, which
 * is that what arrived is exactly what was submitted. The old OIDC fake could
 * only prove that by decrypting a sealed blob; here the plaintext on the wire
 * IS the evidence.
 */
export const seen = {
  username: null,
  password: null,
  /** The bearer the console routes last saw (never the api key). */
  bearer: null,
  /** The api key `/v1/models` last saw. */
  apiKey: null,
  /** The raw query string `/api/usage/series` last saw. */
  seriesQuery: null,
  /** Whether the last login body was JSON, as the console front-end sends it. */
  loginIsJson: false
};

/** The one token this fake will accept on the console routes. */
let issuedToken = null;

/**
 * A JWT the plugin will accept, expiring in an hour.
 *
 * Three segments on purpose: `readJwtExpiry` reads `exp` off the middle one and
 * only treats a token as a JWT when it finds three. A two-part string would
 * take the `fallbackExpiresInSeconds` branch instead, and the run would stop
 * exercising the claim-reading path it exists to exercise.
 */
function freshJwt() {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.e2e`;
}

/**
 * The uuid that ties the subscription payload to the catalogue.
 *
 * `matchCurrentPlan` scores a uuid match 3 — the strongest signal it has — and
 * a numeric plan id is deliberately NOT a signal (the ids are 1–6 and a
 * subscription object is full of small integers). So the fake's subscription
 * names the 专业版 monthly entry by uuid, which is how the real payload is
 * expected to identify a plan.
 */
const PRO_UUID = "11111111-1111-4111-8111-111111111111";

/** `GET /api/usage/overview` — the account's CUMULATIVE usage. */
const OVERVIEW_DATA = {
  total_requests: 12345,
  total_tokens: 340000,
  total_images: 120,
  total_video_seconds: 480,
  active_days: 9
};

/**
 * `GET /api/usage/series` — per-bucket usage for the window that was asked for.
 *
 * Two buckets, listed newest-first on purpose: `parseUsageSeries` sorts them
 * chronologically, and a fake that pre-sorted them would let a broken sort pass.
 */
const SERIES_DATA = {
  items: [
    { bucket: "2026-09-30", request_count: 40, text_tokens: 1000, image_count: 1, video_seconds: 10 },
    { bucket: "2026-09-29", request_count: 60, text_tokens: 2000, image_count: 2, video_seconds: 20 }
  ]
};

/** `GET /api/cn/user/subscription` — the signed-in account's own plan. */
const SUBSCRIPTION_DATA = {
  plan_uuid: PRO_UUID,
  billing_cycle: "monthly",
  status: "active",
  expires_at: "2026-11-01T00:00:00Z"
};

/**
 * `GET /api/cn/user/subscription/plans` — the PUBLIC catalogue.
 *
 * Verified live 2026-10-01 against an anonymous request: six entries —
 * 入门版 / 专业版 / 高级版, each in a monthly and a yearly variant. The daily
 * image (4000) and video (500) caps are identical across all three tiers,
 * which is why only the request dimensions differentiate the plans. The fake
 * keeps that shape so the panel's "what does upgrading buy" line is exercised
 * against the same field names the platform uses.
 */
function planEntry({ id, uuid, name, cycle, priceMinor, concurrency, weekly }) {
  return {
    id,
    uuid,
    name,
    display_name: name,
    billing_cycle: cycle,
    display_cycle: cycle === "yearly" ? "年付" : "月付",
    price_minor: priceMinor,
    currency: "CNY",
    concurrency_limit: concurrency,
    concurrency_window_h: 5,
    text_weekly_limit: weekly,
    image_daily_limit: 4000,
    video_daily_limit: 500,
    usage_limit_text: `${concurrency} 次模型请求 / 5 小时`,
    feature_texts: [`每周 ${weekly} 次模型请求`, "图片与视频按日限额"]
  };
}

const PLANS_DATA = [
  planEntry({ id: 1, uuid: "aaaaaaa1-0000-4000-8000-000000000001", name: "入门版", cycle: "monthly", priceMinor: 4900, concurrency: 1500, weekly: 15000 }),
  planEntry({ id: 2, uuid: "aaaaaaa2-0000-4000-8000-000000000002", name: "入门版", cycle: "yearly", priceMinor: 49000, concurrency: 1500, weekly: 15000 }),
  planEntry({ id: 3, uuid: PRO_UUID, name: "专业版", cycle: "monthly", priceMinor: 9900, concurrency: 7500, weekly: 75000 }),
  planEntry({ id: 4, uuid: "aaaaaaa4-0000-4000-8000-000000000004", name: "专业版", cycle: "yearly", priceMinor: 99900, concurrency: 7500, weekly: 75000 }),
  planEntry({ id: 5, uuid: "aaaaaaa5-0000-4000-8000-000000000005", name: "高级版", cycle: "monthly", priceMinor: 29900, concurrency: 30000, weekly: 300000 }),
  planEntry({ id: 6, uuid: "aaaaaaa6-0000-4000-8000-000000000006", name: "高级版", cycle: "yearly", priceMinor: 299900, concurrency: 30000, weekly: 300000 })
];

/**
 * `GET {apiBase}/models` — one text-only, one vision-capable, one
 * image-output-only entry.
 *
 * The three-way split is the whole point: it is what distinguishes
 * input-modality from output-modality. A vision model takes pictures in; an
 * image-generation model puts pictures out and answers 404 on
 * `/v1/chat/completions`, so offering it as a chat model only produces errors
 * in DSH. A fake with a single model would let that conflation pass.
 *
 * The envelope is `{data:[…]}` — the OpenAI-compatible shape
 * `fetchModelCatalog` unwraps, NOT the console's `{code,message,data}`. A fake
 * answering the console envelope here would hand the plugin an empty catalog
 * and let a broken unwrap pass.
 */
const CATALOG_BODY = {
  data: [
    {
      id: "deepseek-v4-flash",
      name: "deepseek-v4-flash",
      input_modalities: ["text"],
      output_modalities: ["text"],
      context_length: 131072,
      max_output_length: 8192
    },
    {
      id: "Agnes-6.8-flash-lite",
      name: "Agnes-6.8-flash-lite",
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      context_length: 65536,
      max_output_length: 4096
    },
    {
      id: "Agnes-u1-fast",
      name: "Agnes-u1-fast",
      input_modalities: ["text"],
      output_modalities: ["image"]
    }
  ]
};

function json(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

/**
 * The platform's success envelope: `{code: 200, message: "ok", data: …}`.
 *
 * Agnes wraps every console answer this way, and a 200 can still carry a
 * refusal — which is why the fake never answers a bare object on a console
 * route. A plugin that forgot to unwrap would read `data` as `undefined` and
 * the panel would say "no data yet" instead of showing these numbers.
 */
function ok(res, data) {
  return json(res, 200, { code: 200, message: "ok", data });
}

/** The platform's own refusal shape, verbatim. */
function refused(res, status, code, message) {
  return json(res, status, { code, message, data: null });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
  });
}

/** The bearer a request presented, or `""`. */
function bearerOf(req) {
  const header = req.headers.authorization;
  return typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * Gate one authenticated console route.
 *
 * A request that does not carry the token this fake minted is refused the way
 * the real gateway refuses one — HTTP 401 with `code: 401` in the envelope.
 * That double signal is what `fetchConsole` keys its single renewal retry off,
 * and it is also the check that stops a plugin which never authenticated from
 * reading the numbers anyway.
 * @returns {boolean} whether the caller may proceed.
 */
function admitConsole(req, res) {
  const bearer = bearerOf(req);
  seen.bearer = bearer === "" ? null : bearer;
  if (issuedToken === null || bearer !== issuedToken) {
    log.unauthenticated += 1;
    refused(res, 401, 401, "Not logged in or invalid token");
    return false;
  }
  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const body = req.method === "POST" ? await readBody(req) : "";
  // One line per request, so a test failure can be read straight off the log
  // instead of guessed at.
  process.stdout.write(`fake: ${req.method} ${path}\n`);

  if (path === "/api/user/login") {
    // Agnes's whole login flow: one username + password POST answering with a
    // single access_token (no OIDC walk, no refresh token). The password
    // travels in the clear over TLS, so the fake reads it straight off the
    // body — there is no JWE to open on this platform.
    log.login += 1;
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* refusal below */ }
    seen.loginIsJson = body.trim().startsWith("{");
    seen.username = typeof parsed.username === "string" ? parsed.username : null;
    seen.password = typeof parsed.password === "string" ? parsed.password : null;
    process.stdout.write(`fake: login username=${seen.username} password=${JSON.stringify(seen.password)}\n`);
    if (seen.password !== PASSWORD) {
      log.badPassword += 1;
      // Agnes's own refusal, verbatim: a bad pair answers exactly this.
      return refused(res, 401, 401, "Invalid username or password");
    }
    issuedToken = freshJwt();
    return ok(res, { access_token: issuedToken, user: { id: 1, username: seen.username } });
  }

  if (path === "/api/usage/overview") {
    if (!admitConsole(req, res)) return;
    log.overview += 1;
    return ok(res, OVERVIEW_DATA);
  }
  if (path === "/api/usage/series") {
    if (!admitConsole(req, res)) return;
    log.series += 1;
    // Recorded so the test can assert the window arrived as DATES. The endpoint
    // takes `start_date`/`end_date`, and a plugin that sent hour timestamps
    // would still get a 200 from a fake that did not look.
    seen.seriesQuery = url.search;
    return ok(res, SERIES_DATA);
  }
  if (path === "/api/cn/user/subscription") {
    if (!admitConsole(req, res)) return;
    log.subscription += 1;
    return ok(res, SUBSCRIPTION_DATA);
  }
  if (path === "/api/cn/user/subscription/plans") {
    // PUBLIC: no `authorization` header is sent, and sending an empty Bearer
    // turns this into a refused request on the real gateway — so the fake
    // refuses one too, rather than quietly tolerating the mistake.
    log.plans += 1;
    if (req.headers.authorization !== undefined) {
      return refused(res, 401, 401, "Not logged in or invalid token");
    }
    return ok(res, PLANS_DATA);
  }

  if (path === "/v1/models") {
    log.catalog += 1;
    const key = bearerOf(req);
    seen.apiKey = key === "" ? null : key;
    // The gateway authenticates this one with the API key, not the console
    // token — a plugin that reused the console token here would be refused.
    if (key === "") return refused(res, 401, 401, "Missing API key");
    // NOT enveloped: this is the OpenAI-compatible gateway, not the console.
    return json(res, 200, CATALOG_BODY);
  }

  return json(res, 404, { error: `no fake route for ${path}` });
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`fake-platform listening on http://127.0.0.1:${PORT}\n`);
});

/** Close cleanly so the test can finish. */
export function close() {
  return new Promise((resolve) => server.close(resolve));
}

export { PASSWORD, PORT };
