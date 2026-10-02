/**
 * One taxonomy for every failure this plugin reports.
 *
 * Before this module the same codes were spelled out in three places, and the
 * three copies disagreed:
 *
 * - `agnes-auth.ts` PRODUCED them (it used to carry its own `IAM_REASON_CODES`
 *   table, back when the login line was SenseNova's OIDC + JWE and the platform
 *   answered with a `google.rpc.Status` envelope whose real cause sat in
 *   `details[].reason`);
 * - `token-store.ts` kept its own list of the ones that describe a bad
 *   credential (`CREDENTIAL_REFUSALS`);
 * - `index.ts` kept a third list of the ones that mean "we never got a token"
 *   (`isAuthFailure`).
 *
 * The third list had fallen behind the first: `account_locked`,
 * `rate_limited`, `verification_required` and `login_failed` were produced but
 * not recognised, so a locked account was reported to the user as a generic
 * console failure. Adding a code means editing three files, and forgetting one
 * of them fails silently — which is exactly what happened.
 *
 * Now a code is declared once here. A new platform reason is one new entry:
 * it is a credential refusal or it is not, and it is an auth failure or it is
 * not, and both are decided in the same place the code is named.
 *
 * @module dsh-connect-agnes-token-plan/codes
 */

/**
 * Every failure code this plugin can produce or carry.
 *
 * The names are the wire values: they reach the panel in `body.code` and are
 * what tests and the client branch on, so they are not free to rename.
 */
export const CODE = Object.freeze({
  /** A malformed endpoint override. Surfaced as `config_error`, never retried. */
  CONFIG: "config",

  /** The submitted account is empty. The user's to fix, not the clock's. */
  MISSING_CREDENTIALS: "missing_credentials",
  /** No account has ever been entered. Not a refusal: nothing was attempted. */
  NOT_CONFIGURED: "not_configured",

  /** The platform said the account or password is wrong. */
  LOGIN_REJECTED: "login_rejected",
  /** The platform locked the account. */
  ACCOUNT_LOCKED: "account_locked",
  /** The platform rate-limited the attempt. */
  RATE_LIMITED: "rate_limited",
  /** A captcha or an SMS step only a human can complete. */
  VERIFICATION_REQUIRED: "verification_required",
  /** The platform refused without naming a reason this table knows. */
  LOGIN_FAILED: "login_failed",

  /** The refresh token is dead: only a password login can recover. */
  REFRESH_REJECTED: "refresh_rejected",
  /** A stored grant carries no refresh token to renew with. */
  NO_REFRESH_TOKEN: "no_refresh_token",

  /** The console refused the token twice in a row (indexts). */
  JWT_EXPIRED: "jwt_expired",
  /** No token could be obtained (indexts). */
  AUTH_ERROR: "auth_error",
  /** The console call itself failed (indexts). */
  CONSOLE_ERROR: "console_error",
  /** The plugin row is misconfigured (indexts). */
  CONFIG_ERROR: "config_error"
});


/**
 * A note on where "the platform's machine reasons" went.
 *
 * There is no such table here any more, and that is not an oversight: Agnes
 * answers a refused sign-in with a plain message, so the only thing left to
 * classify on is substring matching, and it lives in `classifyLoginFailure()`
 * (`agnes-auth.ts`) — which PITFALLS §3 requires to prefer the platform's own
 * wording over a local guess, and which splits credential refusals (never
 * retried) from time-shaped ones (wait out the stated window).
 *
 * A future reason that DOES arrive as a machine code gets its exact match
 * added there, not here: a table with no reader is the §38 kind of thing that
 * reads like a hook and reaches nothing.
 */

/**
 * Refusals that describe the CREDENTIAL rather than the moment.
 *
 * A wrong password does not become right by waiting, so a timer is the wrong
 * instrument for it: the panel must keep asking for an account instead of
 * quietly burning another attempt every minute. The platform's own
 * verification prompts are the same shape — the user has to do something, so
 * nothing is retried behind their back.
 *
 * `NOT_CONFIGURED` is deliberately not here. It is not a refusal at all: it
 * means no account has ever been entered, so there was never an attempt to
 * avoid repeating. Parking it would write a throttle record on every fresh
 * install and then report `needsUserAction` to a user who has done nothing
 * wrong yet.
 * @type {ReadonlySet<string>}
 */
export const CREDENTIAL_REFUSALS: ReadonlySet<string> = Object.freeze(new Set([
  CODE.LOGIN_REJECTED,
  CODE.VERIFICATION_REQUIRED
]));

/**
 * Every code that means "the plugin could not obtain a token".
 *
 * The panel says something different for these than for a console failure:
 * one is fixed by signing in, the other usually clears on the next poll. This
 * set is what keeps that distinction honest — a code the auth half can produce
 * MUST be in here, or it will be reported as `console_error` and the user will
 * be told the wrong thing.
 * @type {ReadonlySet<string>}
 */
export const AUTH_FAILURE_CODES: ReadonlySet<string> = Object.freeze(new Set([
  CODE.MISSING_CREDENTIALS,
  CODE.NOT_CONFIGURED,
  CODE.LOGIN_REJECTED,
  CODE.ACCOUNT_LOCKED,
  CODE.RATE_LIMITED,
  CODE.VERIFICATION_REQUIRED,
  CODE.LOGIN_FAILED,
  CODE.REFRESH_REJECTED,
  CODE.NO_REFRESH_TOKEN
]));

/**
 * Whether this failure came from getting a token rather than from calling the
 * console.
 * @param {unknown} error - the caught error.
 * @returns {boolean} true when the token could not be obtained.
 */
export function isAuthFailure(error: unknown) {
  const code = error === null || typeof error !== "object" ? undefined : (error as { code?: unknown }).code;
  return typeof code === "string" && AUTH_FAILURE_CODES.has(code);
}

/**
 * Whether this refusal is fixed by the user acting rather than by waiting.
 * @param {string} code - a {@link CODE} value.
 * @returns {boolean} true when the refusal should be parked, not timed.
 */
export function isCredentialRefusal(code: string) {
  return typeof code === "string" && CREDENTIAL_REFUSALS.has(code);
}

/**
 * Union of the wire values of {@link CODE} (e.g. `"config"`, `"login_rejected"`).
 *
 * Any `@ts-check` module that annotates a field against this gets a compile
 * error when it misspells a code — the exact class of silent failure the three
 * hand-copied lists used to allow.
 * @typedef {typeof CODE[keyof typeof CODE]} CodeValue
 */

/**
 * Failures that no sign-in can fix — the ones the panel must not answer with
 * the account form.
 *
 *   `config_error` — a bad endpoint override; the operator must fix it.
 *   `console_error` — the console did not answer; usually transient, and the
 *                     text must say so instead of inviting a login.
 *
 * This is the declaration; `client.js` ships its own copy
 * (`FORM_EXCLUDED_CODES`) because the browser bundle cannot import this
 * module — and `test/panel.test.mjs` asserts the two sets are equal, so the
 * copy cannot fall behind the declaration.
 */
export const NO_LOGIN_CODES = Object.freeze(new Set([
  CODE.CONFIG_ERROR,
  CODE.CONSOLE_ERROR
]));
