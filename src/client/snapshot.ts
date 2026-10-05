/**
 * The decision layer: reading a snapshot response into a view, and the wire-
 * code tables the panel's guidance and forms are keyed by. Verbatim logic
 * from the pre-split `client.js`.
 */
import { format } from "./format.ts";
import type { Tt } from "./runtime.ts";
import type { AuthData, ShapeWarningData, SnapshotData } from "./wire.ts";

/** A structured failure: what the Host answered besides the numbers. */
export interface SnapshotFailure {
  message: unknown;
  code?: unknown;
  auth?: AuthData | null;
}

/** The (data, error) pair the panel renders; exactly one side is non-null. */
export interface SnapshotRead {
  data: SnapshotData | null;
  error: SnapshotFailure | string | null;
}

/** `viewOf`'s verdict: what this snapshot means for what to show. */
export interface SnapshotView {
  failure: SnapshotFailure | null;
  auth: AuthData | null;
  needsSetup: boolean;
  guidanceKey: string | null;
  guidance: string | null;
  shapeWarnings: ShapeWarningData[];
}

/**
 * Whether a body is a DATA snapshot, as opposed to a refusal.
 *
 * The two `ok` checks in `interpretSnapshot` do the real work — this is the
 * name for the fact they establish, so the caller types the payload as data
 * instead of casting through `unknown`. A type predicate still trusts the
 * wire (the Host owns the shape; `wire.ts` documents that types are loaded,
 * never enforced at runtime), but it records that `ok:true` was seen, where
 * `as unknown as` threw that fact away.
 * @param {unknown} value - the body that reached the `ok:true` branch.
 * @returns {boolean} whether the value is a data snapshot.
 */
function isSnapshotData(value: unknown): value is SnapshotData {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === true;
}

/**
 * Read one snapshot response into the (data, error) pair the panel renders.
 *
 * The Host answers HTTP 200 for every expected outcome and signals the
 * difference in the body: `ok:true` carries the numbers, `ok:false` carries
 * a code and — crucially — the `auth` block, so a panel that cannot reach
 * the console can still say whether its token will renew by itself.
 *
 * A named function at module scope, not inline branching, so the
 * Node-side tests can drive the panel's REAL reading of a response by
 * loading this bundle as a module (`client-surface.js`) — instead of a
 * hand-written copy that would drift the moment either side is edited.
 */
export function interpretSnapshot(body: unknown): SnapshotRead {
  // The body is validated by the checks themselves, so the shape is
  // asserted here rather than pretended at the signature: a non-object
  // body (a string, `null`) must keep falling through to the same two
  // refusals it always has.
  const payload = body as { ok?: unknown; error?: unknown; code?: unknown; auth?: unknown } | null | undefined;
  if (payload && payload.ok === false) {
    // The code is kept to pick the guidance rather than the message.
    return { data: null, error: { message: payload.error || "unexpected payload", code: payload.code, auth: payload.auth ?? null } };
  }
  if (!payload || payload.ok !== true) return { data: null, error: "unexpected payload" };
  return { data: isSnapshotData(payload) ? payload : null, error: null };
}

/**
 * The failure a non-2xx snapshot response becomes.
 *
 * 401 means the token is gone — the same story as the Host's own `jwt_expired`,
 * and the only reading that keeps the sign-in form on screen instead of leaving
 * the reader with a bare status code. Anything else is a plain transport
 * string, which keeps the form reachable too.
 *
 * 403 is deliberately NOT lumped in with 401. The Host's only 403 is its
 * same-origin fence (`routes/http.ts` refuseOrigin), whose body names the real
 * reason — "forbidden: origin mismatch". Telling a reader whose token is fine
 * to "sign in again" sends them after a fix that cannot work. So: when the
 * response carries a body, the Host's own words are the message and the failure
 * stays a transport string; only a bare 403 with nothing to read falls back to
 * the old expired-token reading, because a status with no explanation is still
 * more likely the credential than the fence.
 *
 * Named and module-scoped for the same reason as `interpretSnapshot`: the
 * Node-side tests drive this mapping instead of a copy of it.
 */
export function errorOfStatus(status: number, bodyError?: string): SnapshotFailure | string {
  if (status === 403) {
    const reason = typeof bodyError === "string" ? bodyError.trim() : "";
    if (reason !== "") return reason;
  }
  if (status === 401 || status === 403) return { message: `HTTP ${status}`, code: CLIENT_CODE.JWT_EXPIRED, auth: null };
  return `HTTP ${status}`;
}

/**
 * The panel's guidance line for a wire code, keyed by `body.code` — or, since
 * the console probe stopped being fatal, by `quota.error.code`.
 *
 * This is the ONE deliberate copy of the Host's taxonomy: the browser
 * cannot import `codes.ts` (the Client module table resolves package
 * names only). The copy is therefore pinned, not trusted —
 * `test/panel.test.mjs` asserts both directions: every key here exists in
 * `CODE`, and every code that can REACH the panel is here. The second
 * direction is the one that was missing, and it was found live: a stored
 * account whose sign-in the platform refused answers
 * `quota.error.code === "login_rejected"`, which had no line at all, so the
 * panel fell back to a generic "console not connected" and dropped the one
 * thing the reader needed — that the password has to be re-entered.
 *
 * The coverage obligation is `AUTH_FAILURE_CODES ∪ NO_LOGIN_CODES`: every
 * auth failure, because the console probe now degrades instead of rejecting
 * the body, plus the two codes no login can fix.
 */
export const GUIDANCE_BY_CODE: Readonly<Record<string, string>> = Object.freeze({
  // --- the token side ------------------------------------------------------
  // One story for all of them: the stored credential did not produce a usable
  // token, Agnes issues no refresh token to renew with, so the Host signs in
  // again once from the saved account and then stops. The reader's move is the
  // same in every case — sign in again.
  auth_error: "panel.jwtExpired",
  jwt_expired: "panel.jwtExpired",
  no_refresh_token: "panel.jwtExpired",
  refresh_rejected: "panel.jwtExpired",
  // The SenseNova OIDC-era codes (`jwks` / `login_flow` / `token_rejected` /
  // `refresh_failed`) are deliberately ABSENT. Agnes produces none of them, and
  // this table may not name a code `codes.ts` does not declare — the "every code
  // the panel branches on is declared in codes.js" check enforces exactly that,
  // so re-adding one fails the suite instead of helping a reader.
  // --- the account side ----------------------------------------------------
  // Nothing has been entered yet, so the form is the whole answer.
  not_configured: "panel.jwtMissing",
  missing_credentials: "panel.jwtMissing",
  // The stored account was REFUSED, and each of these is a different next
  // action: re-type it, wait out a lock, wait out a rate limit, or finish a
  // step only a human can do. They reuse the form's own refusal lines rather
  // than collapsing into one "sign-in failed" string that would be wrong for
  // three of the four.
  login_rejected: "auth.badCredentials",
  login_failed: "auth.badCredentials",
  account_locked: "auth.locked",
  rate_limited: "auth.rateLimited",
  verification_required: "auth.verification",
  // --- neither -------------------------------------------------------------
  config_error: "panel.configError",
  // The console did not answer. `FORM_EXCLUDED_CODES` already keeps the
  // login form away from this code, so the guidance line is the whole
  // explanation — and it must say the failure is expected to pass.
  console_error: "panel.consoleTransient"
});

/**
 * Failures the sign-in form must NOT answer, because no login fixes them.
 *
 *   config_error  — a bad endpoint override; the operator must fix it.
 *   console_error — the console did not answer; it usually clears on the
 *                   next poll, and the text must say so.
 *
 * Hiding either behind a login box turns "the console is down" into
 * "please sign in". Pinned to `NO_LOGIN_CODES` in `codes.ts` by the same
 * test: this set is the copy, that one is the declaration.
 */
export const FORM_EXCLUDED_CODES: ReadonlySet<string> = Object.freeze(new Set(["config_error", "console_error"]));

/**
 * The wire codes the client branches on OUTSIDE the guidance tables.
 *
 * `GUIDANCE_BY_CODE` and `REFUSAL_TEXT` map code → dictionary line, but the
 * form and the reader also branch on a code where the answer is behaviour
 * rather than text: which refusal starts the cooldown, which one the platform
 * refused without naming a reason this table knows, and which status means
 * "the token is gone". Those comparisons used to spell the code out a fourth
 * time — a copy `test/panel.test.mjs` F2b never looked at, because it reads
 * the tables, not the branches. Named here and pinned by that same check:
 * every value must be a member of `CODE` in `codes.ts`.
 */
export const CLIENT_CODE = Object.freeze({
  /** A stored token the console refused; the reader's move is to sign in. */
  JWT_EXPIRED: "jwt_expired",
  /** The platform refused without naming a reason this table knows. */
  LOGIN_FAILED: "login_failed",
  /** The platform locked the account after repeated failures. */
  ACCOUNT_LOCKED: "account_locked"
});

/**
 * The dictionary line for a served cooldown, keyed by wire code.
 *
 * `rate_limited` is the fallback: a wait the platform served is by definition
 * a rate-limit-shaped refusal, and it is what the form showed for every code
 * that was not `account_locked`. The branch used to spell the locked code out
 * at the call site; here the mapping lives next to `REFUSAL_TEXT`, where the
 * same bidirectional pin can reach it.
 */
export const COOLDOWN_TEXT: Readonly<Record<string, string>> = Object.freeze({
  [CLIENT_CODE.ACCOUNT_LOCKED]: "auth.locked",
  rate_limited: "auth.rateLimited"
});

/**
 * The platform's classified refusals, keyed by wire code, mapped to the
 * dictionary line the form shows beneath the platform's own detail. The
 * canned text translates; the prose (`body.detail`) carries the lockout
 * policy and anything else the platform wanted to say.
 */
export const REFUSAL_TEXT: Readonly<Record<string, string>> = Object.freeze({
  login_rejected: "auth.badCredentials",
  account_locked: "auth.locked",
  rate_limited: "auth.rateLimited",
  verification_required: "auth.verification"
});

/**
 * The panel's decision: what this snapshot means for what to show.
 *
 * Deliberately a module-scope pure function in `(data, error, tt)`.
 * `PanelPage` calls it in the browser, and the Node-side tests call the
 * very same function after loading this bundle as a module (see
 * `client-surface.js`): no source text is copied or scraped, so the
 * tested logic and the running logic cannot drift apart.
 */
export function viewOf(
  data: SnapshotData | null,
  error: SnapshotFailure | string | null,
  tt: Tt
): SnapshotView {
  // `error` is either a string (transport failure) or the Host's structured
  // failure. The auth state travels with both, so a panel that cannot read
  // the console can still say whether the token renews itself.
  const failure: SnapshotFailure | null = error === null || error === undefined
    ? null
    : typeof error === "string" ? { message: error, code: null, auth: null } : error;
  const auth: AuthData | null = (data?.auth ?? failure?.auth ?? null) as AuthData | null;
  // With no data the form is the answer whenever the fix is the ACCOUNT:
  // nothing has been entered yet, or no token can be obtained — except for
  // the codes no login can fix. `data === null, error === null` also reads
  // as setup here, and that is the STEADY-STATE answer only: the mounted
  // page holds it behind its `loadedOnce` gate until the first attempt has
  // concluded, so the true first frame shows the loading line, not the
  // form (pinned by `test/render.test.mjs` group H2).
  //
  // "The fix is the account" no longer requires a NULL body. A Host that
  // degrades answers `ok:true` with `quota.consoleConnected:false`, which is
  // the same situation the full-screen form used to answer: nothing on this
  // screen is readable until someone signs in. Reading it off `data === null`
  // alone would have retired the form the moment the Host learned to degrade,
  // leaving a fresh install with no way in.
  //
  // A Host too old to emit `consoleConnected` is not a hazard: it answers
  // `ok:false` for this case, so `data === null` still covers it.
  const code = failure?.code ?? data?.quota?.error?.code ?? null;
  const needsSetup = (data === null || data.quota?.consoleConnected === false)
    && !FORM_EXCLUDED_CODES.has(code as string);
  // The dictionary key, resolved with the caller's `tt`; returned as a key
  // so tests can assert the decision without owning a dictionary.
  //
  // Keyed off the SAME `code` as `needsSetup`, which is `failure.code` when the
  // Host refused the whole body and `quota.error.code` when it degraded one
  // source instead. The degraded case is the one that needs this: a console
  // that is unreachable for want of an account, a dead token, or a platform
  // outage all arrive as `ok:true` now, and the code is the only thing that
  // says which of the three the reader is looking at.
  const guidanceKey = code === null ? null : GUIDANCE_BY_CODE[code as string] ?? null;
  const guidance = guidanceKey === null
    ? null
    : guidanceKey === "panel.configError"
      ? format(tt(guidanceKey), { error: failure?.message ?? data?.quota?.error?.message })
      : tt(guidanceKey);
  // The Host's own contract check: a renamed upstream field would otherwise
  // look identical to "no usage yet".
  const shapeWarnings = Array.isArray(data?.shapeWarnings)
    ? (data.shapeWarnings as ShapeWarningData[])
    : [];
  return { failure, auth, needsSetup, guidanceKey, guidance, shapeWarnings };
}

/**
 * Whether to show the account management section.
 *
 * Decision: show the account editor UNCONDITIONALLY whenever the snapshot
 * carries the Host's auth block. Gating on `hasAccount` / `needsAccount` made
 * the "middle state" (grant still alive, saved account cleared) a dead end:
 * the full-screen setup form lives behind `!data`, and the section card
 * vanished with `hasAccount` — the user was locked out of their own account
 * with no re-entry path until the grant died. This is a single-point-of-truth
 * declaration; callers should use `shouldShowAccountManagement(auth)` rather
 * than duplicating `auth !== null`.
 */
export function shouldShowAccountManagement(auth: AuthData | null): boolean {
  return auth !== null;
}

/**
 * The wait the HOST is already serving, in epoch millis, or `0` for none.
 *
 * WHY THIS EXISTS. The Host's `state()` reads the persisted throttle and
 * serves it as `auth.retryAfterMs` — a REMAINING window (`held.until - now`,
 * `inForceWaitMs` in `token-store/throttle.ts`), not the whole window the
 * refusal originally stated. Its own comment says why: "a second Host process
 * shows the same countdown rather than inviting an attempt that would be
 * refused." The throttle file is deliberately NOT per-profile
 * (`throttle-store.ts`), so a lockout taken on the desktop profile is real on
 * the web profile too.
 *
 * The panel had no consumer for it. `AccountForm` seeded its countdown from
 * component state alone (`useState(0)`), so the window was honoured only for
 * the process that made the failed attempt — and after a page refresh, a
 * second profile, or a second Host process, the button read ENABLED while the
 * Host was still inside the wait. `saveAccount` deliberately clears the
 * throttle ("a deliberate resubmit is the user acting on what the panel told
 * them"), so that click was not merely futile: it cleared the record the other
 * process was obeying and spent a real attempt against a possibly-locked
 * account. The one field the Host went out of its way to serve was the one
 * field the panel dropped.
 *
 * A PARKED refusal (`needsUserAction`) returns `0` on purpose: a wrong
 * password or a captcha has no deadline to count down, and pretending
 * otherwise would show a countdown ending in another attempt that can only
 * fail. `AccountForm` renders that state as a sentence instead.
 *
 * @param auth - the snapshot's `auth` block, or `null` when it carried none.
 * @param now - the current clock, injected so the countdown is testable.
 * @returns epoch millis to wait until, or `0` when nothing is being waited out.
 */
export function servedWaitUntil(auth: AuthData | null, now: number): number {
  if (auth === null) return 0;
  // Parked: no clock will clear it, so there is nothing to count down.
  if (auth.needsUserAction === true) return 0;
  const remaining = auth.retryAfterMs;
  if (typeof remaining !== "number" || !Number.isFinite(remaining) || remaining <= 0) return 0;
  return now + remaining;
}
