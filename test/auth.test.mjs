/**
 * Offline checks for sensenova-auth.js.
 *
 * Every request in this file is served by a stub, and every key is generated
 * here: no account credential is used, and nothing leaves the machine. The
 * platform's own JWKS is a separate, explicitly-invoked check — see
 * `test/live-jwks.test.mjs` and `npm run test:live` — so that "the suite is
 * offline" stays a property you can rely on rather than a claim.
 */
import { readJwtClaims, readJwtExpiry, createAuth } from "../sensenova-auth.js";
import { sealPassword } from "../sensenova-crypto.js";
import { installNetworkGuard } from "./peer-roots.mjs";
import {
  AUTH_FAILURE_CODES, CODE, CREDENTIAL_REFUSALS,
  IAM_REASON_CODES, isAuthFailure, isCredentialRefusal
} from "../codes.js";

/** Installed before anything runs, so an unstubbed call cannot escape. */
const releaseNetworkGuard = installNetworkGuard();

// The crypto primitives moved to sensenova-crypto.js, so the seal checks pull
// them from there and hand in the endpoint/key the stub answers on.
const TEST_JWKS_ENDPOINT = "https://signin.sensecore.cn/.well-known/jwks.json";
const TEST_ENC_KEY_ID = "public:hydra.openid.id-token";
const sealOptions = { jwksEndpoint: TEST_JWKS_ENDPOINT, encKeyId: TEST_ENC_KEY_ID };

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

/** Decrypt a compact JWE, verifying the AAD binding, to prove well-formedness. */
async function decryptJwe(jwe, privateJwk) {
  // RFC 7516 §3: compact serialization is FIVE segments, the GCM tag detached.
  const segments = jwe.split(".");
  if (segments.length !== 5) throw new Error(`expected 5 compact segments, got ${segments.length}`);
  const [header, encryptedKey, iv, ciphertext, tag] = segments;
  const protectedJson = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
  if (protectedJson.alg !== "RSA-OAEP" || protectedJson.enc !== "A256GCM") {
    throw new Error(`unexpected header: ${JSON.stringify(protectedJson)}`);
  }
  const key = await crypto.subtle.importKey(
    "jwk", privateJwk, { name: "RSA-OAEP", hash: "SHA-1" }, false, ["decrypt"]
  );
  const cek = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, key, Buffer.from(encryptedKey, "base64url"));
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Buffer.from(iv, "base64url"),
      additionalData: new TextEncoder().encode(header),
      tagLength: 128
    },
    await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]),
    // Rejoin ciphertext and the detached tag: WebCrypto decrypts both at once.
    Buffer.concat([Buffer.from(ciphertext, "base64url"), Buffer.from(tag, "base64url")])
  );
  return new TextDecoder().decode(plain);
}

/** A throwaway RSA public key for stubbed JWKS responses. */
async function stubKey() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" },
    true, ["encrypt", "decrypt"]
  );
  return {
    pair,
    jwk: await crypto.subtle.exportKey("jwk", pair.publicKey)
  };
}

// --- 1. compact JWE shape, against a locally generated key ----------------
// The structural claims (4 segments, the algorithm pair, a 12-byte IV, a
// 16-byte GCM tag, a modulus-width key wrap rather than a password-sized
// blob) hold for any conforming key, so they are asserted offline. The
// platform's actual key is checked separately by `npm run test:live`, which
// must never be part of a default run.
{
  const { jwk } = await stubKey();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("jwks.json")) {
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "public:hydra.openid.id-token", use: "sig" }] }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
    return realFetch(url, init);
  };
  try {
    const mod = await import(`../sensenova-crypto.js?shape=${Date.now()}`);
    const sealed = await mod.sealPassword("structural-probe", sealOptions);
    const seg = sealed.split(".");
    // RFC 7516 §3: five segments — header.encryptedKey.iv.ciphertext.tag.
    check("seal has 5 compact segments", seg.length === 5, `got ${seg.length}`);
    check("seal header decodes", (() => {
      try {
        const h = JSON.parse(Buffer.from(seg[0], "base64url").toString("utf8"));
        return h.alg === "RSA-OAEP" && h.enc === "A256GCM";
      } catch {
        return false;
      }
    })(), seg[0]?.slice(0, 40) ?? "");
    // The stub key is 2048-bit, so the wrapped CEK is 256 bytes; the point is
    // that the segment carries a modulus-width wrap, not a password-sized blob.
    const ek = Buffer.from(seg[1], "base64url").length;
    check("encrypted key wraps the CEK at modulus width", ek === 256, String(ek));
    check("encrypted key is not the password", ek > "structural-probe".length);
    check("iv is 12 bytes", Buffer.from(seg[2], "base64url").length === 12);
    check("ciphertext is exactly the plaintext length",
      Buffer.from(seg[3], "base64url").length === "structural-probe".length);
    check("tag is detached and 16 bytes",
      Buffer.from(seg[4], "base64url").length === 16);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 2. round-trip with a known private key ------------------------------
{
  const { jwk, pair } = await stubKey();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("jwks.json")) {
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "public:hydra.openid.id-token", use: "sig" }] }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
    return realFetch(url, init);
  };
  try {
    const module = await import(`../sensenova-crypto.js?probe=${Date.now()}`);
    const sealed = await module.sealPassword("correct horse battery staple", sealOptions);
    const plain = await decryptJwe(sealed, await crypto.subtle.exportKey("jwk", pair.privateKey));
    check("JWE round-trips to the original password", plain === "correct horse battery staple", plain.slice(0, 12));
    const again = await module.sealPassword("correct horse battery staple", sealOptions);
    check("each seal uses a fresh CEK/IV", sealed !== again);
  } catch (error) {
    fail("JWE round-trips to the original password", error);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 3. JWT claim reading (pure) ------------------------------------------
const payload = Buffer.from(
  JSON.stringify({ exp: 1790518985, scp: "openid offline offline_access" })
).toString("base64url");
const token = `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`;
check("reads exp claim", readJwtClaims(token).exp === 1790518985);
check("reads scp claim", readJwtClaims(token).scp === "openid offline offline_access");
check("expiry converts to epoch millis", readJwtExpiry(token) === 1790518985 * 1000);
check("garbage token yields no claims", Object.keys(readJwtClaims("not-a-jwt")).length === 0);
check("empty token yields null expiry", readJwtExpiry("") === null);

// --- 4. PKCE regression: digest is async ---------------------------------
// `subtle.digest` returns a Promise. Encoding that Promise as if it were
// bytes throws ERR_INVALID_ARG_TYPE, and it only surfaces on the real login
// path — so assert both the correct value and the shape of the trap.
{
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const expected = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  ).toString("base64url");
  // RFC 7636 appendix B test vector.
  check("S256 matches the RFC 7636 vector", expected === "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", expected);
  check("a digest Promise is not encodable as bytes", (() => {
    try {
      Buffer.from(crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
      return false;
    } catch {
      return true;
    }
  })());
}

// --- 5. the login path runs end to end against a stubbed platform --------
// This is the regression guard for the Promise bug: login() must reach its
// first network call instead of throwing a TypeError.
{
  const { jwk } = await stubKey();
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    seen.push(target);
    if (target.includes("jwks.json")) {
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "public:hydra.openid.id-token", use: "sig" }] }), {
        status: 200, headers: { "content-type": "application/json" }
      });
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
      // The real envelope: a generic top-level message with the actual cause
      // in details[].reason, exactly as IAM sends it.
      return new Response(JSON.stringify({
        code: 3, message: "InvalidArgument",
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "invalidAccountOrPassword", domain: "iam" },
          { "@type": "type.googleapis.com/google.rpc.LocalizedMessage", locale: "en", message: "invalid account or password" },
          { "@type": "type.googleapis.com/sensetime.core.higgs.error_detail.v1.LogInfo", log_id: "01a0", track_id: "5f08", level: "UNSPECIFIED" }
        ]
      }), {
        status: 400, headers: { "content-type": "application/json" }
      });
    }
    return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
  };
  try {
    const mod = await import(`../sensenova-auth.js?login=${Date.now()}`);
    let code = null;
    let message = "";
    try {
      await mod.createAuth().login({ username: "u", password: "p" });
    } catch (error) {
      code = error?.code ?? error?.name ?? "unknown";
      message = String(error?.message ?? "");
    }
    check("login reaches the authorization endpoint", seen.some((u) => u.includes("/oauth2/auth")),
      seen.slice(0, 3).join(" | ").slice(0, 120));
    check("login does not fail on a type error", code !== "TypeError", String(code));
    // A wrong password must be distinguishable from every other refusal.
    check("a wrong password classifies as login_rejected", code === "login_rejected", String(code));
    check("the platform's specific message is used, not the generic status",
      message.includes("invalid account or password"), message);
    check("the generic status string is not what the user is shown",
      !message.includes("InvalidArgument"), message);
    check("log and track ids do not leak into the message",
      !message.includes("01a0") && !message.includes("5f08"), message);
  } catch (error) {
    fail("login reaches the authorization endpoint", error);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 5a. the generated PKCE verifier must actually be redeemable ---------
// A verifier that is too short is refused by the token endpoint with an
// `invalid_grant` whose hint names the length and nothing about the code that
// produced it — which is how an 11-character verifier shipped: every other
// test passed, and the only symptom was an opaque refusal on a login whose
// username and password were correct. Asserted at the point of creation,
// because that is the only place the cause is still legible.
{
  const { jwk } = await stubKey();
  const realFetch = globalThis.fetch;
  let authorizeUrl = "";
  let tokenBody = "";
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes("jwks.json")) {
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "public:hydra.openid.id-token", use: "sig" }] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("/oauth2/auth")) {
      authorizeUrl = target;
      return new Response("", {
        status: 302,
        headers: { location: "https://platform.sensenova.cn/login?login_challenge=chal-1", "set-cookie": "a=b; Path=/" }
      });
    }
    if (target.includes("iam.sensecoreapi.cn")) {
      return new Response(JSON.stringify({ redirect: "https://platform.sensenova.cn/?code=code-1&state=s" }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("/oauth2/token")) {
      tokenBody = String(init.body ?? "");
      return new Response(JSON.stringify({ access_token: "a.b.c", refresh_token: "r", expires_in: 10800 }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
  };
  try {
    const mod = await import(`../sensenova-auth.js?pkce=${Date.now()}`);
    await mod.createAuth().login({ username: "u", password: "p" });
    const sent = new URLSearchParams(tokenBody);
    const verifier = sent.get("code_verifier") ?? "";
    check("a code_verifier is sent to the token endpoint", verifier !== "", `body=${tokenBody.slice(0, 160)}`);
    // RFC 7636 §4.1: 43 to 128 characters. This is the assertion the bug
    // missed — the old verifier was 11.
    check("the verifier is at least 43 characters", verifier.length >= 43, `length=${verifier.length}`);
    check("the verifier is at most 128 characters", verifier.length <= 128, `length=${verifier.length}`);
    check("the verifier uses only unreserved characters", /^[A-Za-z0-9\-._~]+$/.test(verifier), verifier);
    const challenge = new URL(authorizeUrl).searchParams.get("code_challenge") ?? "";
    const expected = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
      .toString("base64url");
    check("the verifier hashes to the challenge that was sent (S256)", challenge === expected,
      `challenge=${challenge} expected=${expected}`);
    check("the challenge method is S256",
      new URL(authorizeUrl).searchParams.get("code_challenge_method") === "S256");
  } catch (error) {
    fail("the generated PKCE verifier is redeemable", error);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 5b. other refusals are NOT reported as a wrong password -------------
// Every IAM failure used to collapse into one message, so a locked account or
// a rate limit told the user to retype a password that was fine.
{
  const { jwk } = await stubKey();
  const refusals = [
    ["a locked account", { reason: "accountLocked" }, "account_locked"],
    ["a rate limit", { reason: "tooManyAttempts" }, "rate_limited"],
    ["a required captcha", { reason: "captchaRequired" }, "verification_required"]
  ];  for (const [label, detail, expected] of refusals) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes("jwks.json")) {
        return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "public:hydra.openid.id-token", use: "sig" }] }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target.includes("/oauth2/auth")) {
        return new Response("", {
          status: 302,
          headers: {
            location: "https://platform.sensenova.cn/login?login_challenge=chal",
            "set-cookie": "oauth2_authentication_csrf=abc; Path=/"
          }
        });
      }
      if (target.includes("iam.sensecoreapi.cn")) {
        return new Response(JSON.stringify({ code: 9, message: "FailedPrecondition", details: [detail] }), {
          status: 400, headers: { "content-type": "application/json" }
        });
      }
      return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    };
    try {
      const mod = await import(`../sensenova-auth.js?refusal=${Date.now()}`);
      let code = null;
      try { await mod.createAuth().login({ username: "u", password: "p" }); } catch (error) { code = error?.code; }
      check(`${label} is not reported as a wrong password`, code === expected, String(code));
    } catch (error) {
      fail(`${label} is classified`, error);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
}

// --- 5c. the platform's wait is read in either language ------------------
// A window that goes unread is a refusal with no stated deadline, which falls
// back to a local backoff and so re-probes a lock that is still in force. The
// platform serves its message in the caller's language, so both must parse.
{
  const { jwk } = await stubKey();
  const windows = [
    ["8 minutes, English", "The account has been locked, please try again after 8 minutes", 8 * 60_000],
    ["2 hours, English", "The account has been locked, please try again after 2 hours", 2 * 3_600_000],
    ["45 seconds, English", "Too many attempts, please try again after 45 seconds", 45_000],
    ["8 分钟, Chinese", "账号已被锁定，请 8 分钟后重试", 8 * 60_000],
    ["2 小时, Chinese", "账号已被锁定，请 2 小时后重试", 2 * 3_600_000],
    ["30 秒, Chinese", "尝试过于频繁，请 30 秒后重试", 30_000],
    ["a bare 分 reads as minutes", "请 5 分后重试", 5 * 60_000]
  ];
  for (const [label, message, expected] of windows) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes("jwks.json")) {
        return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "public:hydra.openid.id-token", use: "sig" }] }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target.includes("/oauth2/auth")) {
        return new Response("", {
          status: 302,
          headers: {
            location: "https://platform.sensenova.cn/login?login_challenge=chal",
            "set-cookie": "oauth2_authentication_csrf=abc; Path=/"
          }
        });
      }
      if (target.includes("iam.sensecoreapi.cn")) {
        return new Response(JSON.stringify({
          code: 9, message,
          details: [{ reason: "accountLocked" }]
        }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    };
    try {
      const mod = await import(`../sensenova-auth.js?window=${Date.now()}-${Math.random()}`);
      let retryAfterMs;
      try { await mod.createAuth().login({ username: "u", password: "p" }); } catch (error) { retryAfterMs = error?.retryAfterMs; }
      check(`${label} yields its wait`, retryAfterMs === expected, String(retryAfterMs));
    } catch (error) {
      fail(`${label} yields its wait`, error);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // A Retry-After header is the authoritative form and needs no prose.
  {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes("jwks.json")) {
        return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "public:hydra.openid.id-token", use: "sig" }] }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target.includes("/oauth2/auth")) {
        return new Response("", {
          status: 302,
          headers: {
            location: "https://platform.sensenova.cn/login?login_challenge=chal",
            "set-cookie": "oauth2_authentication_csrf=abc; Path=/"
          }
        });
      }
      if (target.includes("iam.sensecoreapi.cn")) {
        return new Response(JSON.stringify({ code: 9, message: "TooManyRequests", details: [{ reason: "tooManyAttempts" }] }), {
          status: 429, headers: { "content-type": "application/json", "retry-after": "600" }
        });
      }
      return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    };
    try {
      const mod = await import(`../sensenova-auth.js?header=${Date.now()}-${Math.random()}`);
      let retryAfterMs;
      try { await mod.createAuth().login({ username: "u", password: "p" }); } catch (error) { retryAfterMs = error?.retryAfterMs; }
      check("a Retry-After header is read as seconds", retryAfterMs === 600_000, String(retryAfterMs));
    } catch (error) {
      fail("a Retry-After header is read as seconds", error);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
}

// --- 6. login refuses empty credentials without any network --------------
{
  const realFetch = globalThis.fetch;
  let touched = 0;
  globalThis.fetch = async () => { touched += 1; return new Response("{}", { status: 500 }); };
  try {
    let code = null;
    try { await createAuth().login({ username: "", password: "p" }); } catch (error) { code = error?.code; }
    check("empty credentials are refused", code === "missing_credentials", String(code));
    // Emptiness is judged on the trimmed form, so a password that is nothing
    // but spaces was not filled in — yet a password that merely *has* a space
    // is a different password and must survive.
    let blank = null;
    try { await createAuth().login({ username: "u", password: "   " }); } catch (error) { blank = error?.code; }
    check("a whitespace-only password was not filled in", blank === "missing_credentials", String(blank));
    check("no request is made for empty credentials", touched === 0, `requests=${touched}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 7. refresh without a token refuses locally --------------------------
{
  const realFetch = globalThis.fetch;
  let touched = 0;
  globalThis.fetch = async () => { touched += 1; return new Response("{}", { status: 500 }); };
  try {
    let code = null;
    try { await createAuth().refresh(""); } catch (error) { code = error?.code; }
    check("an absent refresh token is refused", code === "no_refresh_token", String(code));
    check("no token request is made", touched === 0, `requests=${touched}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 7b. a SUCCESSFUL login also reports its trace ----------------------
// Only failures used to reach `onTrace`, so a working walk was never written
// down — and diffing a working attempt against a failing one is the entire
// reason the trace exists. A success throws nothing to carry it on.
{
  const { jwk } = await stubKey();
  for (const [label, ok] of [["a success", true], ["a failure", false]]) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes("jwks.json")) {
        return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "public:hydra.openid.id-token", use: "sig" }] }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target.includes("/oauth2/auth")) {
        return new Response("", {
          status: 302,
          headers: {
            location: "https://platform.sensenova.cn/login?login_challenge=chal",
            "set-cookie": "oauth2_authentication_csrf=abc; Path=/"
          }
        });
      }
      if (target.includes("iam.sensecoreapi.cn")) {
        return ok
          ? new Response(JSON.stringify({ redirect: "https://platform.sensenova.cn/cb?code=the-code" }),
            { status: 200, headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify({
              code: 3, message: "InvalidArgument",
              details: [{ reason: "invalidAccountOrPassword" }]
            }), { status: 400, headers: { "content-type": "application/json" } });
      }
      if (target.includes("oauth2/token")) {
        return new Response(
          JSON.stringify({ access_token: "granted-token", refresh_token: "granted-refresh", expires_in: 10800 }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    };
    try {
      const mod = await import(`../sensenova-auth.js?trace-${label}=${Date.now()}-${Math.random()}`);
      const reported = [];
      let granted = null;
      let thrown = null;
      try {
        granted = await mod.createAuth().login({ username: "u", password: "p" },
          { onTrace: (hops, error) => reported.push({ hops, error }) });
      } catch (error) {
        thrown = error;
      }
      check(`${label} reports exactly one trace`, reported.length === 1, `traces=${reported.length}`);
      const first = reported[0] ?? {};
      check(`${label} reports the hops it walked`, Array.isArray(first.hops) && first.hops.length > 0,
        String(first.hops?.length));
      if (ok) {
        check("a success is reported with no error", first.error === null, String(first.error));
        check("a success still returns the grant", granted?.accessToken === "granted-token",
          String(granted?.accessToken));
        // IAM answers the form post with a `redirect` whose query carries the
        // authorization code. Scrubbing by KEY name misses it entirely, so this
        // is the assertion that fails if sanitizing ever goes back to names.
        const serialized = JSON.stringify(first.hops ?? []);
        check("a success trace does not carry the authorization code",
          !serialized.includes("the-code"), serialized.slice(0, 200));
      } else {
        check("a failure is reported with the error that was thrown", first.error === thrown);
        check("a failure still carries hops on the error",
          Array.isArray(thrown?.trace) && thrown.trace.length > 0, String(thrown?.trace?.length));
      }
    } catch (error) {
      fail(`${label} reports its trace`, error);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
}

// --- 7c. one taxonomy, three consumers ----------------------------------
// The auth half PRODUCES these codes, the store decides whether to park them,
// and the Host decides whether they are an auth failure. A code missing from
// the third list is reported to the user as a console failure — which is how
// a locked account came to be described as one.
{
  const declared = new Set(Object.values(CODE));
  const platformCodes = Object.values(IAM_REASON_CODES);
  check("every platform reason maps to a declared code",
    platformCodes.every((code) => declared.has(code)), platformCodes.join(", "));
  check("every platform reason counts as an auth failure",
    platformCodes.every((code) => AUTH_FAILURE_CODES.has(code)),
    platformCodes.filter((code) => !AUTH_FAILURE_CODES.has(code)).join(", "));
  check("a parked refusal is also an auth failure",
    [...CREDENTIAL_REFUSALS].every((code) => AUTH_FAILURE_CODES.has(code)));
  check("a lockout is an auth failure", isAuthFailure({ code: CODE.ACCOUNT_LOCKED }) === true);
  check("a rate limit is an auth failure", isAuthFailure({ code: CODE.RATE_LIMITED }) === true);
  check("a captcha is an auth failure", isAuthFailure({ code: CODE.VERIFICATION_REQUIRED }) === true);
  check("an unclassified refusal is an auth failure", isAuthFailure({ code: CODE.LOGIN_FAILED }) === true);
  check("a console failure is NOT an auth failure", isAuthFailure({ code: CODE.CONSOLE_ERROR }) === false);
  check("an error with no code is not an auth failure", isAuthFailure(new Error("boom")) === false);
  check("a wrong password is parked", isCredentialRefusal(CODE.LOGIN_REJECTED) === true);
  check("a lockout is waited out, not parked", isCredentialRefusal(CODE.ACCOUNT_LOCKED) === false);
  check("no account is never parked", isCredentialRefusal(CODE.NOT_CONFIGURED) === false);
}

// --- 7d. a body that is not JSON is scrubbed by VALUE too ----------------
// An HTML form or a bare redirect header puts `code=` and `login_challenge=`
// in plain text, where there is no key to match on at all.
{
  const { jwk } = await stubKey();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("jwks.json")) {
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "public:hydra.openid.id-token", use: "sig" }] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("/oauth2/auth")) {
      return new Response("", {
        status: 302,
        headers: {
          location: "https://platform.sensenova.cn/login?login_challenge=chal",
          "set-cookie": "oauth2_authentication_csrf=abc; Path=/"
        }
      });
    }
    if (target.includes("iam.sensecoreapi.cn")) {
      // Deliberately not JSON: the branch that has to catch secrets by shape.
      return new Response("see https://platform.sensenova.cn/cb?code=the-code&login_challenge=chal",
        { status: 500, headers: { "content-type": "text/plain" } });
    }
    return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
  };
  try {
    const mod = await import(`../sensenova-auth.js?scrub=${Date.now()}-${Math.random()}`);
    const reported = [];
    try {
      await mod.createAuth().login({ username: "u", password: "p" },
        { onTrace: (hops, error) => reported.push({ hops, error }) });
    } catch {
      // The refusal is the point; what matters is what got written down.
    }
    const serialized = JSON.stringify(reported[0]?.hops ?? []);
    check("a plain-text body loses the authorization code",
      !serialized.includes("the-code"), serialized.slice(0, 240));
    check("a plain-text body loses the login challenge",
      !serialized.includes("=chal"), serialized.slice(0, 240));
  } catch (error) {
    fail("a plain-text body is scrubbed by value", error);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 8. the whole suite stayed offline -----------------------------------
// The point of the guard: a check that forgets its stub fails HERE, loudly,
// instead of reaching the platform and — for a login-shaped call — counting
// as a real attempt against someone's account.
const unstubbed = releaseNetworkGuard();
check("no check escaped its stub to the network", unstubbed.length === 0, unstubbed.join(", "));

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
