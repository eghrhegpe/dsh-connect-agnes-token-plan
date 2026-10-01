/**
 * Agnes console sign-in — the credential exchange this plugin's whole quota
 * half rests on.
 *
 * Agnes exposes no OIDC discovery document and no refresh token. Its console
 * authenticates with a plain email + password POST and answers with a single
 * `access_token`:
 *
 *   POST {consoleOrigin}/api/user/login   {"username": <email>, "password": <pw>}
 *   -> 200 {"code": 200, "message": "ok", "data": {"access_token": "...", "user": {...}}}
 *   -> 401 {"code": 401, "message": "Invalid username or password", "data": null}
 *
 * Two consequences shape this module:
 *
 * 1. **There is no refresh path.** `refresh()` therefore always throws
 *    `NO_REFRESH_TOKEN`, which is exactly the signal `token-store/acquire.ts`
 *    already uses to fall through to a fresh password login. So the store needs
 *    no change to accommodate Agnes — the missing refresh token IS the contract.
 * 2. **The password travels as plain JSON** over TLS. Agnes ships no JWKS and
 *    no sealed-password endpoint (the SenseNova JWE walk has no counterpart
 *    here), so there is nothing to wrap it with. That makes the transport the
 *    only protection, and makes "never persist it" load-bearing rather than
 *    merely tidy — see `token-store/account.ts`, where only the USERNAME is
 *    ever written to the credentials service.
 *
 * Verified against the live console on 2026-10-01: the endpoint exists, needs
 * no captcha, and answers `Invalid username or password` to a bad pair. The
 * access token it returns is the same value the browser keeps in
 * `localStorage.token` and sends as `Authorization: Bearer <token>` to
 * `platform-backend.agnes-ai.cn/api/usage/*`.
 *
 * @module dsh-connect-agnes-token-plan/agnes-auth
 */

import { CODE } from "./codes.ts";
import { str, obj, num, pluginError } from "./util.ts";

/**
 * Shipped defaults for the login flow.
 *
 * `consoleOrigin` is the BACKEND host, not the console front-end: the front-end
 * origin (`platform.agnes-ai.cn`) serves `/api/*` as a Next.js 404 shell, so a
 * login aimed there fails in a way that looks like a wrong path rather than a
 * wrong host. Getting this wrong is the single easiest mistake to make here.
 */
export const AUTH_DEFAULTS = Object.freeze({
  consoleOrigin: "https://platform-backend.agnes-ai.cn",
  loginPath: "/api/user/login",
  requestTimeoutMs: 15_000,
  /**
   * Lifetime assumed when the access token is not a readable JWT.
   *
   * Deliberately LONG, and the direction matters. A token that dies early is
   * self-correcting: the console answers 401, `fetchConsole` invalidates it and
   * the store re-logs in exactly once. A token assumed dead while still alive
   * is NOT self-correcting — it spends a real sign-in on every poll, and Agnes
   * locks an account after a few bad attempts, so guessing short converts a
   * cosmetic inaccuracy into a lockout. When in doubt, err long.
   */
  fallbackExpiresInSeconds: 604_800
});

/** RFC 7519 `exp`, in epoch MILLIS, or `null` when the token carries none. */
export function readJwtExpiry(token: string) {
  const parts = str(token, "").split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    const exp = Number(obj(claims).exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Partial mask for a sign-in identity, so a trace names the account without
 * writing it down in full.
 * @param {string} username - the submitted email.
 * @returns {string} e.g. `ab***@example.com`, or `""`.
 */
function maskUsername(username: string) {
  const value = str(username, "");
  const at = value.indexOf("@");
  if (at <= 0) return value === "" ? "" : `${value.slice(0, 1)}***`;
  return `${value.slice(0, Math.min(2, at))}***${value.slice(at)}`;
}

/**
 * Map Agnes's own refusal onto this plugin's shared taxonomy.
 *
 * The classification decides how the panel reacts, and the two outcomes are
 * genuinely different: a credential refusal is PARKED (waiting cannot fix a
 * wrong password, and retrying burns an attempt toward a lockout), while a
 * rate-limit or a platform fault waits out a backoff. So a refusal that names
 * the credential must not be folded into the generic failure — that is the
 * difference between asking the user to retype and silently retrying forever.
 * @param {number} status - the HTTP status.
 * @param {string} message - the platform's own message, if any.
 * @returns {string} a {@link CODE} value.
 */
export function classifyLoginFailure(status: number, message: string) {
  const text = str(message, "").toLowerCase();
  // A named credential refusal wins over the status: Agnes answers 401 for a
  // bad password, but a 400 carrying "invalid username or password" means the
  // same thing and must not be parked any differently.
  if (/invalid username or password|incorrect|wrong password|invalid credential/.test(text)) {
    return CODE.LOGIN_REJECTED;
  }
  if (/lock|disabled|suspend|banned/.test(text)) return CODE.ACCOUNT_LOCKED;
  if (/rate limit|too many|frequent/.test(text)) return CODE.RATE_LIMITED;
  if (/captcha|verification|verify/.test(text)) return CODE.VERIFICATION_REQUIRED;
  if (status === 401 || status === 403) return CODE.LOGIN_REJECTED;
  if (status === 429) return CODE.RATE_LIMITED;
  return CODE.LOGIN_FAILED;
}

/**
 * Resolve the operator's login-flow overrides onto the shipped defaults.
 *
 * `consoleOrigin` is the one field that must be present and well-formed: it is
 * where the password is posted, so a typo here does not merely break the panel,
 * it sends a real credential to a host the operator did not choose. An empty or
 * unparseable origin therefore throws rather than falling back.
 * @param {object} [overrides] - `settings.auth` from the row.
 * @returns {object} the resolved config.
 * @throws {Error} when the origin is missing or not a URL.
 */
export function resolveAuthConfig(overrides = {}) {
  const source = obj(overrides);
  const consoleOrigin = str(source.consoleOrigin, AUTH_DEFAULTS.consoleOrigin).replace(/\/+$/, "");
  if (consoleOrigin === "") {
    throw new Error("agnes auth: consoleOrigin is required (the password is posted to it)");
  }
  try {
    new URL(consoleOrigin);
  } catch {
    throw new Error(`agnes auth: consoleOrigin is not a URL: ${consoleOrigin}`);
  }
  return {
    consoleOrigin,
    loginPath: str(source.loginPath, AUTH_DEFAULTS.loginPath),
    requestTimeoutMs: num(source.requestTimeoutMs, AUTH_DEFAULTS.requestTimeoutMs),
    fallbackExpiresInSeconds: num(source.fallbackExpiresInSeconds, AUTH_DEFAULTS.fallbackExpiresInSeconds)
  };
}

/**
 * A duration written in words, mapped to milliseconds.
 *
 * Deliberately no bare `m`: "m" is minutes in some phrasings and months in
 * others, and a lock read as 30 MONTHS instead of 30 minutes would park the
 * panel for a year. Units are matched long-form only, plus the unambiguous
 * Chinese ones.
 */
const STATED_DURATION = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|秒|分钟|小时|天)/i;
const UNIT_MS = Object.freeze({
  second: 1000, sec: 1000, seconds: 1000, secs: 1000,
  minute: 60_000, min: 60_000, minutes: 60_000, mins: 60_000,
  hour: 3_600_000, hr: 3_600_000, hours: 3_600_000, hrs: 3_600_000,
  day: 86_400_000, days: 86_400_000,
  秒: 1000, 分钟: 60_000, 小时: 3_600_000, 天: 86_400_000
});

/**
 * The wait the platform stated, in milliseconds, or `null` when it stated none.
 *
 * Two sources, because a gateway may state a window either way:
 *
 * 1. the standard `Retry-After` header — delta-seconds, or an HTTP date;
 * 2. a duration written into the message itself ("try again in 2 hours").
 *
 * This matters because the store's throttle PREFERS a platform-stated window
 * over the backoff it invents, and deliberately does not cap it: truncating a
 * stated lock walks straight back into it. Guessing a window that was never
 * stated is the opposite failure — it would make the panel wait out a timer the
 * platform never imposed — so an unstated window stays `null` and the store
 * falls back to its own doubling backoff.
 *
 * @param {{headers?: {get?: (name: string) => string|null}}} response - the fetch response.
 * @param {string} message - the platform's own message.
 * @param {number} [nowMs] - clock source, for an HTTP-date header.
 * @returns {number|null} milliseconds to wait, or null.
 */
export function parseRetryAfterMs(response: { headers?: { get?: (name: string) => string | null } }, message: string, nowMs: number = Date.now()) {
  const header = response?.headers?.get?.("retry-after");
  if (typeof header === "string" && header.trim() !== "") {
    const trimmed = header.trim();
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
    const at = Date.parse(trimmed);
    if (Number.isFinite(at)) {
      const delta = at - nowMs;
      if (delta > 0) return delta;
    }
  }
  const stated = STATED_DURATION.exec(str(message, ""));
  if (stated !== null) {
    const amount = Number(stated[1]);
    const unitRaw = stated[2]!;
    const unit = (UNIT_MS as Record<string, number>)[unitRaw.toLowerCase()] ?? (UNIT_MS as Record<string, number>)[unitRaw];
    if (Number.isFinite(amount) && amount > 0 && unit !== undefined) return Math.round(amount * unit);
  }
  return null;
}

/**
 * Build the auth instance `token-store` consumes.
 *
 * The shape is deliberately the one `token-store/account.ts` and
 * `token-store/renewal.ts` already call — `login(credentials, options)` and
 * `refresh(refreshToken)` — so swapping this in for the OIDC module changes no
 * call site in the store.
 * @param {object} [overrides] - `settings.auth` from the row.
 * @returns {{config: object, login: Function, refresh: Function}}
 */
export function createAuth(overrides = {}) {
  const config = resolveAuthConfig(overrides);
  return {
    config,
    login(credentials: { username?: string; password?: string }, options?: { onTrace?: (trace: unknown, error: unknown) => void }) {
      return loginWith(config, credentials, options);
    },
    /**
     * Agnes issues no refresh token, so there is nothing to renew with.
     *
     * Throwing the store's own `NO_REFRESH_TOKEN` code is the intended
     * behaviour, not a stub: `token-store/acquire.ts` catches exactly this code and falls
     * through to a password login, which is the only renewal path Agnes has.
     */
    async refresh() {
      throw pluginError(CODE.NO_REFRESH_TOKEN, "Agnes issues no refresh token; sign in again instead");
    }
  };
}

/**
 * Sign in with an email and password, returning a usable access token.
 *
 * The password is used only inside this call. It is never copied into the
 * returned value, the trace, or any error message — a sign-in trace is written
 * to disk on EVERY attempt (success included), so anything that reaches the
 * trace is effectively published.
 * @param {object} cfg - a {@link resolveAuthConfig} result.
 * @param {{username: string, password: string}} credentials - the account.
 * @param {{onTrace?: (trace: unknown, error: unknown) => void}} [options]
 *   `onTrace` is called once when the attempt ENDS, success or failure.
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number}>}
 *   `refreshToken` is always `""` — Agnes has none, and the empty string is what
 *   makes the store skip renewal and re-login instead.
 * @throws {Error & {code?: string}} a {@link CODE} tagged failure.
 */
export async function loginWith(
  cfg: any,
  credentials: { username?: string; password?: string } | undefined,
  options: { onTrace?: (trace: unknown, error: unknown) => void } = {}
) {
  const username = str(credentials?.username, "");
  const password = typeof credentials?.password === "string" ? credentials.password : "";
  const hops: unknown[] = [];
  const trace = {
    hop(entry: unknown) {
      hops.push(entry);
    },
    done() {
      return hops;
    }
  };
  const finish = (error: { trace?: unknown } | undefined | null) => {
    try {
      // The sanitized hop record rides on the thrown error so the route layer
      // can persist it under its own filename and hand the panel a pointer
      // (the same contract the OIDC module kept: `error.trace`).
      if (error !== undefined && error !== null) {
        try {
          error.trace = hops;
        } catch {
          /* a frozen error still logs through onTrace */
        }
      }
      options.onTrace?.(trace.done(), error);
    } catch {
      /* logging never breaks the login */
    }
  };

  if (username === "" || password.trim() === "") {
    const error = pluginError(CODE.MISSING_CREDENTIALS, "an email and a password are both required");
    finish(error);
    throw error;
  }

  const url = `${cfg.consoleOrigin}${cfg.loginPath}`;
  trace.hop({ step: "login", method: "POST", url, account: maskUsername(username) });

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        // The console's own front-end sends this; a request without it is not
        // known to be rejected, but matching the browser costs nothing.
        "x-user-language": "zh-CN"
      },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(cfg.requestTimeoutMs)
    });
  } catch (cause) {
    // A transport failure is not a refusal: nothing was judged, so the panel
    // must offer a retry rather than an account form.
    const detail = cause instanceof Error ? cause.message : String(cause);
    trace.hop({ step: "login-transport-error", detail });
    const error = pluginError(CODE.LOGIN_FAILED, `could not reach the Agnes console: ${detail}`);
    finish(error);
    throw error;
  }

  const text = await response.text().catch(() => "");
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* a non-JSON body (an HTML error page) is reported below, not thrown here */
  }
  const message = str(obj(body).message, "");

  if (!response.ok || Number(obj(body).code) !== 200) {
    const code = classifyLoginFailure(response.status, message);
    // The wait the platform stated, if it stated one. The store's throttle
    // reads this off the error and honours it verbatim instead of its own
    // doubling backoff — a stated lock must not be truncated.
    const retryAfterMs = parseRetryAfterMs(response, message);
    trace.hop({
      step: "login-refused",
      status: response.status,
      code,
      retryAfterMs,
      // The platform's own words, which carry no credential. Truncated so a
      // pathological body cannot bloat the trace.
      message: message.slice(0, 200)
    });
    const error = pluginError(
      code,
      message !== "" ? message : `Agnes console returned HTTP ${response.status}`
    );
    if (retryAfterMs !== null) error.retryAfterMs = retryAfterMs;
    finish(error);
    throw error;
  }

  const accessToken = str(obj(obj(body).data).access_token, "");
  if (accessToken === "") {
    // A 200 with no token is a contract break, not a refusal: say so plainly
    // instead of letting an empty Bearer header reach the console.
    trace.hop({ step: "login-contract-break", status: response.status });
    const error = pluginError(CODE.LOGIN_FAILED, "the console answered 200 without an access_token");
    finish(error);
    throw error;
  }

  // Prefer the token's own `exp`; fall back to the long default (see
  // `fallbackExpiresInSeconds` for why the default errs long). Either way the
  // stored grant re-reads the claim, so this number only decides when we
  // PROACTIVELY re-login — a stale one still heals through the 401 path.
  const jwtExpiry = readJwtExpiry(accessToken);
  const expiresIn = jwtExpiry === null
    ? cfg.fallbackExpiresInSeconds
    : Math.max(60, Math.floor((jwtExpiry - Date.now()) / 1000));

  trace.hop({
    step: "login-ok",
    status: response.status,
    // Shape facts only. The token itself never enters the trace.
    tokenLength: accessToken.length,
    tokenIsJwt: jwtExpiry !== null,
    expiresIn
  });
  finish(null);

  return { accessToken, refreshToken: "", expiresIn };
}
