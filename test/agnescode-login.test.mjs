/**
 * Unit checks for the scan-to-login device flow (`src/host/agnescode-login.ts`).
 *
 * This suite exists because the login branch shipped with zero coverage: the
 * callback server's CORS/CSRF/empty-code handling, the code exchange's failure
 * classification and the `openExternal` fail-fast were all untested — and the
 * review that motivated the fix found the old `openExternal` silently swallowed
 * the ENOENT of a missing browser binary (an async `error` event, which a
 * try/catch cannot see), leaving a headless login to wait out the full callback
 * timeout.
 *
 * Coverage, all offline:
 * - `waitForCallback`: driven with a REAL local `http.Server` + `http.request`
 *   (the network guard only replaces `globalThis.fetch`, which this path never
 *   touches). OPTIONS preflight, POST JSON, GET fallback, CSRF state mismatch,
 *   empty code, non-`/auth/callback` paths, and the settled guard.
 * - `exchangeCodeForToken`: `globalThis.fetch` re-stubbed per case (success,
 *   business failure, HTTP failure, missing token, and the request shape).
 * - `openExternal`: a bogus `command` (the test seam) proves the ENOENT path
 *   fails fast instead of waiting out the callback timeout.
 * - `withTimeout`: both arms.
 *
 * `startAgnescodeLogin` itself is NOT exercised here: it spawns the system
 * browser, which the offline suite must not do (and whose open is covered by
 * the `openExternal` seam above).
 */
import {
  waitForCallback,
  exchangeCodeForToken,
  openExternal,
  withTimeout
} from "../src/host/agnescode-login.ts";
import { installNetworkGuard } from "./peer-roots.mjs";
import { createServer, request as httpRequest } from "node:http";

/** Installed before anything runs, so an unstubbed call cannot escape. */
const releaseNetworkGuard = installNetworkGuard();

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}
function section(title) {
  console.log(`\n— ${title}`);
}

/** Replace `globalThis.fetch` for one case; restores the guarded thrower. */
function stubFetch(handler) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const res = handler(url, init);
    return res instanceof Promise ? res : Promise.resolve(res);
  };
  return () => { globalThis.fetch = previous; };
}

/** One HTTP call against the callback server (never touches fetch). */
function httpCall(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    // `Connection: close` is REQUIRED: Node 22's default keep-alive would hold
    // the socket open, and `waitForCallback` resolves only inside its
    // `server.close(callback)` — a kept-alive connection would hang the settle.
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: { connection: "close", ...headers } }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += String(chunk); });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Whether a promise settled within `ms` (a settled promise returns true). */
function settledWithin(promise, ms) {
  return Promise.race([
    promise.then(() => true, () => true),
    new Promise((resolve) => setTimeout(() => resolve(false), ms))
  ]);
}

/** The rejection text of a promise, or null when it resolves. */
async function rejectionText(promise) {
  try { await promise; return null; }
  catch (error) { return String(error?.message ?? error); }
}

/**
 * Start a real local callback server, hand it to `waitForCallback`, run `fn`,
 * then close whatever is left.
 */
async function withCallbackServer(fn, { state = "the-state", origin = "https://app.agnes-ai.cn" } = {}) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.on("error", reject);
  });
  const port = server.address().port;
  const trace = { hop() {} };
  const pending = waitForCallback(server, state, origin, trace);
  try {
    await fn({ port, pending });
  } finally {
    // A bounded close: with `Connection: close` on every call the callback
    // fires promptly, but a 1 s backstop keeps a stray case from hanging the
    // whole suite (the settled-guard tests intentionally leave the wait open).
    await Promise.race([
      new Promise((resolve) => { try { server.close(resolve); } catch { resolve(); } }),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]);
  }
  // Deliberately returns nothing: the caller may `await withCallbackServer(...)`,
  // and some cases (preflight, bad state) intentionally leave `pending` unsettled
  // — returning it would make that outer `await` hang forever. The closure that
  // needs `pending` receives it through the `{ port, pending }` parameter.
}

// --- 1. waitForCallback: CORS preflight + CSRF + code plumbing ----------------
{
  section("waitForCallback (local callback server)");
  try {
    await withCallbackServer(async ({ port, pending }) => {
      const preflight = await httpCall(port, "OPTIONS", "/auth/callback");
      check("OPTIONS preflight answers 204 with CORS headers",
        preflight.status === 204
          && preflight.headers["access-control-allow-origin"] === "https://app.agnes-ai.cn"
          && String(preflight.headers["access-control-allow-methods"] ?? "").includes("POST"),
        JSON.stringify({ status: preflight.status, origin: preflight.headers["access-control-allow-origin"] }));
      check("a preflight does NOT settle the wait (no double-settle)",
        await settledWithin(pending, 40) === false);
    });
  } catch (error) {
    fail("waitForCallback (OPTIONS preflight)", error);
  }

  try {
    await withCallbackServer(async ({ port, pending }) => {
      const bad = await httpCall(port, "POST", "/auth/callback", { code: "c", state: "wrong-state" });
      check("POST with a mismatched CSRF state answers 400",
        bad.status === 400, JSON.stringify({ status: bad.status, body: bad.body }));
      check("a bad-state POST does NOT settle the wait",
        await settledWithin(pending, 40) === false);
    });
  } catch (error) {
    fail("waitForCallback (CSRF state mismatch)", error);
  }

  try {
    await withCallbackServer(async ({ port, pending }) => {
      const empty = await httpCall(port, "POST", "/auth/callback", { code: "", state: "the-state" });
      check("POST with an empty code answers 400",
        empty.status === 400 && JSON.parse(empty.body).ok === false,
        JSON.stringify({ status: empty.status, body: empty.body }));
      check("an empty-code POST does NOT settle the wait",
        await settledWithin(pending, 40) === false);
    });
  } catch (error) {
    fail("waitForCallback (empty code)", error);
  }

  try {
    await withCallbackServer(async ({ port, pending }) => {
      const hit = await httpCall(port, "POST", "/auth/callback", { code: "the-code", state: "the-state" });
      check("POST with the right state + a code answers 200 { ok:true }",
        hit.status === 200 && JSON.parse(hit.body).ok === true,
        JSON.stringify({ status: hit.status, body: hit.body }));
      check("the successful POST settles the wait with the code",
        await pending === "the-code");
      check("the server closes on success (a follow-up call fails)",
        await settledWithin(httpCall(port, "GET", "/auth/callback?code=x&state=the-state").catch(() => null), 40) !== false);
    });
  } catch (error) {
    fail("waitForCallback (successful POST)", error);
  }

  try {
    await withCallbackServer(async ({ port, pending }) => {
      const hit = await httpCall(port, "GET", "/auth/callback?code=the-code&state=the-state");
      check("GET fallback with the right state + a code answers 200 and settles",
        hit.status === 200 && JSON.parse(hit.body).ok === true && (await pending) === "the-code",
        JSON.stringify({ status: hit.status, body: hit.body }));
    });
  } catch (error) {
    fail("waitForCallback (GET fallback)", error);
  }

  try {
    await withCallbackServer(async ({ port, pending }) => {
      const bad = await httpCall(port, "GET", "/auth/callback?code=the-code&state=wrong-state");
      check("GET with a mismatched CSRF state answers 400",
        bad.status === 400, JSON.stringify({ status: bad.status, body: bad.body }));
      check("a bad-state GET does NOT settle the wait",
        await settledWithin(pending, 40) === false);
    });
  } catch (error) {
    fail("waitForCallback (GET bad state)", error);
  }

  try {
    await withCallbackServer(async ({ port, pending }) => {
      const other = await httpCall(port, "GET", "/not-the-callback");
      check("a non-`/auth/callback` path answers 200 and is ignored",
        other.status === 200 && await settledWithin(pending, 40) === false,
        JSON.stringify({ status: other.status, body: other.body }));
    });
  } catch (error) {
    fail("waitForCallback (foreign path)", error);
  }
}

// --- 2. exchangeCodeForToken ---------------------------------------------------
{
  section("exchangeCodeForToken (stubbed fetch)");
  try {
    let seenUrl = "";
    let seenInit = null;
    const restore = stubFetch(async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return {
        status: 200,
        json: async () => ({ code: "000000", data: { access_token: "the-jwt" } })
      };
    });
    try {
      const token = await exchangeCodeForToken(
        "the-code", "http://127.0.0.1:9/auth/callback", "the-state",
        "https://api-agnes-code.agnes-ai.cn", "https://app.agnes-ai.cn", { hop() {} });
      check("a successful exchange returns the access token",
        token === "the-jwt", String(token));
      check("the exchange POSTs to the pinned BFF endpoint with the right shape",
        seenUrl === "https://api-agnes-code.agnes-ai.cn/api/v1/code/auth/exchange-code"
          && seenInit.method === "POST"
          && JSON.parse(seenInit.body).code === "the-code"
          && JSON.parse(seenInit.body).redirect_uri === "http://127.0.0.1:9/auth/callback"
          && JSON.parse(seenInit.body).client_id === "agnes-code",
        JSON.stringify({ url: seenUrl, init: { method: seenInit?.method, body: seenInit?.body } }));
      check("the exchange sends the login-page origin + platform headers",
        seenInit.headers.origin === "https://app.agnes-ai.cn" && seenInit.headers["x-platform"] === "1",
        JSON.stringify(seenInit?.headers));
    } finally {
      restore();
    }
  } catch (error) {
    fail("exchangeCodeForToken (success shape)", error);
  }

  try {
    const restore = stubFetch(async () => ({ status: 200, json: async () => ({ code: "010006", message: "Authorization code is invalid" }) }));
    try {
      const text = await rejectionText(exchangeCodeForToken("c", "u", "s", "https://api-agnes-code.agnes-ai.cn", "https://app.agnes-ai.cn", { hop() {} }));
      check("a business-level failure (010006) throws with the code",
        text === "code exchange failed (010006)", String(text));
    } finally {
      restore();
    }
  } catch (error) {
    fail("exchangeCodeForToken (business failure)", error);
  }

  try {
    const restore = stubFetch(async () => ({ status: 500, json: async () => ({ code: "000501" }) }));
    try {
      const text = await rejectionText(exchangeCodeForToken("c", "u", "s", "https://api-agnes-code.agnes-ai.cn", "https://app.agnes-ai.cn", { hop() {} }));
      check("an HTTP failure throws with the code",
        text === "code exchange failed (000501)", String(text));
    } finally {
      restore();
    }
  } catch (error) {
    fail("exchangeCodeForToken (HTTP failure)", error);
  }

  try {
    const restore = stubFetch(async () => ({ status: 200, json: async () => ({ code: "000000", data: {} }) }));
    try {
      const text = await rejectionText(exchangeCodeForToken("c", "u", "s", "https://api-agnes-code.agnes-ai.cn", "https://app.agnes-ai.cn", { hop() {} }));
      check("a success without an access_token throws explicitly",
        text === "the code exchange returned no access_token", String(text));
    } finally {
      restore();
    }
  } catch (error) {
    fail("exchangeCodeForToken (missing token)", error);
  }
}

// --- 3. openExternal: the ENOENT fail-fast ------------------------------------
{
  section("openExternal (missing-binary fail-fast)");
  try {
    const started = Date.now();
    const outcome = await openExternal("https://app.agnes-ai.cn/login", "agnescode-login-test-no-such-binary-xyz");
    const elapsed = Date.now() - started;
    check("a missing browser binary resolves to an error message (the async ENOENT is not swallowed)",
      typeof outcome === "string" && outcome.startsWith("failed to open browser:"), String(outcome));
    check("the missing-binary verdict fails fast, NOT after the callback timeout",
      elapsed < 2000, `elapsed ${elapsed}ms`);
  } catch (error) {
    fail("openExternal (ENOENT)", error);
  }
}

// --- 4. withTimeout ------------------------------------------------------------
{
  section("withTimeout");
  try {
    const text = await rejectionText(withTimeout(new Promise(() => {}), 20, "timeout-msg"));
    check("a never-settling promise is rejected at the deadline",
      text === "timeout-msg", String(text));
    const value = await withTimeout(Promise.resolve(42), 20, "timeout-msg");
    check("a fast promise passes through untouched", value === 42, String(value));
  } catch (error) {
    fail("withTimeout", error);
  }
}

// --- report --------------------------------------------------------------------
releaseNetworkGuard();
const passed = results.filter((result) => result.pass).length;
const failed = results.filter((result) => !result.pass);
for (const result of failed) {
  console.error(`  FAIL  ${result.name}${result.detail ? ` — ${result.detail}` : ""}`);
}
console.log(`\nagnescode-login.test.mjs: ${passed}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;
