import { A as pluginError, C as isAdmitted, D as num, E as resolveSettings, F as verbatim, M as redactSecrets, N as retryBounded, O as numOrNull, P as str, S as inject, T as resolveAuthOverrides, _ as parseUsageSeries, b as CONFIG_DEFAULTS, c as summarizeCatalog, d as isVideoGenModel, f as checkShape, g as parseUsageOverview, h as parseSubscriptionUsage, j as redactError, k as obj, l as visionOf, m as parsePlans, n as LLM_DISPLAY_NAME, o as filterByEnabled, p as matchCurrentPlan, r as LLM_PROVIDER_ID, s as rosterWithAvailability, t as DEFAULT_REASONING_EFFORT, u as isImageGenModel, v as quotaWindows, w as name, x as hostName, y as readSubscriptionExpiry } from "./llm-models-BZfJOFax.js";
import { S as writeStateFile, _ as profileSegment, a as filterAgnescodeRows, b as stateDir, c as fetchAgnescodeBalance, d as trustAgnescodeBffBase, f as createFileCatalogStore, g as ensureStateDir, h as createStateReadCache, l as fetchAgnescodeCatalog, m as STATE_READ_TTL_MS, n as AGNESCODE_PROVIDER_ID, o as AGNESCODE_FALLBACK_MODELS, p as normalizeEnabledIds, s as decodeAgnescodeJwtExpMs, t as AGNESCODE_DISPLAY_NAME, u as harvestAgnescodeLocalSession, v as profileStateDir, x as temporaryOf, y as readStateJson } from "./agnescode-models-2ds9ZdGx.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { promises } from "node:fs";

//#region src/host/codes.ts
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
const CODE = Object.freeze({
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
const CREDENTIAL_REFUSALS = Object.freeze(/* @__PURE__ */ new Set([CODE.LOGIN_REJECTED, CODE.VERIFICATION_REQUIRED]));
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
const AUTH_FAILURE_CODES = Object.freeze(/* @__PURE__ */ new Set([
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
function isAuthFailure(error) {
	const code = error === null || typeof error !== "object" ? void 0 : error.code;
	return typeof code === "string" && AUTH_FAILURE_CODES.has(code);
}
/**
* Whether this refusal is fixed by the user acting rather than by waiting.
* @param {string} code - a {@link CODE} value.
* @returns {boolean} true when the refusal should be parked, not timed.
*/
function isCredentialRefusal(code) {
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
const NO_LOGIN_CODES = Object.freeze(/* @__PURE__ */ new Set([CODE.CONFIG_ERROR, CODE.CONSOLE_ERROR]));

//#endregion
//#region src/host/agnes-auth.ts
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
/**
* Shipped defaults for the login flow.
*
* `consoleOrigin` is the BACKEND host, not the console front-end: the front-end
* origin (`platform.agnes-ai.cn`) serves `/api/*` as a Next.js 404 shell, so a
* login aimed there fails in a way that looks like a wrong path rather than a
* wrong host. Getting this wrong is the single easiest mistake to make here.
*/
const AUTH_DEFAULTS = Object.freeze({
	consoleOrigin: "https://platform-backend.agnes-ai.cn",
	loginPath: "/api/user/login",
	requestTimeoutMs: 15e3,
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
	fallbackExpiresInSeconds: 604800
});
/** RFC 7519 `exp`, in epoch MILLIS, or `null` when the token carries none. */
function readJwtExpiry(token) {
	const parts = str(token, "").split(".");
	if (parts.length !== 3) return null;
	try {
		const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		const exp = Number(obj(claims).exp);
		return Number.isFinite(exp) && exp > 0 ? exp * 1e3 : null;
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
function maskUsername(username) {
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
function classifyLoginFailure(status, message) {
	const text = str(message, "").toLowerCase();
	if (/invalid username or password|incorrect|wrong password|invalid credential/.test(text)) return CODE.LOGIN_REJECTED;
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
function resolveAuthConfig(overrides = {}) {
	const source = obj(overrides);
	const consoleOrigin = str(source.consoleOrigin, AUTH_DEFAULTS.consoleOrigin).replace(/\/+$/, "");
	if (consoleOrigin === "") throw new Error("agnes auth: consoleOrigin is required (the password is posted to it)");
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
	second: 1e3,
	sec: 1e3,
	seconds: 1e3,
	secs: 1e3,
	minute: 6e4,
	min: 6e4,
	minutes: 6e4,
	mins: 6e4,
	hour: 36e5,
	hr: 36e5,
	hours: 36e5,
	hrs: 36e5,
	day: 864e5,
	days: 864e5,
	秒: 1e3,
	分钟: 6e4,
	小时: 36e5,
	天: 864e5
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
function parseRetryAfterMs(response, message, nowMs = Date.now()) {
	const header = response?.headers?.get?.("retry-after");
	if (typeof header === "string" && header.trim() !== "") {
		const trimmed = header.trim();
		const seconds = Number(trimmed);
		if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1e3);
		const at = Date.parse(trimmed);
		if (Number.isFinite(at)) {
			const delta = at - nowMs;
			if (delta > 0) return delta;
		}
	}
	const stated = STATED_DURATION.exec(str(message, ""));
	if (stated !== null) {
		const amount = Number(stated[1]);
		const unitRaw = stated[2];
		const unit = UNIT_MS[unitRaw.toLowerCase()] ?? UNIT_MS[unitRaw];
		if (Number.isFinite(amount) && amount > 0 && unit !== void 0) return Math.round(amount * unit);
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
function createAuth(overrides = {}) {
	const config = resolveAuthConfig(overrides);
	return {
		config,
		login(credentials, options) {
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
async function loginWith(cfg, credentials, options = {}) {
	const username = str(credentials?.username, "");
	const password = typeof credentials?.password === "string" ? credentials.password : "";
	const hops = [];
	const trace = {
		hop(entry) {
			hops.push(entry);
		},
		done() {
			return hops;
		}
	};
	const finish = (error) => {
		try {
			if (error !== void 0 && error !== null) try {
				error.trace = hops;
			} catch {}
			options.onTrace?.(trace.done(), error);
		} catch {}
	};
	if (username === "" || password.trim() === "") {
		const error = pluginError(CODE.MISSING_CREDENTIALS, "an email and a password are both required");
		finish(error);
		throw error;
	}
	const url = `${cfg.consoleOrigin}${cfg.loginPath}`;
	trace.hop({
		step: "login",
		method: "POST",
		url,
		account: maskUsername(username)
	});
	let response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
				"x-user-language": "zh-CN"
			},
			body: JSON.stringify({
				username,
				password
			}),
			signal: AbortSignal.timeout(cfg.requestTimeoutMs)
		});
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		trace.hop({
			step: "login-transport-error",
			detail
		});
		const error = pluginError(CODE.LOGIN_FAILED, `could not reach the Agnes console: ${detail}`);
		finish(error);
		throw error;
	}
	const text = await response.text().catch(() => "");
	let body = null;
	try {
		body = JSON.parse(text);
	} catch {}
	const message = str(obj(body).message, "");
	if (!response.ok || Number(obj(body).code) !== 200) {
		const code = classifyLoginFailure(response.status, message);
		const retryAfterMs = parseRetryAfterMs(response, message);
		trace.hop({
			step: "login-refused",
			status: response.status,
			code,
			retryAfterMs,
			message: message.slice(0, 200)
		});
		const error = pluginError(code, message !== "" ? message : `Agnes console returned HTTP ${response.status}`);
		if (retryAfterMs !== null) error.retryAfterMs = retryAfterMs;
		finish(error);
		throw error;
	}
	const accessToken = str(obj(obj(body).data).access_token, "");
	if (accessToken === "") {
		trace.hop({
			step: "login-contract-break",
			status: response.status
		});
		const error = pluginError(CODE.LOGIN_FAILED, "the console answered 200 without an access_token");
		finish(error);
		throw error;
	}
	const jwtExpiry = readJwtExpiry(accessToken);
	const expiresIn = jwtExpiry === null ? cfg.fallbackExpiresInSeconds : Math.max(60, Math.floor((jwtExpiry - Date.now()) / 1e3));
	trace.hop({
		step: "login-ok",
		status: response.status,
		tokenLength: accessToken.length,
		tokenIsJwt: jwtExpiry !== null,
		expiresIn
	});
	finish(null);
	return {
		accessToken,
		refreshToken: "",
		expiresIn
	};
}

//#endregion
//#region src/host/throttle-store.ts
/**
* dsh-connect-agnes-token-plan — where the sign-in throttle lives.
*
* It used to live in the credentials service, disguised as a `kind: "grant"`
* record carrying a marker field. That disguise was not a stylistic choice:
* the service admits exactly two record kinds, and an unknown one makes the
* whole credentials document unparseable — which takes the Host down, not
* just this panel. So a throttle could only ever be smuggled in as a grant,
* and a single mistyped payload was enough to break every credential on the
* machine.
*
* A throttle is not a credential. It is state: a deadline and a reason, plus
* a parked flag for refusals that have no deadline. It belongs in this
* plugin's own file, where a malformed value costs the plugin its throttle
* and nothing else.
*
* @module dsh-connect-agnes-token-plan/throttle-store
*/
/** Shape version, bumped when the persisted form changes. */
const THROTTLE_VERSION = 1;
/**
* Where the throttle lives: the SHARED directory, `$DSH_HOME/state/<plugin>`.
*
* Deliberately NOT per-profile, even though the catalog / provider / draw
* states are (PITFALLS §23). A throttle is not a per-profile preference, it is
* "how long the upstream told this machine to stop knocking" — if only the
* profile that got the 429 honoured it, the other profile's Host would resume
* hammering the same endpoint from the same machine during the very window the
* platform asked for. Splitting it would silently undo the whole point of the
* throttle, and the failure only surfaces under load. Do not "make it
* consistent" with the other three.
* @returns {string} the directory.
*/
function throttleDir() {
	return stateDir(name);
}
/**
* Parse a persisted throttle, or `null` when it is absent, stale, or foreign.
*
* Anything unrecognised reads as "no throttle". That is the safe direction for
* a *time* window — the worst case is one extra attempt — and the reason the
* caller keeps parked refusals somewhere it can still see them.
* @param {unknown} raw - the parsed file contents.
* @param {() => number} now - clock source.
* @returns {{code: string, parked: boolean, until: number|null, attempt: number}|null}
*/
function parse(raw, now) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const body = raw;
	if (num(body.version, 0) !== THROTTLE_VERSION) return null;
	const code = str(body.code, "");
	if (code === "") return null;
	const attempt = Math.max(1, Math.floor(num(body.attempt, 1)));
	if (body.parked === true) return {
		code,
		parked: true,
		until: null,
		attempt
	};
	const until = num(body.until, NaN);
	if (!Number.isFinite(until) || until <= now()) return null;
	return {
		code,
		parked: false,
		until,
		attempt
	};
}
/**
* A throttle store backed by one file.
*
* Writes are atomic — a temporary file, then a rename — because two Host
* processes share this path: a half-written file read by the other process
* would read as "no throttle", which for a parked refusal means an automatic
* retry of a password the user has not changed.
* @param {object} [options] - wiring.
* @param {string} [options.dir] - directory; defaults to {@link throttleDir}.
* @param {() => number} [options.now] - clock source; injected by the tests.
* @returns {{read: Function, write: Function, clear: Function}} the store.
*/
function createFileThrottleStore({ dir = throttleDir(), now = Date.now } = {}) {
	const file = join(dir, "throttle.json");
	return {
		async read() {
			return parse(await readStateJson(file), now);
		},
		async write(state) {
			const temporary = temporaryOf(dir, "throttle.json");
			try {
				await ensureStateDir(dir);
				const body = JSON.stringify({
					version: THROTTLE_VERSION,
					code: state.code,
					parked: state.parked === true,
					until: state.parked === true ? null : state.until,
					attempt: state.attempt
				});
				await writeStateFile(file, body, { temporary });
				return true;
			} catch {
				return false;
			}
		},
		async clear() {
			try {
				await rm(file, { force: true });
				return true;
			} catch {
				return false;
			}
		}
	};
}
/**
* A throttle store that forgets everything when the process ends.
*
* Used by the tests, and by a Host that can be given nothing writable. It is
* deliberately NOT the default: the throttle exists so that a second Host
* process does not walk into a lock the first is waiting out, which is a
* claim about other processes and cannot be kept in memory.
* @param {() => number} [now] - clock source.
* @returns {{read: Function, write: Function, clear: Function}} the store.
*/
function createMemoryThrottleStore(now = Date.now) {
	let held = null;
	return {
		async read() {
			return parse(held, now);
		},
		async write(state) {
			held = {
				version: THROTTLE_VERSION,
				...state
			};
			return true;
		},
		async clear() {
			held = null;
			return true;
		}
	};
}

//#endregion
//#region src/host/token-store/state.ts
/**
* The shared context a token store instance runs on — the seam the split
* around `token-store.ts` stands on.
*
* `token-store.ts` is one closure holding four intertwined blocks (grant,
* account, renewal, throttle) that share seven mutable variables. The split
* (docs/TOKEN-STORE-SPLIT.md) moves each block into its own module; what they
* all keep in common is exactly what this file owns:
*
*   - `wiring` — the read side: the credentials backend (real service or the
*     in-memory vault), the keys, the injected clock, env, auth, and the
*     throttle store. Built once per instance.
*   - `state` — the seven mutable fields, now named instead of closure-scoped:
*     `cached`, `rejected`, `inflight`, `lastError`, `throttle`,
*     `consecutiveRefusals`, `passwordSwept`. Each block writes only its own
*     fields (the ownership table lives in the split doc §1); every block may
*     read any field through `state.`.
*
* Step 1 of the split: `createStoreContext()` is the one new piece of code in
* this move. `token-store.ts`'s `createTokenStore` now builds this context and
* keeps its bodies verbatim against it, so the behavior baseline
* (`test/store-baseline.test.mjs`) stays green — no semantics moved, only the
* names did.
*
* @module dsh-connect-agnes-token-plan/token-store/state
*/
/** Record address: this plugin's own namespace, so a stranger cannot collide. */
const RECORD_ID = "agnes-console";
const THROTTLE_ID = "agnes-console-throttle";
const DEFAULT_SKEW_MS = 12e4;
/**
* Build one store instance's wiring + state.
*
* The body of what `createTokenStore` used to do before its first `let`:
* resolve the throttle store, build the in-memory vault, the service
* resolver, the backend and the ephemeral check, and the key pair. The
* defaults and their comments move here unchanged; `token-store.ts` still
* documents the OPTIONS (they are the public face of the factory).
*
* @param {object} options - the same options object `createTokenStore` takes.
* @returns {{wiring: object, state: object}}
*/
function createStoreContext({ credentials, auth = createAuth(), env = process.env, skewMs = DEFAULT_SKEW_MS, throttleStore: injectedThrottleStore, now = Date.now, onTrace, credentialKey }) {
	const key = credentialKey(name, RECORD_ID);
	const THROTTLE_KEY = credentialKey(name, THROTTLE_ID);
	const throttleStore = injectedThrottleStore ?? createMemoryThrottleStore(now);
	/**
	* The in-memory fallback used while no credentials service is reachable. A
	* Host without the service still gets a working panel: the account and grant
	* live here, which is exactly as private as the real store and simply does
	* not outlive the process.
	*/
	const memory = {
		records: /* @__PURE__ */ new Map(),
		account: /* @__PURE__ */ new Map(),
		async readRecord(k) {
			return this.records.get(k);
		},
		async modifyRecord(k, mutate) {
			const next = await mutate(this.records.get(k));
			if (next === void 0) return this.records.get(k);
			this.records.set(k, next);
			return next;
		},
		async deleteRecord(k) {
			this.records.delete(k);
		},
		async resolve(ref) {
			const value = this.account.get(ref);
			return typeof value === "string" && value !== "" ? {
				value,
				source: "memory"
			} : void 0;
		},
		async set(ref, value) {
			this.account.set(ref, value);
		},
		async unset(ref) {
			this.account.delete(ref);
		}
	};
	/**
	* Resolve the credentials service on EVERY use, not once at mount: the
	* service may register after this plugin loads, and a flag frozen at mount
	* would then claim "no credentials service" forever while the store quietly
	* exists on disk. Accepts the service itself (tests) or a resolver function
	* (indexts) and normalises anything absent to `null`.
	*/
	const resolveService = () => {
		return (typeof credentials === "function" ? credentials() : credentials) ?? null;
	};
	/** The live backend: the real service when attached, else the in-memory vault. */
	const backend = () => resolveService() ?? memory;
	/** True while nothing written through the store would survive a restart. */
	const ephemeral = () => resolveService() === null;
	return {
		wiring: {
			credentials,
			auth,
			env,
			skewMs,
			throttleStore,
			now,
			onTrace,
			credentialKey,
			key,
			THROTTLE_KEY,
			backend,
			ephemeral
		},
		state: {
			/** In-memory token for this process; the record is the durable truth. */
			cached: null,
			/**
			* Tokens the console has already rejected.
			*
			* A 401 does not prove the token expired — it proves the console refused it —
			* so a rejected token must never be handed out again even while its `exp`
			* still looks valid. Without this the store would re-read the same record
			* and replay the token the console just refused.
			*/
			rejected: /* @__PURE__ */ new Set(),
			/** One in-flight acquisition, so N concurrent polls share one login. */
			inflight: null,
			/** Last failure, surfaced to the panel instead of a bare "not configured". */
			lastError: null,
			/**
			* A refusal that must not be repeated on a timer.
			*
			* The platform locks an account after a few bad attempts, so retrying a
			* failed sign-in automatically turns one mistake into a lockout. This records
			* why sign-in is pointless right now and until when.
			*
			* `until` is the absolute deadline when the platform names one ("try again
			* in 8 minutes"); otherwise a local backoff applies, doubling per attempt up
			* to a cap. `parked` marks a credential-shaped refusal, which has no
			* deadline at all: waiting cannot make a wrong password right.
			*/
			throttle: null,
			/**
			* How many refusals in a row this store has seen.
			*
			* Kept separately from `throttle` because the throttle record is deleted as
			* soon as its window closes, while this count must survive that deletion —
			* otherwise the doubling has nothing to double from and every wait restarts
			* at the shortest one.
			*/
			consecutiveRefusals: 0,
			/** True once a legacy stored password has been swept from the credentials service. */
			passwordSwept: false
		}
	};
}

//#endregion
//#region src/host/token-store/grant.ts
/**
* Block 1 of the token-store split: the GRANT read/write and freshness
* judgments. Owns the grant record's lifecycle — parse, adopt, persist,
* reap, fresh check.
*
* This module has no state of its own; it operates on the shared context
* (`wiring` + `state`) built by `state.ts`. The ownership table is in
* `docs/TOKEN-STORE-SPLIT.md` §1. Functions moved here are **verbatim** —
* the behavior baseline (`test/store-baseline.test.mjs`) stays green, so no
* semantics moved, only the file did.
*
* @module dsh-connect-agnes-token-plan/token-store/grant
*/
/** Bumped if the stored payload shape ever changes incompatibly. */
const GRANT_VERSION = 1;
/**
* The stored grant, or `undefined` when nothing usable is stored.
*
* A payload that does not match the expected shape reads as absent rather
* than throwing: a hand-edited or downgraded record should degrade the panel
* into "not configured", not crash the route on every poll.
* @param {unknown} record - a credential record.
* @returns {{accessToken: string, refreshToken: string, expiresAt: number|null}|undefined}
*/
function parseGrant(record) {
	if (record === void 0 || record === null || obj(record).kind !== "grant") return void 0;
	const payload = obj(obj(record).payload);
	if (num(payload.version) !== GRANT_VERSION) return void 0;
	const accessToken = str(payload.accessToken, "");
	if (accessToken === "") return void 0;
	return {
		accessToken,
		refreshToken: str(payload.refreshToken, ""),
		expiresAt: numOrNull(payload.expiresAt) ?? readJwtExpiry(accessToken)
	};
}
/**
* Read the durable grant through the credentials service.
*
* There is deliberately NO legacy-namespace adoption here, unlike the plugin
* this one was forked from. That plugin's predecessor held a SenseNova console
* grant; adopting it as an Agnes session would hand the console a token from a
* different platform — the panel would read "signed in" and 401 forever — and
* the adoption also DELETES the record it reads, which would destroy a grant
* the SenseNova plugin is still using. Two platforms, two credential sets: the
* only correct predecessor state for a brand-new plugin is none.
* @param {object} wiring - the store context wiring.
* @param {object} state - the store context state.
*/
async function readStored(wiring, _state) {
	const { backend, key } = wiring;
	try {
		return parseGrant(await backend().readRecord(key));
	} catch {
		return;
	}
}
/**
* Persist a token pair.
*
* Goes through `modifyRecord` so the read-decide-replace is exclusive: a
* refresh token is single-use, and two processes racing on it would
* otherwise invalidate each other's grant.
* @param {string} accessToken - the new console JWT.
* @param {string} refreshToken - the refresh token the platform just issued.
* @param {number} expiresIn - the access token lifetime in seconds.
* @param {string} [replacing] - the access token this write supersedes:
*   passed by every refresh, and by a password login that read an existing
*   grant. A record still holding exactly that token is the one we read, so
*   replacing it is right; a record holding anything else was rotated by
*   someone else in the meantime and is kept. Absent only for a first-ever
*   login that read no grant.
* @returns {Promise<{accessToken: string, refreshToken: string, expiresAt: number|null}>}
*   the grant now in effect — ours, or the newer one we deferred to.
*/
async function storeGrant(wiring, state, accessToken, refreshToken, expiresIn, replacing) {
	const { backend, key, now } = wiring;
	const issuedAt = now();
	const payload = {
		version: GRANT_VERSION,
		accessToken,
		refreshToken,
		expiresAt: issuedAt + num(expiresIn, 10800) * 1e3
	};
	try {
		const stored = parseGrant(await backend().modifyRecord(key, (current) => {
			const existing = parseGrant(current);
			if (replacing !== void 0) {
				if (existing !== void 0 && existing.accessToken !== replacing) return;
			} else if (existing !== void 0 && existing.expiresAt !== null && existing.expiresAt > issuedAt + 6e4) return;
			return Promise.resolve({
				kind: "grant",
				payload
			});
		})) ?? payload;
		state.cached = stored;
		return stored;
	} catch (error) {
		state.cached = {
			accessToken,
			refreshToken,
			expiresAt: payload.expiresAt
		};
		throw new Error(`could not persist the console token (${error instanceof Error ? error.message : String(error)}); it stays valid until dsh restarts`);
	}
}
/**
* Remove a grant that can no longer be of any use.
*
* A refresh token the platform has rejected (`refresh_rejected`) is dead for
* good, and when no account is stored to re-login with there is no path that
* ever revives it. Leaving it on disk did two things: it kept an ownerless
* token pair in the credentials file after "forget account", and it made
* every poll hit the dead refresh token before giving up. This reaps it.
* Best-effort: a read-only store keeps serving from memory until restart.
* @param {string} [accessToken] - the dead token, also dropped from the
*   in-memory cache and rejection set.
*/
async function purgeGrant(wiring, state, accessToken) {
	const { backend, key } = wiring;
	state.cached = null;
	if (accessToken !== void 0) state.rejected.delete(accessToken);
	await backend().deleteRecord(key).catch(() => {});
}
/**
* Whether a token is still good for at least `skewMs`.
* @param {object} wiring - the store context wiring.
* @param {object} state - the store context state.
* @param {object} token - a stored grant, or null/undefined.
* @param {number} [at] - the clock reference; defaults to `now()`.
* @returns {boolean}
*/
function isFresh(wiring, state, token, at) {
	const { now, skewMs } = wiring;
	if (at === void 0) at = now();
	if (token === void 0 || token === null) return false;
	if (state.rejected.has(token.accessToken)) return false;
	if (token.expiresAt === null) return true;
	return token.expiresAt - at > skewMs;
}

//#endregion
//#region src/host/token-store/throttle.ts
/**
* Block 4 of the token-store split: the sign-in refusal state machine.
* Owns the throttle's read/write/clear, the local backoff doubling, the legacy
* record adoption, and the refusal-shape error synthesis.
*
* No state of its own; operates on the shared context from `state.ts`.
* Functions moved here are **verbatim** — the behavior baseline
* (`test/store-baseline.test.mjs`) stays green, so no semantics moved, only
* the file did.
*
* The two backoff constants live here because they only ever appear in this
* block; they are still re-exported from `token-store.ts` (public surface
* unchanged).
*
* @module dsh-connect-agnes-token-plan/token-store/throttle
*/
/**
* The first wait imposed on a refusal the platform gave no window for.
*
* Doubles from here; `MAX_LOGIN_BACKOFF_MS` caps it.
*/
const DEFAULT_LOGIN_BACKOFF_MS = 6e4;
/**
* Cap on a self-imposed wait.
*
* Applies ONLY to a wait this store invented. A window the platform stated
* itself ("try again in 2 hours") is never truncated by it: capping that is
* exactly what walks back into a lock that is still in force.
*/
const MAX_LOGIN_BACKOFF_MS = 18e5;
/**
* The refusal an in-force throttle stands for.
*
* Rethrows the platform's own failure while it is still the live one, so the
* message the user reads is the platform's words, not this store's. Once the
* wait has been served and re-reading finds a fresh refusal, that failure is
* gone — so the throttle's own description takes over.
*
* The classification code is preserved on the synthesized error, so the panel
* can still tell a wrong password from a lockout and say which it is.
* @param {{code: string, parked: boolean, until: number|null, attempt: number}} held
*   the throttle in force.
* @param {Error} [cause] - the original refusal, when it is still current.
* @returns {Error} the error to throw.
*/
function throttleError(held, cause) {
	if (cause !== void 0) return cause;
	const error = /* @__PURE__ */ new Error(held.parked ? "sign-in is not being retried automatically: the account needs to be entered again" : `sign-in is not being retried automatically: waiting out a ${held.code} refusal`);
	error.code = held.code;
	return error;
}
/**
* How long a refusal without a stated window should wait.
*
* Doubles per consecutive refusal so a persistently wrong password settles
* at the cap instead of producing a steady one-minute trickle of attempts
* for as long as the panel stays open.
* @param {number} attempt - how many self-imposed waits have been served.
* @returns {number} milliseconds to wait.
*/
function localBackoffMs(attempt) {
	const doubled = DEFAULT_LOGIN_BACKOFF_MS * 2 ** Math.max(0, attempt - 1);
	return Math.min(doubled, MAX_LOGIN_BACKOFF_MS);
}
/**
* Read the persisted throttle, or `null` when absent, stale, or unreadable.
*
* A parked refusal has no deadline, so it is keyed on its `parked` flag
* rather than on a time: reading it back must not depend on a field that is
* legitimately absent.
* @returns {Promise<{code: string, parked: boolean, until: number|null, attempt: number}|null>}
*/
async function readThrottle(wiring, _state) {
	const { throttleStore } = wiring;
	return await throttleStore.read().catch(() => null);
}
/**
* Remember a refusal so neither this process nor another one retries it.
*
* Persisted because a second Host process polling the same account would
* otherwise walk straight into a lock this one is politely waiting out.
* @param {object} error - the refusal thrown by `login`.
* @param {number} [previousAttempt] - the attempt count being superseded.
* @returns {Promise<{code: string, parked: boolean, until: number|null, attempt: number}>}
*   the throttle now in force.
*/
async function writeThrottle(wiring, state, error, previousAttempt) {
	const { throttleStore, now } = wiring;
	const code = str(error?.code, CODE.LOGIN_FAILED);
	const parked = isCredentialRefusal(code);
	const stated = numOrNull(error?.retryAfterMs);
	state.consecutiveRefusals = num(previousAttempt, state.consecutiveRefusals) + 1;
	const attempt = state.consecutiveRefusals;
	state.throttle = {
		code,
		parked,
		until: parked ? null : now() + (stated === null ? localBackoffMs(attempt) : Math.max(stated, 0)),
		attempt
	};
	if (await throttleStore.write(state.throttle).catch(() => false) === false) try {
		const msg = `throttle write failed: ${JSON.stringify(state.throttle, null, 2)}`;
		console.warn(`[dsh-connect-agnes-token-plan] ${msg}`);
	} catch {}
	return state.throttle;
}
/**
* Drop the throttle, so the next sign-in is allowed to try.
* @returns {Promise<void>}
*/
async function clearThrottle(wiring, state) {
	const { throttleStore, backend, THROTTLE_KEY } = wiring;
	state.throttle = null;
	if (await throttleStore.clear().catch(() => false) === false) try {
		console.warn("[dsh-connect-agnes-token-plan] throttle clear failed: the file may survive and re-park the next sign-in");
	} catch {}
	await backend().deleteRecord(THROTTLE_KEY).catch(() => {});
}
/**
* How much longer a throttle is in force, or `null` when it is not.
*
* A parked refusal has no deadline and so no countdown.
* @param {{parked: boolean, until: number|null}|null} held - the throttle.
* @returns {number|null} milliseconds remaining.
*/
function inForceWaitMs(wiring, held) {
	const { now } = wiring;
	if (held === null || held.parked) return null;
	return Math.max(0, held.until - now());
}

//#endregion
//#region src/host/token-store/account.ts
/**
* Block 2 of the token-store split: the account lifecycle. Owns reading the
* username/account, logging in, saving and forgetting the account, and the
* one-time password sweep.
*
* No state of its own; operates on the shared context from `state.ts`.
* `loginFromAccount` needs two grant-block operations (read the stored grant,
* persist the new one); they are injected by the caller so this module never
* imports `grant.ts` (no circular dependency).
*
* Functions moved here are **verbatim** — the behavior baseline
* (`test/store-baseline.test.mjs`) stays green, so no semantics moved, only
* the file did.
*
* @module dsh-connect-agnes-token-plan/token-store/account
*/
/**
* The reference form of a credential name.
*
* `@deepseek-ai/dsh-credentials` exports `credentialRef` for this, and the
* values below are already in the form it produces — a bare variable name.
* Spelled out here so the store's own test does not have to resolve a peer
* package to exercise anything; the service treats a string and its branded
* reference identically.
* @param {string} name - the variable name.
* @returns {string} the reference.
*/
const credentialRef$1 = (name) => name;
/** Where the account lives. The password is NEVER persisted. */
const USERNAME_REF = "AGNES_USERNAME";
const PASSWORD_REF = "AGNES_PASSWORD";
/**
* The account's identity: the stored username, with the environment as a
* fallback. Kept apart from the password because only the username is ever
* persisted — `state()` asks "is there an account to clear?" without
* requiring a password to be available.
* @returns {Promise<string>} the username, or `""` when none is known.
*/
async function readUsername(wiring, _state) {
	const { backend, env } = wiring;
	const fromStore = async (ref) => {
		const resolved = await backend().resolve(credentialRef$1(ref)).catch(() => void 0);
		return verbatim(resolved?.value, "");
	};
	return str(await fromStore("AGNES_USERNAME"), "") || str(env["AGNES_USERNAME"], "");
}
/**
* The account to log in with: a stored (or environment) username and an
* ENVIRONMENT password.
*
* The password is never persisted. `AGNES_PASSWORD` in the environment
* is its only durable source, and that is an explicit opt-in: without an env
* password the panel simply asks again when the access token dies.
* @returns {Promise<{username: string, password: string, source: string}|undefined>}
*/
async function readAccount(wiring, state) {
	const { backend, env } = wiring;
	const username = await readUsername(wiring, state);
	if (!state.passwordSwept) {
		state.passwordSwept = true;
		await backend().unset(credentialRef$1(PASSWORD_REF)).catch(() => {});
	}
	const password = verbatim(env[PASSWORD_REF], "");
	if (username === "" || password.trim() === "") return void 0;
	return {
		username,
		password,
		source: "env"
	};
}
/**
* Log in with an account and return a self-renewing grant.
*
* The account is taken EXPLICITLY when the caller just typed it (the panel
* save path: the password lives in that call's closure and is never
* written anywhere), and read back from the environment otherwise (the
* auto-recovery path after the access token expires, opt-in via
* `AGNES_PASSWORD`).
*
* The grant read BEFORE the sign-in is named as the one this login
* supersedes. It has to be read first: the token pair only arrives after the
* network walk, and naming nothing is what let a still-fresh grant from a
* DIFFERENT account silently survive a deliberate switch — the panel said
* "signed in" while keeping serving the previous account. Naming the read
* grant turns the write into the same compare-and-set a refresh uses: an
* intentional switch wins, a login racing another process's rotation defers.
* @param {{username: string, password: string}|undefined} explicit - an account
*   supplied by the caller (never persisted); positionally required, though
*   `undefined` is tolerated and falls back to `readAccount`.
* @returns {Promise<{accessToken: string, refreshToken: string, expiresAt: number|null}>}
*/
async function loginFromAccount(wiring, state, explicit, readStored, store) {
	const { auth, onTrace } = wiring;
	const account = explicit ?? await readAccount(wiring, state);
	if (account === void 0) throw pluginError(CODE.NOT_CONFIGURED, "no console account is configured");
	const previous = await readStored();
	const result = await auth.login({
		username: account.username,
		password: account.password
	}, { onTrace });
	return store(result.accessToken, result.refreshToken, result.expiresIn, previous?.accessToken);
}
/**
* Forget the stored account.
*
* The grant is left alone at first: the panel keeps working on the refresh
* token until that runs out, and only then asks for the account again. With
* no account left to recover a dead refresh token, `acquire` also reaps the
* expired grant then, so nothing ownerless is left behind.
* @returns {Promise<void>}
*/
async function forgetAccount(wiring, state) {
	const { backend } = wiring;
	await backend().unset(credentialRef$1(USERNAME_REF));
	await backend().unset(credentialRef$1(PASSWORD_REF));
	state.cached = null;
}

//#endregion
//#region src/host/token-store/renewal.ts
/**
* Block 3 of the token-store split: renewal through the stored refresh token.
*
* `renewWithRefresh` calls the grant block's `store` (compare-and-set write),
* so it receives `store` as an injected callback — keeping this module free of
* any `grant.ts` import (no circular dependency). The function body is
* **verbatim**; the behavior baseline stays green.
*
* @module dsh-connect-agnes-token-plan/token-store/renewal
*/
/**
* Renew with the stored refresh token.
*
* Goes through the grant block's `store`, which names the superseded access
* token so a concurrent rotation is detected instead of silently overwritten.
* @returns {Promise<{accessToken: string, refreshToken: string, expiresAt: number|null}>}
*/
async function renewWithRefresh(wiring, _state, stored, store) {
	const { auth } = wiring;
	if (stored?.refreshToken === void 0 || stored.refreshToken === "") throw pluginError(CODE.NO_REFRESH_TOKEN, "stored grant has no refresh token");
	const result = await auth.refresh(stored.refreshToken);
	return store(result.accessToken, result.refreshToken, result.expiresIn, stored.accessToken);
}

//#endregion
//#region src/host/token-store/acquire.ts
/**
* The single seam where the four blocks meet: `acquire()`.
*
* Order of operations (frozen by the behavior baseline, must NOT change):
*   1. throttle gate — read the in-force refusal, fail fast if parked or in window
*   2. grant freshness — read stored (or cached), return if fresh
*   3. renewal — try the refresh token; on a rejected refresh, fork:
*      - account still stored → fall through to login
*      - no account → reap the dead grant and rethrow
*   4. login fallback — log in with the stored/env account; on a new refusal,
*      write the throttle (except `not_configured`, which records nothing)
*
* All block functions are injected by the caller so this module never imports
* them directly (no circular dependency). The body is **verbatim**; the
* behavior baseline stays green.
*
* @module dsh-connect-agnes-token-plan/token-store/acquire
*/
/**
* Acquire a usable token, logging in or refreshing as needed.
*
* @param {object} wiring - the store context wiring.
* @param {object} state - the store context state.
* @param {object} blocks - the four block functions, injected by the caller.
* @returns {Promise<string>} the access token now in effect.
*/
async function acquire(wiring, state, blocks) {
	const { now } = wiring;
	const { readThrottle, clearThrottle, readStored, isFresh, renewWithRefresh, readAccount, loginFromAccount, writeThrottle, throttleError, purgeGrant } = blocks;
	const held = state.throttle ?? await readThrottle();
	state.throttle = held;
	if (held !== null && (held.parked || held.until !== null && held.until > now())) throw throttleError(held);
	if (held !== null) {
		state.consecutiveRefusals = held.attempt;
		await clearThrottle();
	}
	const stored = await readStored() ?? state.cached ?? void 0;
	if (isFresh(stored)) {
		state.cached = stored;
		return stored.accessToken;
	}
	if (stored?.refreshToken !== void 0 && stored?.refreshToken !== "") try {
		return (await renewWithRefresh(stored)).accessToken;
	} catch (error) {
		if (obj(error).code !== CODE.REFRESH_REJECTED && obj(error).code !== CODE.NO_REFRESH_TOKEN) throw error;
		if (await readAccount() === void 0) {
			await purgeGrant(stored?.accessToken);
			throw error;
		}
	}
	try {
		const fresh = await loginFromAccount();
		state.consecutiveRefusals = 0;
		if (state.throttle !== null) await clearThrottle();
		return fresh.accessToken;
	} catch (error) {
		if (obj(error).code === CODE.NOT_CONFIGURED) throw error;
		const held = await writeThrottle(error, state.throttle?.attempt);
		throw held.parked ? error : throttleError(held, error);
	}
}

//#endregion
//#region src/host/token-store.ts
/**
* Agnes console token store — the seam between the credentials service and
* the panel's console calls.
*
* The console token's lifetime is read from the JWT's own `exp`; when the token
* is not a readable JWT the login falls back to `fallbackExpiresInSeconds`
* (7 days — see `agnes-auth.ts`, and `docs/AUTH.md` §4 for why the estimate
* deliberately errs long). Either way this store keeps the token renewed, so the
* panel never needs the pre-store ritual of copying a fresh token out of
* devtools into `$DSH_HOME/.env` and restarting.
*
* How it works:
*
* - The grant lives in `ctx.credentials` as a `grant` record, never on disk in
*   this plugin and never in the environment. Writing goes through
*   `modifyRecord`, the service's serialized read-modify-write path, so two
*   Host processes rotating the same refresh token cannot lose one another's
*   write.
* - `getToken()` returns a token that is valid for at least
*   `skewMs`. The store is PLATFORM-AGNOSTIC: when the platform issues
*   rotating refresh tokens, the stored one is renewed through
*   `refresh_token` and every renewal replaces the stored pair (the
*   compare-and-set in `token-store/grant.ts` detects a concurrent rotation).
*   Agnes itself issues NO refresh token — `token-store/acquire.ts` catches
*   `NO_REFRESH_TOKEN` and forks into the re-login branch. The block stays because the same store code is
*   the seam a refresh-token platform would plug into; the baseline
*   (S6/S7 scenarios) exercises it through a scripted fake auth.
* - `invalidate()` drops the in-memory token after a 401 so the next call
*   renews once rather than looping on a token the console already rejected.
*
* Sign-in is throttled, never retried on a poll timer. The platform locks an
* account after a few bad attempts, so an automatic retry turns one mistake
* into a lockout. Two kinds of refusal are treated differently:
*
* - A time-shaped one (locked, rate-limited, a platform fault) waits out a
*   backoff — the platform's own window when it states one, otherwise a local
*   one that doubles per attempt up to half an hour. The throttle is persisted,
*   so a second Host process does not keep knocking during the wait.
* - A credential-shaped one (wrong password, a captcha the user must clear) is
*   parked outright: waiting cannot fix it, so the panel asks for the account
*   again and only an explicit resubmit retries. This is what stops a panel
*   left open overnight from spending an attempt every minute on a password
*   nobody has corrected.
*
* Account login is a one-time bootstrap: put the account in the environment
* (`AGNES_USERNAME` / `AGNES_PASSWORD`) and the store logs in on the
* first use, then keeps itself alive from the refresh token alone. The
* password is never persisted by this module.
*
* Structure: this file is the FACADE — `createTokenStore` builds the shared
* context via `createStoreContext` (`./token-store/state.ts`) and delegates to
* the four extracted blocks (grant / account / renewal / throttle, in
* `./token-store/{grant,account,renewal,throttle}.ts`) plus the acquire seam
* (`./token-store/acquire.ts`). Public API and export surface are unchanged.
* The split doc is `docs/TOKEN-STORE-SPLIT.md`.
*
* @module dsh-connect-agnes-token-plan/token-store
*/
/**
* The reference form of a credential name.
*
* `@deepseek-ai/dsh-credentials` exports `credentialRef` for this, and the
* values below are already in the form it produces — a bare variable name.
* Spelled out here so the store's own test does not have to resolve a peer
* package to exercise anything; the service treats a string and its branded
* reference identically, which check 14 pins down.
* @param {string} name - the variable name.
* @returns {string} the reference.
*/
const credentialRef = (name) => name;
/**
* Build the token store.
*
* @param {object} options - wiring.
* @param {object|null} options.credentials - the `ctx.credentials` service, or
*   `null` when the Host has none. A missing service must not disable the
*   panel: everything falls back to this process's memory, so the account form
*   still works and the token renews for as long as the Host lives. Only a
*   restart then asks again.
* @param {object} [options.auth] - a `createAuth()` instance; defaults to one
*   built on the platform defaults. The Host passes its configured instance so
*   the login flow and token refresh target the operator's endpoints, not the
*   shipped ones.
* @param {Function} options.credentialKey - the service's key factory, so the
*   branded key is built by the service that owns the type.
* @param {object} [options.env] - environment source (defaults to
*   `process.env`); injected by the tests.
* @param {number} [options.skewMs] - renew this long before expiry.
* @param {object} [options.throttleStore] - where sign-in refusals are
*   remembered; defaults to this plugin's own file, which is what lets one
*   Host process see a lock another is waiting out. Injected by the tests.
* @param {() => number} [options.now] - clock source; injected by the tests so
*   a backoff window can be crossed deliberately instead of by waiting.
* @param {function(?object[], ?(Error & {code?: unknown})): void} [options.onTrace] - called with
*   the sanitized hop list when a sign-in attempt ENDS, success or failure;
*   the second argument is `null` on success and the thrown error otherwise
*   (matching the contract `agnes-auth.ts` uses).
* @returns the store: `getToken`, `invalidate`, `saveAccount`,
*   `forgetAccount`, and `state`.
*/
function createTokenStore(options) {
	const { wiring, state } = createStoreContext(options);
	const { env, backend, ephemeral } = wiring;
	const { rejected } = state;
	/** One-line delegations to the extracted blocks. */
	const readStored$1 = () => readStored(wiring, state);
	const store = (at, rt, exp, replacing) => storeGrant(wiring, state, at, rt, exp, replacing);
	const purgeGrant$1 = (accessToken) => purgeGrant(wiring, state, accessToken);
	const isFresh$1 = (token, at) => isFresh(wiring, state, token, at);
	const readThrottle$1 = () => readThrottle(wiring, state);
	const clearThrottle$1 = () => clearThrottle(wiring, state);
	const writeThrottle$1 = (error, previousAttempt) => writeThrottle(wiring, state, error, previousAttempt);
	const throttleError$1 = (held, cause) => throttleError(held, cause);
	const inForceWaitMs$1 = (held) => inForceWaitMs(wiring, held);
	const readUsername$1 = () => readUsername(wiring, state);
	const readAccount$1 = () => readAccount(wiring, state);
	const loginFromAccount$1 = (explicit) => loginFromAccount(wiring, state, explicit, readStored$1, store);
	const renewWithRefresh$1 = (stored) => renewWithRefresh(wiring, state, stored, store);
	const acquire$1 = () => acquire(wiring, state, {
		readThrottle: readThrottle$1,
		clearThrottle: clearThrottle$1,
		readStored: readStored$1,
		isFresh: isFresh$1,
		renewWithRefresh: renewWithRefresh$1,
		readAccount: readAccount$1,
		loginFromAccount: loginFromAccount$1,
		writeThrottle: writeThrottle$1,
		throttleError: throttleError$1,
		purgeGrant: purgeGrant$1
	});
	return {
		/**
		* A console access token that should not be rejected for expiry.
		* @returns {Promise<string>}
		*/
		async getToken() {
			if (state.cached !== null && isFresh$1(state.cached)) return state.cached.accessToken;
			state.inflight ??= acquire$1().then((token) => {
				state.lastError = null;
				return token;
			}).catch((error) => {
				state.lastError = error;
				throw error;
			}).finally(() => {
				state.inflight = null;
			});
			return state.inflight;
		},
		/**
		* Forget the token the console just rejected, so the next call renews
		* exactly once instead of replaying a token the server already refused.
		* @param {string} [token] - the token that was refused; defaults to the
		*   cached one.
		*/
		invalidate(token) {
			const refused = str(token, state.cached?.accessToken ?? "");
			if (refused !== "") {
				rejected.add(refused);
				while (rejected.size > 8) rejected.delete(rejected.values().next().value);
			}
			state.cached = null;
		},
		/**
		* Store a console account, then log in with it.
		*
		* This is what the panel's setup form calls. Only the USERNAME goes to
		* `ctx.credentials` (owner-only on disk, never in this plugin's own
		* files); the password stays in this call's closure and is gone when the
		* attempt ends. The resulting grant is what keeps the panel alive
		* afterwards, so a rejected password leaves nothing secret at rest.
		* @param {{username: string, password: string}} account - the credentials.
		* @returns {Promise<void>}
		*/
		async saveAccount(account) {
			const username = str(account?.username, "");
			const password = verbatim(account?.password, "");
			if (username === "" || password.trim() === "") throw pluginError(CODE.MISSING_CREDENTIALS, "a username and a password are both required");
			await backend().set(credentialRef(USERNAME_REF), username);
			state.cached = null;
			rejected.clear();
			await clearThrottle$1();
			try {
				await loginFromAccount$1({
					username,
					password
				});
			} catch (error) {
				if (obj(error).code !== CODE.NOT_CONFIGURED) await writeThrottle$1(error);
				throw error;
			}
		},
		/**
		* Forget the stored account.
		*
		* The grant is left alone at first: the panel keeps working on the refresh
		* token until that runs out, and only then asks for the account again. With
		* no account left to recover a dead refresh token, `acquire` also reaps the
		* expired grant then, so nothing ownerless is left behind.
		* @returns {Promise<void>}
		*/
		async forgetAccount() {
			return forgetAccount(wiring, state);
		},
		/**
		* A description of the store for the panel: whether a token is held, when
		* it expires, and the last failure. No secret is included.
		*/
		async state() {
			const stored = await readStored$1();
			const account = await readAccount$1();
			const username = await readUsername$1();
			const held = state.throttle ?? await readThrottle$1();
			return {
				configured: stored !== void 0 || account !== void 0,
				hasAccount: username !== "",
				autoRecoverArmed: str(env[PASSWORD_REF], "") !== "",
				hasRefreshToken: str(stored?.refreshToken, "") !== "",
				expiresAt: stored?.expiresAt ?? null,
				needsAccount: stored === void 0 && account === void 0,
				ephemeral: ephemeral(),
				retryAfterMs: inForceWaitMs$1(held),
				needsUserAction: held !== null && held.parked,
				error: isFresh$1(stored) ? null : state.lastError === null ? null : state.lastError instanceof Error ? state.lastError.message : String(state.lastError)
			};
		}
	};
}

//#endregion
//#region src/host/switch-store.ts
/**
* The ONE shape every panel opt-in switch shares.
*
* This plugin has four opt-in switches — provider registration, the draw tool,
* the video tool and the AgnesCode provider — and they answer the same two
* questions with the same integrity discipline:
*
*   - did THE PANEL ever decide this? (a saved value beats the config default);
*   - if it did, which model did it prefer? (draw / video only);
*   - persisted as a versioned payload, temp file plus atomic rename, owner-
*     only modes, "anything unrecognised reads as not set", a short-TTL read
*     cache, and the §23 one-shot adoption of the pre-profile shared file.
*
* They used to be four copies of each other. Copies drift, and the drift here
* was not hypothetical: the draw and video copies adopted their legacy value
* by writing the whole `{enabled, modelId}` object into the `enabled` FIELD, so
* an inherited switch read back as unset after the next Host start — silently,
* which is the failure shape `doctor.ts` exists to end. The two boolean-only
* copies (provider / AgnesCode) never had it. One factory, four callers: the
* bug class is gone by construction rather than by review.
*
* What is deliberately NOT unified: the on-disk file name, the shape version,
* the model-preference wire key (`drawModelId` vs `videoModelId`), and the
* error wording. Those are the facts that differ between the four, and they
* are passed IN rather than copied — a shared reader that guessed the wrong
* key would answer "no preference" for a file that plainly has one.
*
* Peer-free, like every state module here: no Host peer, pure `node:fs`.
*
* @module dsh-connect-agnes-token-plan/switch-store
*/
/** Normalize an on/off switch: only booleans are real answers. */
function normalizeSwitchEnabled(raw) {
	return typeof raw === "boolean" ? raw : null;
}
/** Normalize a model preference: a non-empty string id, else `null`. */
function normalizeSwitchModelId(raw) {
	return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}
/**
* Build the parser for one switch file's payload.
*
* A matching shape version is what makes a file OURS; every field inside it is
* then normalized separately, so "our file, empty answer" is distinguishable
* from "not our file" — which is exactly the distinction `doctor.ts` draws
* when it names an unreadable state file instead of silently skipping it.
* @param {number} version - this switch's shape version.
* @param {string|null} modelKey - the persisted preference key, or `null`.
* @returns {(raw: unknown) => SwitchValue|null} the parser.
*/
function createSwitchParser(version, modelKey) {
	return (raw) => {
		const source = obj(raw);
		if (source.version !== version) return null;
		return {
			enabled: normalizeSwitchEnabled(source.enabled),
			modelId: modelKey === null ? null : normalizeSwitchModelId(source[modelKey])
		};
	};
}
/**
* The file-backed switch every opt-in shares.
*
* @param {object} spec - what makes this switch different.
* @param {string} spec.file - the state file name, e.g. `"draw.json"`.
* @param {number} spec.version - the payload's shape version.
* @param {string|null} [spec.modelKey] - the model-preference key; `null` for a
*   plain on/off switch (its `modelId()` then always answers `null`).
* @param {{enabled: string, model: string}} spec.messages - the rejection
*   wording, so a bad write names the switch it came from.
* @param {string} [spec.dir] - override the state directory (tests).
* @param {string|null} [spec.profile] - the profile segment; `null` = shared.
* @param {number} [spec.ttlMs] - reuse window for a parsed value.
* @returns {object} the store.
*/
function createSwitchStore(spec) {
	const { file, version, modelKey = null, messages, dir, profile = null, ttlMs = STATE_READ_TTL_MS } = spec;
	const stateDir$1 = dir ?? profileStateDir("dsh-connect-agnes-token-plan", profile);
	const filePath = join(stateDir$1, file);
	const parse = createSwitchParser(version, modelKey);
	/**
	* Write one payload atomically — the single writer for save / forget / the
	* model preference / the §23 adoption, so no caller can invent a fourth
	* spelling of "what this file looks like".
	* @param {SwitchValue|null} body - the two answers to persist.
	* @returns {Promise<void>}
	*/
	const writePayload = async (body) => {
		const payload = {
			version,
			...body.enabled === null ? {} : { enabled: body.enabled },
			...modelKey !== null && body.modelId !== null ? { [modelKey]: body.modelId } : {},
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		const temporary = temporaryOf(stateDir$1, file);
		await ensureStateDir(stateDir$1);
		await writeStateFile(filePath, JSON.stringify(payload, null, 2), { temporary });
	};
	const legacyFile = dir === void 0 && profile ? join(stateDir(name), file) : null;
	const cache = createStateReadCache(async () => parse(await readStateJson(filePath)), {
		ttlMs,
		inheritFrom: legacyFile === null ? null : {
			read: async () => parse(await readStateJson(legacyFile)),
			write: async (value) => {
				await writePayload(value);
			}
		}
	});
	/** The stored record, or two empty answers when there is none. */
	const saved = async () => await cache.read() ?? {
		enabled: null,
		modelId: null
	};
	return {
		/**
		* The saved switch value.
		* @returns {Promise<boolean|null>} `null` = not set, fall back to config.
		*/
		async enabled() {
			return (await saved()).enabled;
		},
		/**
		* The saved model preference.
		* @returns {Promise<string|null>} `null` = not set, fall back to config.
		*/
		async modelId() {
			return (await saved()).modelId;
		},
		/**
		* Whether the panel has ever saved an answer here. A file that exists but
		* carries no answers (post-forget) still reads as "not set".
		* @returns {Promise<boolean>}
		*/
		async isSet() {
			const value = await cache.read();
			return value !== null && (value.enabled !== null || value.modelId !== null);
		},
		/**
		* Persist a switch value. The write is atomic (temp file + rename) so a
		* concurrent reader never sees a partial payload.
		* @param {unknown} value - the new switch state.
		* @returns {Promise<void>}
		*/
		async save(value) {
			const enabled = normalizeSwitchEnabled(value);
			if (enabled === null) throw new TypeError(messages.enabled);
			const next = {
				enabled,
				modelId: (await saved()).modelId
			};
			await writePayload(next);
			cache.remember(next);
		},
		/**
		* Forget the panel-saved switch: the config default rules again.
		* @returns {Promise<void>}
		*/
		async forget() {
			const next = {
				enabled: null,
				modelId: (await saved()).modelId
			};
			await writePayload(next);
			cache.remember(next);
		},
		/**
		* Persist a model preference (the panel's picker). `null` clears it.
		* @param {string|null} value - the preferred catalog id, or null for auto.
		* @returns {Promise<void>}
		*/
		async saveModel(value) {
			if (modelKey === null) throw new Error(`this switch has no model preference (${file})`);
			const modelId = normalizeSwitchModelId(value);
			if (modelId === null && value != null) throw new TypeError(messages.model ?? "a model id is required");
			const next = {
				enabled: (await saved()).enabled,
				modelId
			};
			await writePayload(next);
			cache.remember(next);
		},
		/**
		* Forget the model preference: the config default (usually auto) rules
		* again. The switch itself is left alone.
		* @returns {Promise<void>}
		*/
		async forgetModel() {
			if (modelKey === null) throw new Error(`this switch has no model preference (${file})`);
			const next = {
				enabled: (await saved()).enabled,
				modelId: null
			};
			await writePayload(next);
			cache.remember(next);
		},
		/** The path this switch persists to (diagnostics / doctor). */
		filePath,
		/** The parser `doctor.ts` reuses, so it can never disagree with the store. */
		parse
	};
}

//#endregion
//#region src/host/provider-store.ts
/**
* The provider-registration switch — this plugin's OWN state file, never the
* Host's configuration.
*
* Why a file at all: `registerProvider` in `cordis.patch.yml` is a DEPLOYMENT
* default the operator edits with a reload, but the panel needs a live switch
* that takes effect on the next request. The switch state therefore lives in
* `$DSH_HOME/state/<plugin>/provider.json`, exactly like the draw / video
* switches and the catalog: operational state, not an operator decision baked
* into the patch layer.
*
* Precedence at read time:
*
*   1. a value SAVED FROM THE PANEL (enabled: true|false) always wins;
*   2. no saved value (never touched, or the file was unreadable) falls back
*      to the patch's `registerProvider` — so an operator who enabled the
*      provider through configuration keeps it enabled across this change.
*
* Everything that makes this file a switch — the versioned payload, the temp
* file plus atomic rename, owner-only modes, "anything unrecognised reads as
* not set", the short-TTL read cache and the §23 one-shot legacy adoption —
* lives in `switch-store.ts` now, shared by all four opt-in switches. Only the
* facts that differ are declared here: the file name, the shape version, the
* absence of a model preference, and the rejection wording.
*
* @module dsh-connect-agnes-token-plan/provider-store
*/
/** Shape version, bumped when the persisted form changes incompatibly. */
const PROVIDER_VERSION = 1;
/**
* The parser `doctor.ts` reuses, so its read-only survey can never disagree
* with what this store accepts.
*/
const parseProviderPayload = createSwitchParser(1, null);
/**
* The file-backed provider switch.
* @param {object} [options] - see `switch-store.ts`.
* @returns {object} the store.
*/
function createFileProviderStore(options = {}) {
	const base = createSwitchStore({
		...options,
		file: "provider.json",
		version: 1,
		modelKey: null,
		messages: { enabled: "provider switch expects a boolean" }
	});
	return {
		enabled: base.enabled,
		isSet: base.isSet,
		save: base.save,
		forget: base.forget
	};
}

//#endregion
//#region src/host/draw-store.ts
/**
* The draw-tool switch — this plugin's OWN state file, never the Host's
* configuration.
*
* `drawEnabled` in `cordis.patch.yml` is a DEPLOYMENT default the operator
* edits with a reload, but the panel needs a live switch that takes effect on
* the next request. The state lives in `$DSH_HOME/state/<plugin>/draw.json`,
* exactly like the video switch, the provider switch and the catalog:
* operational state, not an operator decision baked into the patch layer.
*
* Precedence at read time:
*
*   1. a value SAVED FROM THE PANEL (enabled: true|false) always wins;
*   2. no saved value (never touched, or the file was unreadable) falls back
*      to the patch's `drawEnabled` — so an operator who enabled drawing
*      through configuration keeps it enabled across this change.
*
* The switch and the model preference share one file because they are one
* operator decision ("how this profile draws"), and a single read keeps them
* from drifting apart.
*
* The write / read / adoption machinery is shared with the other three opt-in
* switches in `switch-store.ts`; what is declared here is only the file name,
* the shape version, the preference's WIRE KEY (which the video switch spells
* differently, and which a shared parser must never guess at), and the
* rejection wording.
*
* @module dsh-connect-agnes-token-plan/draw-store
*/
/** Shape version, bumped when the persisted form changes incompatibly. */
const DRAW_STORE_VERSION = 1;
/**
* The parser `doctor.ts` reuses, so its read-only survey can never disagree
* with what this store accepts.
*/
const parseDrawPayload = createSwitchParser(1, "drawModelId");
/**
* The file-backed draw switch.
* @param {object} [options] - see `switch-store.ts`.
* @returns {object} the store.
*/
function createFileDrawStore(options = {}) {
	return createSwitchStore({
		...options,
		file: "draw.json",
		version: 1,
		modelKey: "drawModelId",
		messages: {
			enabled: "draw switch expects a boolean",
			model: "draw model expects a non-empty string or null"
		}
	});
}

//#endregion
//#region src/host/video-store.ts
/**
* The video-tool switch — this plugin's OWN state file, never the Host's
* configuration.
*
* A deliberate sibling of `draw-store.ts`, and separate from it on purpose: the
* two tools are independent opt-ins. Wanting image generation without video (or
* the reverse) is an ordinary preference, and one shared switch would force
* both on together.
*
* `videoEnabled` in `cordis.patch.yml` is a DEPLOYMENT default the operator
* edits with a reload, but the panel needs a live switch that takes effect on
* the next request. The state lives in `$DSH_HOME/state/<plugin>/video.json`,
* exactly like the draw switch, the provider switch and the catalog:
* operational state, not an operator decision baked into the patch layer.
*
* Precedence at read time:
*
*   1. a value SAVED FROM THE PANEL (enabled: true|false) always wins;
*   2. no saved value (never touched, or the file was unreadable) falls back
*      to the patch's `videoEnabled`.
*
* Everything but the facts below is shared with the other three opt-in switches
* in `switch-store.ts`. The WIRE KEY is the one that matters: this file spells
* the preference `videoModelId`, the draw file spells it `drawModelId`, and a
* parser that guessed would answer "no preference" for a file that plainly has
* one — silently.
*
* @module dsh-connect-agnes-token-plan/video-store
*/
/** Shape version, bumped when the persisted form changes incompatibly. */
const VIDEO_STORE_VERSION = 1;
/**
* The parser `doctor.ts` reuses, so its read-only survey can never disagree
* with what this store accepts.
*/
const parseVideoPayload = createSwitchParser(1, "videoModelId");
/**
* The file-backed video switch.
* @param {object} [options] - see `switch-store.ts`.
* @returns {object} the store.
*/
function createFileVideoStore(options = {}) {
	return createSwitchStore({
		...options,
		file: "video.json",
		version: 1,
		modelKey: "videoModelId",
		messages: {
			enabled: "video switch expects a boolean",
			model: "video model expects a non-empty string or null"
		}
	});
}

//#endregion
//#region src/host/api-key-store.ts
/**
* The Agnes inference API key (`sk-…` free tier, or `cpk-…` Token Plan) store — the credential behind the
* directly-registered LLM provider and the `/v1/models` catalog.
*
* It is the SAME reference-value mechanism the console account uses
* (`token-store.ts`): the key is not a new credentials record KIND (the
* service admits only `grant` / `api-key`, and a private kind makes the whole
* credentials document unparseable and takes the Host down). It is stored as a
* credential REFERENCE named `AGNES_TOKEN_PLAN_API_KEY` — owner-only in
* `~/.dsh/.credentials.yaml` — and the raw process environment stays honored
* as a fallback, so an existing `$DSH_HOME/.env` setup keeps working untouched.
*
* Precedence, per read: the credentials service (a value typed into the panel
* must win without a restart), then this process's memory (a Host with no
* credentials service), then the environment.
*
* @module dsh-connect-agnes-token-plan/api-key-store
*/
/**
* The reference name the key is stored under.
*
* The hand-written `llm-pi-ai` provider resolves the same `apiKeyEnv` name, so
* a key this panel saves lights that provider too — one stored value, both
* routes.
*/
const API_KEY_REF = "AGNES_TOKEN_PLAN_API_KEY";
/**
* Every place a key can come from, in precedence order.
*
* The panel labels the source with `tt(\`llm.src.${keySource}\`)`, so the
* `llm.src.*` dictionary keys are a mirror of this list and
* `test/render.test.mjs` pins the two sets against each other in BOTH
* directions. Before that pin the union lived only in a JSDoc comment and three
* `return` statements: a fourth source would have rendered as the raw key
* `llm.src.<name>`, and the client's `|| String(keySource)` fallback could not
* catch it — the client's own `tt` returns the key it was handed, which is a
* non-empty string.
*
* `null` is not a member: it means "no key at all", which the panel renders
* with its own line (`llm.noKey`) rather than a source label.
*/
const API_KEY_SOURCES = Object.freeze([
	"credentials",
	"memory",
	"env"
]);
/**
* Build the API-key store.
* @param {object} [options] - wiring.
* @param {object|Function|null} [options.credentials] - the `ctx.credentials`
*   service, a resolver, or `null`. Resolved on EVERY use, like token-store:
*   the service may register after this plugin mounts.
* @param {object} [options.env] - environment source; defaults to `process.env`.
* @returns {{save: Function, forget: Function, resolve: Function, state: Function}}
*/
function createApiKeyStore({ credentials = null, env = process.env } = {}) {
	/** Fallback vault for a Host that has no credentials service. */
	const memory = /* @__PURE__ */ new Map();
	const resolveService = () => {
		return (typeof credentials === "function" ? credentials() : credentials) ?? null;
	};
	return {
		/**
		* Persist a typed-in key as the `AGNES_TOKEN_PLAN_API_KEY` reference.
		*
		* The value is stored verbatim (no trim): like the console password,
		* trimming an invisible character is a change the user cannot see. A
		* whitespace-only value is still "nothing entered".
		* @param {string} apiKey - the key.
		* @returns {Promise<void>}
		*/
		async save(apiKey) {
			const value = verbatim(apiKey, "");
			if (typeof value !== "string" || value.trim() === "") throw new Error("an API key is required");
			const service = resolveService();
			if (service !== null && typeof service.set === "function") {
				await service.set(API_KEY_REF, value);
				memory.set(API_KEY_REF, value);
			} else memory.set(API_KEY_REF, value);
		},
		/**
		* Forget the stored key. The environment fallback is NOT touched: clearing
		* a panel-saved reference must not delete an operator's `.env` setting.
		* Both the service reference and the in-memory copy are cleared, so a key
		* saved on a Host without the service disappears too.
		* @returns {Promise<void>}
		*/
		async forget() {
			memory.delete(API_KEY_REF);
			try {
				const service = resolveService();
				if (service !== null && typeof service.unset === "function") await service.unset(API_KEY_REF);
			} catch {}
		},
		/**
		* Resolve the live key and where it came from.
		* @returns {Promise<{value: string, source: ("credentials"|"memory"|"env"|null)}>}
		*/
		async resolve() {
			try {
				const service = resolveService();
				if (service !== null && typeof service.resolve === "function") {
					const resolved = await service.resolve(API_KEY_REF).catch(() => void 0);
					const value = verbatim(resolved?.value, "");
					if (typeof value === "string" && value.trim() !== "") return {
						value,
						source: "credentials"
					};
				}
			} catch {}
			const held = memory.get(API_KEY_REF);
			if (typeof held === "string" && held.trim() !== "") return {
				value: held,
				source: "memory"
			};
			const fromEnv = verbatim(env[API_KEY_REF], "");
			if (typeof fromEnv === "string" && fromEnv.trim() !== "") return {
				value: fromEnv,
				source: "env"
			};
			return {
				value: "",
				source: null
			};
		},
		/**
		* The secret-free description the routes and panel report.
		*
		* `ephemeral` mirrors token-store: true when this Host has no credentials
		* service, so a key the panel saved would not survive a restart. A key read
		* from the environment is still reported with its real source.
		* @returns {Promise<{hasApiKey: boolean, keySource: string|null, ephemeral: boolean}>}
		*/
		async state() {
			const { source } = await this.resolve();
			return {
				hasApiKey: source !== null,
				keySource: source,
				ephemeral: resolveService() === null
			};
		}
	};
}

//#endregion
//#region src/host/agnescode-store.ts
/**
* The AgnesCode credential store — the DSH credentials-service half of the
* third upstream provider (ROADMAP §6.3).
*
* Same reference-value mechanism: the whole credential is ONE JSON
* reference value in the owner-only `~/.dsh/.credentials.yaml`
* (`AGNESCODE_CREDENTIAL`), never in this plugin's directory, git, or logs;
* a private record KIND is NOT invented (red line 2). The stores are
* deliberately SEPARATE publishers of
* separate upstreams (§5.5 isolation) — sharing a reference name or a record
* would couple two credential lifecycles that must not move together.
*
* The load-bearing difference from the Token Plan store: AgnesCode has NO
* plugin-callable refresh endpoint (probed + reference-repo read, ROADMAP
* §6.3) — the desktop App refreshes its own session file, so "renew" here
* means RE-HARVEST the local file and `save` the result. The store therefore
* has no network method at all; the route owns the harvest-then-save walk.
*
* Precedence per read: the credentials service, then this process's memory (a
* Host with no credentials service → `ephemeral`, mirroring `token-store`).
*
* @module dsh-connect-agnes-token-plan/agnescode-store
*/
/** The reference name the credential is stored under. */
const AGNESCODE_CREDENTIAL_REF = "AGNESCODE_CREDENTIAL";
/**
* Parse the stored credential JSON; a malformed or absent value reads as no
* credential rather than an error — the safe direction (one re-harvest, never
* a crash).
* @param {unknown} value - the reference value.
* @returns {object|null} `{ accessToken, bffBase, userId, nickname, expiresAtMs? }` or `null`.
*/
function parseAgnescodeCredential(value) {
	if (typeof value !== "string" || value.trim() === "") return null;
	let parsed;
	try {
		parsed = JSON.parse(value);
	} catch {
		return null;
	}
	const source = obj(parsed);
	const accessToken = str(source.access_token, "");
	const bffBase = trustAgnescodeBffBase(source.bff_public_base_url);
	if (accessToken === "" || bffBase === null) return null;
	const expiresAtMs = decodeAgnescodeJwtExpMs(accessToken) ?? (typeof source.expires_at_ms === "number" ? source.expires_at_ms : void 0);
	return {
		accessToken,
		bffBase,
		userId: str(source.user_id, ""),
		nickname: str(source.nickname, ""),
		...expiresAtMs !== void 0 ? { expiresAtMs } : {}
	};
}
/**
* Serialize one credential for storage.
* @param {object} credential - `{ accessToken, bffBase, userId?, nickname?, expiresAtMs? }`.
* @returns {string} the JSON document.
*/
function serializeAgnescodeCredential(credential) {
	const source = obj(credential);
	return JSON.stringify({
		version: 1,
		access_token: str(source.accessToken, ""),
		bff_public_base_url: str(source.bffBase, ""),
		...str(source.userId, "") !== "" ? { user_id: source.userId } : {},
		...str(source.nickname, "") !== "" ? { nickname: source.nickname } : {},
		...typeof source.expiresAtMs === "number" ? { expires_at_ms: source.expiresAtMs } : {}
	});
}
/**
* Build the credential store.
* @param {object} [options] - wiring.
* @param {object|Function|null} [options.credentials] - the `ctx.credentials`
*   service, a resolver, or `null` (resolved on EVERY use, like `api-key-store`).
* @returns {{save, forget, resolve, isExpired, state}}
*/
function createAgnescodeStore({ credentials = null } = {}) {
	/** Fallback vault for a Host that has no credentials service. */
	const memory = /* @__PURE__ */ new Map();
	const resolveService = () => {
		return (typeof credentials === "function" ? credentials() : credentials) ?? null;
	};
	const storeNow = async (credential) => {
		const serialized = serializeAgnescodeCredential(credential);
		const service = resolveService();
		if (service !== null && typeof service.set === "function") await service.set(AGNESCODE_CREDENTIAL_REF, serialized);
		memory.set(AGNESCODE_CREDENTIAL_REF, serialized);
	};
	return {
		/**
		* Persist a freshly-harvested credential. Requires both halves: a token
		* without its per-account base cannot serve a request (the base decides
		* WHERE the token goes), so a base-less save is a type error, not a
		* degraded entry.
		* @param {object} credential - `{ accessToken, bffBase, userId?, nickname?, expiresAtMs? }`.
		*/
		async save(credential) {
			const accessToken = str(credential?.accessToken, "");
			const bffBase = trustAgnescodeBffBase(credential?.bffBase);
			if (accessToken === "") throw new Error("an AgnesCode access token is required");
			if (bffBase === null) throw new Error("an AgnesCode BFF base is required");
			await storeNow({
				...credential,
				bffBase
			});
		},
		/** Forget the stored credential (the panel's「解除关联」). */
		async forget() {
			memory.delete(AGNESCODE_CREDENTIAL_REF);
			try {
				const service = resolveService();
				if (service !== null && typeof service.unset === "function") await service.unset(AGNESCODE_CREDENTIAL_REF);
			} catch {}
		},
		/**
		* Resolve the live credential and where it came from.
		* @returns {Promise<{credential: object|null, source: ("credentials"|"memory"|null)}>}
		*/
		async resolve() {
			try {
				const service = resolveService();
				if (service !== null && typeof service.resolve === "function") {
					const credential = parseAgnescodeCredential((await service.resolve(AGNESCODE_CREDENTIAL_REF).catch(() => void 0))?.value);
					if (credential !== null) return {
						credential,
						source: "credentials"
					};
				}
			} catch {}
			const held = parseAgnescodeCredential(memory.get(AGNESCODE_CREDENTIAL_REF));
			if (held !== null) return {
				credential: held,
				source: "memory"
			};
			return {
				credential: null,
				source: null
			};
		},
		/**
		* Whether the stored credential is within its expiry window. A credential
		* without a decodable `exp` reads as unexpired (it may still be dead
		* server-side; the request path surfaces that) — the same direction
		* the sibling upstream store takes.
		* @param {number} [leadMs] - renew this long before expiry; defaults to 5 min.
		*/
		async isExpired(leadMs = 3e5) {
			const { credential } = await this.resolve();
			if (credential === null) return true;
			if (credential.expiresAtMs === void 0) return false;
			return Date.now() >= credential.expiresAtMs - leadMs;
		},
		/**
		* The secret-free description the routes and panel report.
		* @returns {Promise<{hasCredential: boolean, source: ("credentials"|"memory"|null), ephemeral: boolean, nickname: string, bffBase: string, expiresAtMs: number|null}>}
		*/
		async state() {
			const { credential, source } = await this.resolve();
			return {
				hasCredential: credential !== null,
				source,
				ephemeral: resolveService() === null,
				nickname: credential?.nickname ?? "",
				bffBase: credential?.bffBase ?? "",
				expiresAtMs: credential?.expiresAtMs ?? null
			};
		}
	};
}

//#endregion
//#region src/host/agnescode-switch-store.ts
/**
* The AgnesCode provider-registration switch — this plugin's OWN state file,
* a separate opt-in switch (after `provider-store.ts`). Same integrity
* discipline: a versioned payload, temp file plus atomic rename, and
* "anything unrecognised reads as not set" (PITFALLS §23, per-profile
* segment). Deliberately a SEPARATE file, not a shared
* one: flipping one provider's switch must never touch another's publish
* decision (§5.5 isolation).
*
* The switch machinery is shared with the other three opt-in switches in
* `switch-store.ts`; this module declares only what makes this file its own:
* the name, the shape version, the absence of a model preference, and the
* rejection wording.
*
* @module dsh-connect-agnes-token-plan/agnescode-switch-store
*/
/** Shape version, bumped when the persisted form changes incompatibly. */
const AGNESCODE_SWITCH_VERSION = 1;
/**
* The parser `doctor.ts` reuses, so its read-only survey can never disagree
* with what this store accepts.
*/
const parseAgnescodePayload = createSwitchParser(1, null);
/**
* The file-backed AgnesCode provider switch.
* @param {object} [options] - see `switch-store.ts`.
* @returns {object} the store.
*/
function createFileAgnescodeStore(options = {}) {
	const base = createSwitchStore({
		...options,
		file: "agnescode-provider.json",
		version: 1,
		modelKey: null,
		messages: { enabled: "the agnescode switch expects a boolean" }
	});
	return {
		enabled: base.enabled,
		isSet: base.isSet,
		save: base.save,
		forget: base.forget
	};
}

//#endregion
//#region src/host/agnescode-models-store.ts
/**
* The AgnesCode model allow-list — this plugin's OWN state file, per-profile
* (PITFALLS §23 segment), separate from the Token Plan catalogue's
* `enabledModelIds` so the two providers' curation can never cross-talk.
*
* Same integrity discipline as `switch-store.ts`: a versioned payload, temp
* file plus atomic rename, owner-only modes, a short-TTL read cache, and
* "anything unrecognised reads as no curation".
*
* The EMPTY list is the load-bearing default: no file (or an empty list) means
* "no filter — push every AgnesCode model", the WorkBuddy convention the
* Token Plan side already uses. Only a NON-empty list curates. That keeps a
* fresh install (and any user who never opened this roster) on the old
* behaviour — nothing is silently taken away.
*
* @module dsh-connect-agnes-token-plan/agnescode-models-store
*/
/** Shape version, bumped when the persisted form changes incompatibly. */
const AGNESCODE_MODELS_VERSION = 1;
/** Ceiling on a curated AgnesCode list (the Token Plan side caps at 500). */
const MAX_AGNESCODE_ENABLED_MODELS = 200;
/**
* Parse a persisted AgnesCode allow-list payload.
*
* A matching shape version is what makes a file OURS; the ids are then
* normalized, so a junk entry is dropped rather than stored. `null` as a WHOLE
* value means "not our file / unreadable" — which reads as no curation.
* @param {unknown} raw - the persisted payload.
* @returns {{enabledModelIds: string[]}|null} the parsed allow-list.
*/
function parseAgnescodeModelsPayload(raw) {
	const source = obj(raw);
	if (source.version !== 1) return null;
	return { enabledModelIds: normalizeEnabledIds(source.enabledModelIds) };
}
/**
* The file-backed AgnesCode model allow-list.
* @param {object} [options] - `StoreOptions`.
* @returns {object} the store.
*/
function createFileAgnescodeModelsStore(options = {}) {
	const { dir, profile = null, ttlMs = STATE_READ_TTL_MS } = options;
	const stateDir = dir ?? profileStateDir("dsh-connect-agnes-token-plan", profile);
	const fileName = "agnescode-models.json";
	const filePath = join(stateDir, fileName);
	const parse = parseAgnescodeModelsPayload;
	/**
	* Write one payload atomically — the single writer for save, so no caller can
	* invent a second spelling of what this file looks like.
	* @param {{enabledModelIds: string[]}} body - the allow-list to persist.
	* @returns {Promise<void>}
	*/
	const writePayload = async (body) => {
		const payload = {
			version: 1,
			enabledModelIds: body.enabledModelIds,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		const temporary = temporaryOf(stateDir, fileName);
		await ensureStateDir(stateDir);
		await writeStateFile(filePath, JSON.stringify(payload, null, 2), { temporary });
	};
	const cache = createStateReadCache(async () => parse(await readStateJson(filePath)), { ttlMs });
	return {
		/**
		* The curated ids. EMPTY means "no filter" — the roster is pushed whole.
		* @returns {Promise<string[]>} unique ids in first-seen order.
		*/
		async listEnabledIds() {
			return (await cache.read())?.enabledModelIds ?? [];
		},
		/**
		* Persist the allow-list. Empty clears curation (push everything again).
		* @param {unknown} raw - the posted id list.
		* @returns {Promise<void>}
		*/
		async save(raw) {
			const ids = normalizeEnabledIds(raw);
			if (ids.length > 200) throw new TypeError(`enabledModelIds is too long (max ${200})`);
			await writePayload({ enabledModelIds: ids });
			cache.remember({ enabledModelIds: ids });
		},
		/** The path this store persists to (diagnostics / doctor). */
		filePath,
		/** The parser `doctor.ts` reuses, so it can never disagree with the store. */
		parse
	};
}

//#endregion
//#region src/host/switch-precedence.ts
/**
* The one place that decides "which value is in charge" for an opt-in switch.
*
* Every opt-in in this plugin answers the same question from two places — the
* value the operator saved in the panel (`switch-store`) and the value the
* patch declares (`Settings`) — and every consumer needs not just the answer
* but also WHERE it came from, because the panel prints that as "面板 / 配置"
* and an answer without its source is a line the operator cannot act on.
*
* That question was previously re-answered at eleven call sites, in two
* dialects that look alike and mean different things:
*
*   A. `(panel ?? settings.x) === true`  — 有配置默认（provider / draw / video）
*   B. `panel === true`                  — 无配置默认（agnescode：它根本没有
*                                          配置默认值，面板说关就是关）
*
* The two are easy to confuse by eye, and confusing them is not cosmetic:
* reading B as A would make AgnesCode register itself whenever the patch's
* (nonexistent) default happened to be truthy. So both live here, as one
* function whose `configDefault` argument carries the distinction — B is A
* with no default, not a separate rule.
*
* @module dsh-connect-agnes-token-plan/switch-precedence
*/
/** Where an effective switch value came from. The panel prints these verbatim. */
const SWITCH_SOURCE = {
	/** The operator saved a value in the panel; it wins. */
	PANEL: "panel",
	/** Nothing is saved, so the patch's declared default is in charge. */
	CONFIG: "config",
	/** Nothing is saved and this switch has no config default — it is simply off. */
	OFF: "off"
};
/**
* Resolve the effective value of a boolean switch.
*
* @param {boolean|null|undefined} panelValue - the panel-saved value
*   (`null` / `undefined` = the operator has not set it).
* @param {boolean|undefined} configDefault - the patch's default. Pass
*   `undefined` for a switch that has NO config default (AgnesCode): then an
*   unset panel value resolves to `off`, never to a value nobody declared.
* @returns {{enabled: boolean, source: string}} the effective value and
*   where it came from — both, because a value without its source is an
*   unactionable line on the panel.
*/
function resolveSwitchEnabled(panelValue, configDefault) {
	if (typeof panelValue === "boolean") return {
		enabled: panelValue === true,
		source: SWITCH_SOURCE.PANEL
	};
	if (typeof configDefault !== "boolean") return {
		enabled: false,
		source: SWITCH_SOURCE.OFF
	};
	return {
		enabled: configDefault === true,
		source: SWITCH_SOURCE.CONFIG
	};
}
/**
* Resolve the effective value of a non-boolean switch preference (a model id).
*
* Separate from {@link resolveSwitchEnabled} because "unset" is a different
* sentinel for each: an unset model preference is `null`, while `""` is a real
* value meaning "auto-pick from the catalog" — collapsing the two would turn
* "operator asked for auto" into "operator never set it".
*
* @param {string|null|undefined} panelValue - the panel-saved preference.
* @param {string} configDefault - the patch's default (`""` = auto).
* @returns {{value: string, source: string}}
*/
function resolveSwitchValue(panelValue, configDefault) {
	if (typeof panelValue === "string") return {
		value: panelValue,
		source: SWITCH_SOURCE.PANEL
	};
	return {
		value: configDefault,
		source: SWITCH_SOURCE.CONFIG
	};
}
/**
* Read a panel-saved value once, tolerating every way "not available" shows up.
*
* The previous idiom — `(store ? store.enabled() : null).catch(() => null)` —
* is a trap: when `store` is absent the expression is the literal `null`, and
* `null.catch(...)` throws `TypeError` instead of answering `null`. It only
* ever worked because no current caller passes an absent store; one new caller
* that does would turn a missing store into a 500.
*
* @template T
* @param {undefined|null|Function} read - `() => Promise<T>`; anything
*   else is treated as "no store".
* @returns {Promise<T|null>} the value, or `null` when unreadable.
*/
async function readPanelValue(read) {
	if (typeof read !== "function") return null;
	try {
		const value = await read();
		return value === void 0 ? null : value;
	} catch {
		return null;
	}
}

//#endregion
//#region src/host/publish-core.ts
/**
* The shared bones of a provider publisher — the parts that MUST NOT differ
* between upstreams, factored out so they cannot drift.
*
* Both publishers (`provider-publish.ts` for the Token Plan provider,
* `agnescode-publish.ts` for the desktop-app upstream) run the same control
* plane: a publish queue, a `disposed` gate, and a single-point pair
* registration that doubles as the rollback path. Those three are load-bearing
* and pinned by tests (PITFALLS §18 for the queue, §19 for the register shape)
* — and the rollback is the worst place to discover a divergence, because it
* only runs once something has already failed. They used to be written twice,
* with `agnescode-publish.ts` saying its semantics were "restated" — which is
* the honest word for copied — and keeping the copies in sync relied on
* comments in one file pointing at the other. Here there is one copy.
*
* What is deliberately NOT shared: the publish GATE and the state shape. The
* Token Plan side decides from "switch on?" plus a persisted catalog and an
* allow-list, and restores `entries`/`enabledIds`/quota ids on a rollback; the
* AgnesCode side decides from "switch on?" plus "is there a harvested
* credential?" plus that credential's per-account BFF base, and restores its
* roster and base. That difference is real domain difference, and folding it
* into one parameterized state machine would make a publish unreadable —
* every reader would have to read the configuration to know what one does.
*
* Peer-free: touches no runtime peer, only `host-config.ts` and `util.ts`, so
* the offline suites drive every branch with fakes.
*
* @module dsh-connect-agnes-token-plan/publish-core
*/
/** The event a successful (re)registration emits so readers refresh. */
const ADAPTERS_UPDATED_EVENT = "llm/adapters-updated";
/** The error a publisher reports when the Host exposes no `llm` service. */
const NO_LLM_SERVICE_ERROR = "the Host exposes no llm registration service";
/** The shape check both publishers raise on a bad factory result. */
const BAD_FACTORY_SHAPE_ERROR = "the adapter factory did not return { adapter, providerIds }";
/**
* A publish queue: every publish runs after all the ones in flight.
*
* Concurrent publishes are not hypothetical — a mount seed can still be
* mid-flight when the first panel poll publishes the catalog it just fetched,
* and a switch flip or a forget can land on top of either. Two publishes
* interleaving means the SLOWER one wins: it releases the pair the faster one
* registered and then registers its own, so the Host serves a stale (possibly
* empty) set while the snapshot reports the fresh one (PITFALLS §18).
*
* The chain is the same shape `token-store.ts` uses for `getToken`: no lock
* object, and a rejected link never poisons the ones behind it.
* @returns {PublishQueue} the queue and the disposal gate.
*/
function createPublishQueue() {
	let publishChain = Promise.resolve();
	let disposed = false;
	return {
		enqueue(task) {
			const queued = publishChain.then(task, task);
			publishChain = queued.then(() => void 0, () => void 0);
			return queued;
		},
		isDisposed: () => disposed,
		dispose() {
			disposed = true;
		}
	};
}
/**
* Build the releaser for one publisher's `state`.
*
* Releases are idempotent in the Host, and a release that throws must not
* abort the one behind it — during shutdown or a rollback the service may
* already be gone.
* @param {PublisherState} state - the publisher state holding the release functions.
* @returns {() => void} release, safe to call any number of times.
*/
function createPairReleaser(state) {
	return () => {
		const releaseFn = (fn) => {
			try {
				fn?.();
			} catch {}
		};
		releaseFn(state.releaseAdapter);
		releaseFn(state.releaseDirectory);
		state.releaseAdapter = null;
		state.releaseDirectory = null;
	};
}
/**
* Hand one built adapter to the `llm` service and record its release
* functions onto `target`.
*
* Defined ONCE because the publish path and the rollback path both register a
* pair, and two copies drift: a change to the directory row made in one place
* and not the other leaves the ROLLBACK registering a provider the publish
* path would never have built — and a rollback only runs once something has
* already gone wrong, which is the worst possible moment to find out
* (PITFALLS §19).
*
* The releases are written straight onto `target` rather than returned: if the
* directory call throws AFTER the adapter was registered, the adapter's
* release must still be reachable, or `release()` cannot undo it and the
* adapter outlives the plugin.
* @param {object} llm - the registration service (peer-typed: loose).
* @param {BuiltAdapter} built - what to register.
* @param {PublisherState} target - where the release functions are recorded.
* @param {ProviderIdentity} identity - the provider's row on the models settings page.
* @returns {void}
*/
function registerProviderPair(llm, built, target, { providerId, displayName }) {
	target.releaseAdapter = llm.registerAdapter(built.providerIds, built.adapter);
	target.releaseDirectory = typeof llm.registerConfigurableProviders === "function" ? llm.registerConfigurableProviders([{
		provider: providerId,
		displayName,
		settingsNs: name,
		settingsPath: [],
		declared: false
	}]) : null;
}
/**
* Memoize the peer-dependent adapter factory for one publisher.
*
* The module is loaded once and the factory is read off it once, so a Host
* whose peers resolve slowly pays that cost one time, not per publish.
* @param {() => Promise<unknown>} loadModule - resolves the adapter module.
* @param {string} exportName - the factory export to read off the module.
* @returns {() => Promise<any>} the memoized factory resolver.
*/
function createAdapterFactoryResolver(loadModule, exportName) {
	let adapterFactoryPromise;
	return async () => {
		if (adapterFactoryPromise === void 0) adapterFactoryPromise = Promise.resolve(loadModule()).then((mod) => mod?.[exportName]);
		return adapterFactoryPromise;
	};
}
/**
* Verify a built adapter is really one before it is registered Host-wide.
*
* An adapter is registered Host-wide, so a factory that returns anything else
* must fail here rather than publish a provider that cannot serve a request.
* @param {unknown} built - what the factory returned.
* @returns {boolean} whether it is `{ adapter, providerIds }`.
*/
function isBuiltAdapter(built) {
	return built !== null && typeof built === "object" && Array.isArray(built.providerIds) && built.adapter !== void 0;
}
/**
* Turn a build failure into a secret-free note plus a hint.
*
* A credential never reaches the panel or a log. The failure a reader cannot
* diagnose from the message alone: the llm peer packages ship INSIDE the Host,
* so a plugin directory the Host's `node_modules` cannot be reached from — a
* dev checkout symlinked into the profile, say — has no way to import them.
* Say so, with the remedy, because the panel can only report "provider absent".
* @param {unknown} error - the thrown value (may not be an Error at all).
* @returns {DescribedBuildFailure} the redacted message, the optional remedy
*   suffix, and the original value for re-raising.
*/
function describeBuildFailure(error) {
	const why = error instanceof Error ? error.message : String(error);
	return {
		note: redactSecrets(why),
		hint: error?.code === "ERR_MODULE_NOT_FOUND" ? " — the llm peer packages ship with the Host; install this plugin where they resolve (or link them into its own node_modules)" : "",
		error
	};
}
/**
* Log one build failure the way both publishers log it.
* @param {PublisherLogger} [logger] - `ctx.logger`.
* @param {string} label - the upstream's name for the message ("Agnes").
* @param {DescribedBuildFailure} described - from `describeBuildFailure`.
* @returns {void}
*/
function warnBuildFailure(logger, label, described) {
	logger?.warn?.(`${name}: cannot build the ${label} adapter: ${described.note}${described.hint}`);
}
/**
* Resolve the `llm` registration service, or bail out with the pair released.
*
* Both upstreams answer the same question the same way, and the answer is a
* fact about the Host — not about the provider — so it is one copy: a Host
* with no `llm` service gets no registration and a stated reason, never a
* half-built one.
*
* The teardown goes through `unregister` rather than a bare `release()`, which
* (also) clears `state.built`. That matters more here than anywhere else: the
* Host losing its `llm` service is exactly the moment the previous pair's
* release has been called, so leaving a stale `built` behind hands the NEXT
* publish a rollback target that is already dead.
* @param {object} job
* @param {PublisherState} job.state - the publisher state.
* @param {(service: string) => any} job.getLlm - the service resolver.
* @param {() => void} job.release - the publisher's releaser.
* @returns {any} the service, or null when it cannot register.
*/
function resolveRegistrationService({ state, getLlm, release }) {
	const llm = getLlm("llm");
	state.llmAvailable = llm !== null && typeof llm.registerAdapter === "function";
	if (!state.llmAvailable) {
		unregister({
			state,
			release,
			error: NO_LLM_SERVICE_ERROR
		});
		return null;
	}
	return llm;
}
/**
* Take the registration down and record why it is gone.
*
* `state.built` is cleared along with it, and that matters: a stale `built`
* survives into the NEXT publish as its rollback target, so a later failed
* publish would re-register an adapter whose release has already been called.
* That is why every "there must be no registration" branch routes through
* here — switch off, credential gone, and (through
* `resolveRegistrationService`) no `llm` service at all.
* @param {object} job
* @param {PublisherState} job.state - the publisher state.
* @param {() => void} job.release - the publisher's releaser.
* @param {string|null} [job.error] - why nothing is registered; null when the
*   absence is the wanted state (switch off).
* @returns {{ok: boolean, skipped: boolean}} the publish outcome.
*/
function unregister({ state, release, error = null }) {
	release();
	state.registered = false;
	state.built = null;
	state.error = error;
	return {
		ok: true,
		skipped: true
	};
}
/**
* Swap the registered pair: take down the old one, register the new one, and
* restore the OLD one if the new registration throws.
*
* This is the other half of PITFALLS §19, and the reason it is shared: the
* rollback is the path that only runs once something has already gone wrong.
* A registration that fails AFTER the old pair was released must put the
* previous one back, or a bad publish takes down models that were already
* serving. Written twice, the two copies drift; written once, a fix to the
* rollback reaches both upstreams.
* @param {SwapRegistrationJob} job - see the interface.
* @returns {{ok: boolean, error?: unknown}} the publish outcome.
*/
function swapRegistration({ llm, built, previousBuilt, state, release, registerPair, emit, onRollback }) {
	release();
	try {
		registerPair(llm, built, state);
	} catch (error) {
		release();
		state.built = null;
		onRollback?.();
		state.error = redactSecrets(error instanceof Error ? error.message : String(error));
		if (previousBuilt !== null) try {
			registerPair(llm, previousBuilt, state);
			state.built = previousBuilt;
			state.registered = true;
		} catch {
			state.built = null;
			state.registered = false;
		}
		else state.registered = false;
		return {
			ok: false,
			error
		};
	}
	state.built = built;
	state.registered = true;
	state.error = null;
	emitAdaptersUpdated(emit);
	return { ok: true };
}
/**
* Emit the adapter-update event, tolerating a Host that refuses it.
*
* A Host that refuses the event still has the registration; readers refresh on
* their own cadence.
* @param {(event: string) => void} emit - `ctx.emit`.
* @returns {void}
*/
function emitAdaptersUpdated(emit) {
	try {
		emit(ADAPTERS_UPDATED_EVENT);
	} catch {}
}

//#endregion
//#region src/host/agnescode-publish.ts
/**
* The AgnesCode provider's PUBLISH STATE MACHINE — the peer-free control plane
* of the third upstream provider (ROADMAP §6.3).
*
* Deliberate BOUNDARY: this is an independent publisher. It shares NONE of the
* Token Plan publisher's STATE (`provider-publish.ts`) — an AgnesCode switch
* flip, re-harvest, or catalogue drift can never register, release, or churn
* the Token Plan provider (§5.5 isolation). What it does share is the
* MECHANISM: the publish chain, the `disposed` gate and the single-point
* `registerPair` live in `publish-core.ts`, one copy for both publishers.
* Isolation is about separate state instances, not about duplicated code —
* and this file used to say its semantics were "restated", which is the
* honest word for copied (and how its "no credential" branch drifted into
* leaving a stale `built` behind).
*
* The difference that shapes the publish: the offered set is driven by THREE
* facts — "is the switch on?", "is there a (harvested) credential?", and the
* credential's per-account BFF base — and a re-harvest that lands on another
* base rebuilds. That rebuild is the CALLER's decision: `agnescode-lifecycle`
* compares the harvested base against `state.bffBase` and re-publishes. No
* offered-set signature is kept here, unlike the Token Plan publisher — whose
* caller polls a catalogue that changes without ever calling in, so it needs
* something to compare. Here every publish is already an explicit call that
* carries the roster, so a signature would be written and never read.
*
* Peer-free: the adapter factory is injected (`loadAdapterModule`, defaulting
* to `import("./agnescode-llm-adapter.ts")`), so the offline suites substitute
* a fake factory without touching the Host's node_modules.
*
* @module dsh-connect-agnes-token-plan/agnescode-publish
*/
/**
* The AgnesCode provider publisher.
*
* @param {object} [deps]
* @param {() => Promise<boolean|null>} [deps.panelSwitch] - the panel-saved
*   value (`agnescode-switch-store.enabled()`); `null` when the state file is
*   untouched (in which case the provider stays off — opt-in default OFF).
* @param {() => Promise<string>} [deps.resolveToken] - resolves the live
*   AgnesCode JWT per request (`agnescode-store` seam); empty when no
*   credential has been harvested.
* @param {(service: string) => object|null} [deps.getLlm] - optional-service
*   resolver for the `llm` registration service.
* @param {() => Promise<{createAgnescodeAdapter: Function}>} [deps.loadAdapterModule] -
*   the peer-dependent adapter factory module; defaults to the real
*   `agnescode-llm-adapter.ts`.
* @param {(event: string) => void} [deps.emit] - `ctx.emit` for the adapter
*   update event.
* @param {object} [deps.logger] - `ctx.logger` for the build-failure warning.
* @returns {{
*   state: object,
*   publish: (rows: object[], bffBase: string) => Promise<object>,
*   release: () => void,
*   dispose: () => void,
*   isDisposed: () => boolean
* }}
*/
function createAgnescodePublisher(deps = {}) {
	const { panelSwitch, resolveToken, getLlm, loadAdapterModule, emit, logger } = deps;
	const effectivePanelSwitch = panelSwitch ?? (async () => null);
	const effectiveResolveToken = resolveToken ?? (async () => "");
	const effectiveLoadAdapterModule = loadAdapterModule ?? (() => import("./agnescode-llm-adapter-Dvkxzd9k.js"));
	const effectiveGetLlm = getLlm ?? (() => null);
	const effectiveEmit = emit ?? (() => {});
	const effectiveLogger = logger ?? { warn: () => {} };
	/** The live AgnesCode registration state. */
	const state = {
		/** The roster the current registration was built from. */
		rows: [],
		/** The per-account BFF base the current registration addresses. */
		bffBase: "",
		/** Whether an `llm` service answering `registerAdapter` is present. */
		llmAvailable: false,
		/** Whether the AgnesCode provider pair is registered without error. */
		registered: false,
		/** The last registration error, surfaced secret-free in the snapshot. */
		error: null,
		releaseAdapter: null,
		releaseDirectory: null,
		/** The built adapter the active release functions belong to. */
		built: null
	};
	/** The publish queue and the `disposed` gate — shared with the Token Plan
	*  publisher (`publish-core.ts`), so the two cannot drift apart. */
	const queue = createPublishQueue();
	/** Resolve the peer-dependent adapter factory once and memoize it. */
	const resolveAdapterFactory = createAdapterFactoryResolver(effectiveLoadAdapterModule, "createAgnescodeAdapter");
	/** Release the registered pair. Releases are idempotent in the Host. */
	const release = createPairReleaser(state);
	/**
	* Hand one built adapter to the llm service and record its release
	* functions onto `target` — the shared single-point registrar (PITFALLS
	* §19), used by both the publish and the rollback path.
	*/
	const registerPair = (llm, built, target) => registerProviderPair(llm, built, target, {
		providerId: AGNESCODE_PROVIDER_ID,
		displayName: AGNESCODE_DISPLAY_NAME
	});
	/**
	* (Re)build and register the AgnesCode provider for one roster snapshot.
	*
	* The publish decision is a three-way gate:
	*   - switch OFF              → release, no registration (opt-in default);
	*   - switch ON, no token     → release, `error: CODE.NOT_CONFIGURED` (the
	*                               panel's「重新检测」affordance says so);
	*   - switch ON, token + base → build + register the roster.
	* On a failed registration the PREVIOUS pair is restored.
	* @param {object[]} rows - the roster rows (`agnescodeRoster`).
	* @param {string} bffBase - the credential's pinned per-account BFF base.
	* @returns {Promise<{ok: boolean, skipped?: boolean, error?: unknown}>}
	*/
	const publishProviderOnce = async (rows, bffBase = "") => {
		if (queue.isDisposed()) return {
			ok: false,
			skipped: true
		};
		const previousBuilt = state.built;
		const previousRows = state.rows;
		const previousBase = state.bffBase;
		const restoreIdentity = () => {
			state.rows = previousRows;
			state.bffBase = previousBase;
		};
		state.rows = Array.isArray(rows) ? rows : [];
		state.bffBase = str(bffBase, "");
		if (!resolveSwitchEnabled(await readPanelValue(effectivePanelSwitch)).enabled) return unregister({
			state,
			release
		});
		const llm = resolveRegistrationService({
			state,
			getLlm: effectiveGetLlm,
			release
		});
		if (llm === null) return {
			ok: false,
			error: state.error
		};
		const token = await effectiveResolveToken().catch(() => "");
		if (token === null || token === "" || state.bffBase === "") return unregister({
			state,
			release,
			error: CODE.NOT_CONFIGURED
		});
		let createAgnescodeAdapter;
		let built;
		try {
			createAgnescodeAdapter = await resolveAdapterFactory();
			built = await createAgnescodeAdapter({
				rows: state.rows,
				bffBase: state.bffBase,
				resolveToken: effectiveResolveToken,
				get: effectiveGetLlm
			});
			if (!isBuiltAdapter(built)) throw new Error(BAD_FACTORY_SHAPE_ERROR);
		} catch (error) {
			const described = describeBuildFailure(error);
			restoreIdentity();
			state.error = described.note;
			warnBuildFailure(effectiveLogger, "AgnesCode", described);
			return {
				ok: false,
				error: described.error
			};
		}
		return swapRegistration({
			llm,
			built,
			previousBuilt,
			state,
			release,
			registerPair,
			emit: effectiveEmit,
			onRollback: restoreIdentity
		});
	};
	/** Publish, queued behind every other in-flight publish. */
	const publish = (rows, bffBase) => queue.enqueue(() => publishProviderOnce(rows, bffBase));
	/** Mark the publisher disposed: any later publish is a no-op. */
	const dispose = () => queue.dispose();
	return {
		state,
		publish,
		release,
		dispose,
		isDisposed: () => queue.isDisposed()
	};
}

//#endregion
//#region src/host/agnescode-lifecycle.ts
/**
* The AgnesCode desktop-app upstream's re-harvest wiring (ROADMAP §6.3).
*
* Extracted from `index.ts`'s `apply()` so the mount seam stays a thin router
* (its own discipline: "the heavy lifting lives in focused sibling modules").
*
* What this module owns:
*   - the single-flighted re-harvest walk (`harvestAgnescodeLocalSession`):
*     one PowerShell spawn at a time, a failed walk buys a 60 s backoff
*     window during which nobody retries;
*   - the cross-account bffBase rebuild: a re-harvest that landed on another
*     account/base must re-publish, or B's token rides to A's base;
*   - the mount seed: if the switch survived a restart, re-register from the
*     fallback roster + the stored credential's per-account base.
*
* Peer-free: imports no Host peer. The lazy adapter load and the emit are
* injected by the caller (`apply`), matching the provider publisher's
* injection contract.
*
* @module dsh-connect-agnes-token-plan/agnescode-lifecycle
*/
/** How long a failed re-harvest blocks further re-harvest attempts. */
const AGNESCODE_REHARVEST_BACKOFF_MS = 6e4;
/** How many times the mount seed retries before giving up. */
const AGNESCODE_SEED_ATTEMPTS = 6;
/** Backoff base for the mount seed (linear: delayMs × attempt index). */
const AGNESCODE_SEED_DELAY_MS = 300;
/**
* Wire the AgnesCode publisher with its full single-flight + backoff +
* cross-base-rebuild `resolveToken` seam.
*
* The credential is re-harvested from the desktop App's os_crypt session file
* when it expires (there is NO refresh endpoint, ROADMAP §6.3). The walk runs
* a PowerShell command, so a per-request storm of it is the price of an
* expiring credential with the App gone: one walk at a time, and a failed
* walk buys a short window where nobody retries — the request rides the
* stored token and surfaces the 401 upstream, where the panel can see it,
* instead of every call paying the harvest cost forever.
*
* The single-flight and backoff state must live for the lifetime of the
* wiring (across many `resolveToken` calls), so it is held on a shared
* `harvest` object rather than in a per-call closure.
*
* @param {object} options - wiring.
* @param {object} options.store - the `createAgnescodeStore` instance.
* @param {() => Promise<boolean|null>} options.panelSwitch - the panel's live
*   switch (`agnescode-switch-store.enabled()`); null when no switch file.
* @param {() => Promise<string[]>} [options.enabledIds] - the panel's curated
*   model ids (`agnescode-models-store.listEnabledIds()`); empty = no curation.
* @param {(service: string) => object|null} options.getLlm - the optional
*   `llm` service resolver.
* @param {() => Promise<object>} [options.loadAdapterModule] - the lazy peer
*   adapter module loader; defaults to `import("./agnescode-llm-adapter.ts")`.
* @param {(event: string) => void} [options.emit] - `ctx.emit` for adapter
*   update events.
* @param {object} [options.logger] - `ctx.logger`.
* @param {{attempts?: number, delayMs?: number}} [options.seedOptions] - the
*   mount seed's retry window; overridable so a test can shrink it.
* @returns {{publisher: object, seed: () => Promise<void>}} the publisher and
*   its mount-seed function.
*/
function wireAgnescodePublisher({ store, panelSwitch, enabledIds, getLlm, loadAdapterModule, emit, logger, seedOptions = {} }) {
	const harvest = {
		inFlight: null,
		blockedUntil: 0
	};
	/**
	* The panel's curation, resolved fresh at each publish so a save between
	* publishes is honoured without any extra plumbing. An unreadable store is
	* "no curation" — the roster rides whole, never to nothing.
	* @returns {Promise<string[]>} the curated ids.
	*/
	const curated = async () => {
		if (enabledIds === void 0) return [];
		return enabledIds().catch(() => []);
	};
	const holder = { current: null };
	const resolveToken = async () => {
		const { credential } = await store.resolve();
		if (credential === null) return "";
		if (await store.isExpired().catch(() => false)) {
			if (harvest.inFlight === null && Date.now() >= harvest.blockedUntil) harvest.inFlight = harvestAgnescodeLocalSession().then(async (walk) => {
				harvest.inFlight = null;
				if (walk?.ok !== true) {
					harvest.blockedUntil = Date.now() + AGNESCODE_REHARVEST_BACKOFF_MS;
					logger?.warn?.(`agnescode: re-harvest found no usable session (${walk?.attempts?.length ?? 0} probed files); riding the stored token until ${new Date(harvest.blockedUntil).toISOString()}`);
					return null;
				}
				const expMs = decodeAgnescodeJwtExpMs(walk.session.accessToken);
				await store.save({
					...walk.session,
					...expMs !== void 0 ? { expiresAtMs: expMs } : {}
				}).catch((why) => {
					logger?.warn?.(`agnescode: re-harvest succeeded but the store refused it: ${str(why?.message ?? why, "unknown")}`);
				});
				const pub = holder.current;
				if (pub && walk.session.bffBase !== pub.state.bffBase) await pub.publish(filterAgnescodeRows(AGNESCODE_FALLBACK_MODELS, await curated()), walk.session.bffBase).catch((why) => {
					logger?.warn?.(`agnescode: re-harvest moved the BFF base to ${walk.session.bffBase} but republishing the adapter failed (the picker still points at the previous base): ${str(why?.message ?? why, "unknown")}`);
				});
				return walk;
			}).catch(() => {
				harvest.inFlight = null;
				harvest.blockedUntil = Date.now() + AGNESCODE_REHARVEST_BACKOFF_MS;
				return null;
			});
			await Promise.resolve(harvest.inFlight).catch(() => null);
		}
		const { credential: live } = await store.resolve();
		return live?.accessToken ?? "";
	};
	const publisher = createAgnescodePublisher({
		panelSwitch: panelSwitch ?? (async () => null),
		resolveToken,
		getLlm,
		loadAdapterModule: loadAdapterModule ?? (() => import("./agnescode-llm-adapter-Dvkxzd9k.js")),
		emit: emit ?? (() => {}),
		logger
	});
	holder.current = publisher;
	/**
	* The mount seed: if the switch survived a restart, re-register from the
	* fallback roster + the stored credential's per-account base.
	*
	* It retries INSIDE a bounded window rather than running once, because the
	* two things it needs can register AFTER this plugin mounts: the
	* `credentials` service (the credential is read through it, and a Host early
	* in its boot resolves nothing) and the `llm` registration service (without
	* it the publish gates off with `no llm registration service`). A one-shot
	* seed that missed either left the picker empty for the whole session while
	* the tab said "logged in" — nothing elsewhere re-ran the publish, so the
	* panel's entry GET was the only repair. Every attempt re-reads both, and
	* the loop stops as soon as `state.registered` flips.
	*
	* Fire-and-forget safe: a state dir that cannot be read just waits for the
	* first switch/harvest action, and a deployment that never enabled the
	* switch stays pristine (the switch is re-read each attempt, so a concurrent
	* panel flip to OFF is honoured instead of being raced).
	* @returns {Promise<void>}
	*/
	const seed = async () => {
		const attempts = seedOptions.attempts ?? 6;
		const delayMs = seedOptions.delayMs ?? 300;
		try {
			await retryBounded({
				attempts,
				delayMs,
				run: async () => {
					if (publisher.isDisposed()) return true;
					if (!resolveSwitchEnabled(await readPanelValue(panelSwitch)).enabled) return true;
					const { credential } = await store.resolve().catch(() => ({ credential: null }));
					if (!credential?.accessToken || !credential?.bffBase) return false;
					await publisher.publish(filterAgnescodeRows(AGNESCODE_FALLBACK_MODELS, await curated()), credential.bffBase).catch((why) => {
						logger?.warn?.(`agnescode: mount seed could not publish the provider; the picker stays empty until another trigger: ${str(why?.message ?? why, "unknown")}`);
					});
					if (publisher.state.registered === true) return true;
					if (publisher.isDisposed()) return true;
					return false;
				}
			});
		} catch {}
	};
	return {
		publisher,
		seed
	};
}

//#endregion
//#region src/host/provider-publish.ts
/**
* The directly-registered provider's PUBLISH STATE MACHINE — the peer-free
* control-plane half of step three ("one-stop service").
*
* What is left in this file is the part that is genuinely Token Plan's: the
* publish GATE (switch + persisted catalog + allow-list) and the state shape
* that gate reads and restores. The three load-bearing mechanisms it needs —
* the publish chain (PITFALLS §18), the `disposed` gate, and the single-point
* `registerPair` with its factory-await + shape check (PITFALLS §19) — now
* live in `publish-core.ts`, one copy shared with the AgnesCode publisher, so
* a fix to the rollback path reaches both upstreams at once.
*
* Peer-free: imports no runtime peer. The adapter factory is injected by the
* caller (`loadAdapterModule`, defaulting to `import("./llm-adapter.ts")`),
* so the offline suites can substitute a fake factory without touching the
* Host's node_modules.
*
* @module dsh-connect-agnes-token-plan/provider-publish
*/
/**
* The provider publisher.
*
* Holds the live registration state (`state`); the publish queue, the
* `disposed` gate and the single-point `registerPair` are the shared
* `publish-core.ts` bones. The caller drives `publish` from the mount seed, the
* catalog poll, the provider switch, the roster save and the api-key forget;
* it calls `dispose` from the `ctx.effect` teardown.
*
* The `getLlm` resolver is a FUNCTION, not a snapshot, because the `llm`
* service may register with the Host after this plugin mounts — the same
* resolver-not-snapshot pattern used for `credentials`.
*
* @param {object} [deps]
* @param {object} [deps.settings] - the resolved settings row (reads `registerProvider` and `apiBase` only).
* @param {() => Promise<boolean|null>} [deps.panelSwitch] - the panel-saved value
*   (`provider-store.enabled()`); null when the state file is untouched.
* @param {() => Promise<{createAgnesAdapter: Function}>} [deps.loadAdapterModule] - the
*   peer-dependent adapter factory module; defaults to the real `llm-adapter.ts`.
* @param {(service: string) => object|null} [deps.getLlm] - optional-service
*   resolver for the `llm` registration service.
* @param {() => Promise<string>} [deps.resolveApiKey] - resolves the live `sk-`
*   key per request (the `api-key-store.ts` seam). The adapter factory reads
*   it, so it must be a real resolver, never a snapshot.
* @param {(event: string) => void} [deps.emit] - `ctx.emit` for the adapter
*   update event.
* @param {object} [deps.logger] - `ctx.logger` for the build-failure warning.
* @returns {{
*   state: {entries, enabledIds, unavailableIds, signature, quotaSignature,
*           llmAvailable, registered, error, built, releaseAdapter,
*           releaseDirectory},
*   publish: (entries: object[], enabledIds: string[],
*             unavailableModelIds?: string[]) => Promise<object>,
*   release: () => void,
*   dispose: () => void,
*   isDisposed: () => boolean
* }}
*/
function createProviderPublisher(deps = {}) {
	const { settings, panelSwitch, loadAdapterModule, getLlm, resolveApiKey, emit, logger } = deps;
	const effectiveSettings = settings ?? {};
	const effectivePanelSwitch = panelSwitch ?? (async () => null);
	const effectiveLoadAdapterModule = loadAdapterModule ?? (() => import("./llm-adapter-CpOfMoAY.js"));
	const effectiveGetLlm = getLlm ?? (() => null);
	const effectiveResolveApiKey = resolveApiKey ?? (async () => "");
	const effectiveEmit = emit ?? (() => {});
	const effectiveLogger = logger ?? { warn: () => {} };
	/**
	* The live registration state. A plain object the caller reads as `state`
	* (the snapshot's `llm` block pulls `registered` / `error` off it). The
	* release functions live here rather than being returned, because a
	* registration that throws AFTER the adapter was registered must still
	* be reachable, or the adapter outlives the plugin (see `registerPair`).
	*/
	const state = {
		/** The catalog entries the current registration was built from. */
		entries: [],
		/** The curated allow-list at registration time (empty = all models). */
		enabledIds: [],
		/** The last quota-exhausted model ids published to the picker. */
		unavailableIds: [],
		/** A cheap signature of the offered set (catalog ids + vision bits + allow-list). */
		signature: "",
		/** A cheap signature of the quota-exhausted set; flips when a pool crosses zero. */
		quotaSignature: "",
		/** Whether an `llm` service answering `registerAdapter` is present. */
		llmAvailable: false,
		/** Whether our provider pair is currently registered without error. */
		registered: false,
		/** The last registration error, surfaced secret-free in the snapshot. */
		error: null,
		releaseAdapter: null,
		releaseDirectory: null,
		/** The built adapter the active release functions belong to. */
		built: null
	};
	/**
	* The publish queue and the `disposed` gate — the first two of the three
	* load-bearing semantics. Both live in `publish-core.ts` now, so the
	* AgnesCode publisher's copy cannot drift from this one.
	*/
	const queue = createPublishQueue();
	/** Resolve the peer-dependent adapter factory once and memoize it. */
	const resolveAdapterFactory = createAdapterFactoryResolver(effectiveLoadAdapterModule, "createAgnesAdapter");
	/** Release the registered pair. Releases are idempotent in the Host. */
	const release = createPairReleaser(state);
	/**
	* Hand one built adapter to the llm service and record its release
	* functions onto `target`.
	*
	* The body is the shared `registerProviderPair` (PITFALLS §19) — one copy
	* for both publishers and both paths; this wrapper only supplies which
	* provider the row is for.
	* @param {object} llm - the registration service.
	* @param {{providerIds: string[], adapter: unknown}} built - what to register.
	* @param {object} target - where the release functions are recorded (`state`).
	* @returns {void}
	*/
	const registerPair = (llm, built, target) => registerProviderPair(llm, built, target, {
		providerId: LLM_PROVIDER_ID,
		displayName: LLM_DISPLAY_NAME
	});
	/**
	* (Re)build and register the provider for one catalog/allow-list snapshot.
	*
	* Rebuild-and-reregister rather than mutate: `PiAiAdapter` memoizes its
	* profiles snapshot internally, so only a fresh registration can change the
	* offered model list. On a failed registration the PREVIOUS pair is
	* restored, so a bad publish can never take down models that were already
	* serving.
	* @param {object[]} entries - the normalized catalog entries.
	* @param {string[]} enabledIds - the curated allow-list (empty = all).
	* @param {string[]} [unavailableModelIds] - quota-exhausted model ids to
	*   drop from the picker's offer.
	* @returns {Promise<{ok: boolean, skipped?: boolean, error?: unknown}>}
	*/
	const publishProviderOnce = async (entries, enabledIds, unavailableModelIds = []) => {
		if (queue.isDisposed()) return {
			ok: false,
			skipped: true
		};
		const previousBuilt = state.built;
		const previousEntries = state.entries;
		const previousEnabledIds = state.enabledIds;
		const previousUnavailable = state.unavailableIds;
		const restoreIdentity = () => {
			state.entries = previousEntries;
			state.enabledIds = previousEnabledIds;
			state.unavailableIds = previousUnavailable;
		};
		state.entries = Array.isArray(entries) ? entries : [];
		state.enabledIds = Array.isArray(enabledIds) ? enabledIds : [];
		state.unavailableIds = Array.isArray(unavailableModelIds) ? unavailableModelIds : [];
		if (!resolveSwitchEnabled(await readPanelValue(effectivePanelSwitch), effectiveSettings.registerProvider).enabled) return unregister({
			state,
			release
		});
		const llm = resolveRegistrationService({
			state,
			getLlm: effectiveGetLlm,
			release
		});
		if (llm === null) return {
			ok: false,
			error: state.error
		};
		let createAgnesAdapter;
		let built;
		try {
			createAgnesAdapter = await resolveAdapterFactory();
			built = await createAgnesAdapter({
				entries: state.entries,
				enabledIds: state.enabledIds,
				baseUrl: effectiveSettings.apiBase,
				resolveApiKey: effectiveResolveApiKey,
				get: effectiveGetLlm,
				unavailableModelIds: state.unavailableIds
			});
			if (!isBuiltAdapter(built)) throw new Error(BAD_FACTORY_SHAPE_ERROR);
		} catch (error) {
			const described = describeBuildFailure(error);
			restoreIdentity();
			state.error = described.note;
			warnBuildFailure(effectiveLogger, "Agnes", described);
			return {
				ok: false,
				error: described.error
			};
		}
		return swapRegistration({
			llm,
			built,
			previousBuilt,
			state,
			release,
			registerPair,
			emit: effectiveEmit,
			onRollback: restoreIdentity
		});
	};
	/**
	* Publish, queued behind every other publish in flight.
	*
	* The wrapper exists so no caller has to remember the queue: the mount seed,
	* a catalog poll, an api-key forget and a provider switch all reach the same
	* critical section, and any one of them racing another is the bug above.
	* @param {object[]} entries - the normalized catalog entries.
	* @param {string[]} enabledIds - the curated allow-list (empty = all).
	* @param {string[]} [unavailableModelIds] - quota-exhausted model ids.
	* @returns {Promise<{ok: boolean, skipped?: boolean, error?: unknown}>}
	*/
	const publish = (entries, enabledIds, unavailableModelIds = []) => queue.enqueue(() => publishProviderOnce(entries, enabledIds, unavailableModelIds));
	return {
		state,
		publish,
		release,
		dispose: () => queue.dispose(),
		isDisposed: () => queue.isDisposed()
	};
}
/**
* Seed the registration from the persisted catalog so a restarted Host offers
* models before its first poll (and with no console login at all).
*
* Fire-and-forget: a state dir that cannot be read just waits for the poll.
* @param {ReturnType<typeof createProviderPublisher>} publisher
* @param {() => Promise<object[]>} listCatalog - read the persisted catalog entries.
* @param {() => Promise<string[]>} listEnabled - read the persisted allow-list.
* @param {(entries: object[], enabledIds: string[]) => string} signatureOf -
*   the cheap offered-set signature.
*/
function seedPublisherFromCatalog(publisher, listCatalog, listEnabled, signatureOf) {
	return (async () => {
		try {
			const [stored, storedEnabled] = await Promise.all([listCatalog(), listEnabled()]);
			publisher.state.signature = signatureOf(stored, storedEnabled);
			await publisher.publish(stored, storedEnabled, []);
		} catch {}
	})();
}
/**
* A cheap signature of the model set a provider registration would offer.
*
* It only has to answer "would rebuilding change anything?": the model ids in
* catalog order, each tagged with the SAME vision decision the descriptors
* use (an id whose modality flipped must rebuild even though the id list did
* not change), plus the curated allow-list. Anything else changing in a
* catalog entry does not affect the registered offer.
* @param {object[]} entries - the normalized catalog entries.
* @param {string[]} enabledIds - the allow-list (empty = all).
* @returns {string}
*/
function catalogSignature(entries, enabledIds) {
	return `${(Array.isArray(entries) ? entries : []).map((entry) => `${str(entry?.id, "")}:${visionOf(entry).vision === true ? 1 : 0}`).join(",")}|${(Array.isArray(enabledIds) ? enabledIds : []).join(",")}`;
}

//#endregion
//#region src/host/console-client.ts
/**
* The Host half's console and model-catalog fetches: envelope handling, caching
* plus single-flight.
*
* Every Agnes backend answer is wrapped in `{code, message, data}` — the body
* of a 200 can still be a refusal, and a dead session answers `code: 401`
* `"Not logged in or invalid token"`. Unwrapping happens HERE, once, so no
* caller has to remember the envelope and no parser has to look one level down.
*
* Both authenticated endpoints share one in-flight map per URL, so several
* open panels (or tabs) polling at once issue a single console request instead
* of N — which is also how the Host stays off the platform's own rate limiter.
* Cached responses age out on their own TTL, and a safety sweep drops anything
* older than the longest TTL so the map never grows without bound.
* @module dsh-connect-agnes-token-plan/console-client
*/
/** Longest TTL any caller uses; entries older than this are swept. */
const MAX_CACHE_AGE_MS = 36e5;
/** The envelope's success code. Anything else is a refusal, even on HTTP 200. */
const ENVELOPE_OK = 200;
/** The plan catalogue path. The `/cn/` segment is required — without it: 404. */
const PLANS_PATH = "/api/cn/user/subscription/plans";
/** Drop entries older than the longest TTL so the map stays bounded. */
function sweepCache(cache) {
	const nowMs = Date.now();
	for (const [key, entry] of cache) if (nowMs - entry.at > MAX_CACHE_AGE_MS) cache.delete(key);
}
/**
* Whether an envelope code means "the token is no longer good".
*
* Agnes reports an expired session as `code: 401` inside an HTTP 401, but the
* same code can ride a 200 on a route that answers before it authenticates, so
* both layers are checked. 403 is included because a revoked token answers
* that way on some routes and the recovery is identical.
* @param {unknown} code - the envelope's `code` field.
* @returns {boolean} true when the caller should renew and retry once.
*/
function isAuthRefusal(code) {
	return Number(code) === 401 || Number(code) === 403;
}
/**
* Build the Error for a stated non-200 envelope code.
*
* The platform's own `message` is the only text that explains a refusal
* ("Not logged in or invalid token" vs "plan not found"), so it is carried
* verbatim rather than replaced by a code table.
* @param {unknown} body - the parsed response body.
* @param {string} label - the endpoint, for context when `message` is empty.
* @returns {import("./types.ts").PluginError} the error to throw.
*/
function refusalError(body, label) {
	const source = obj(body);
	const code = Number(source.code);
	const message = str(source.message, "");
	const error = /* @__PURE__ */ new Error(message === "" ? `${label} refused with code ${code}` : `${label}: ${message}`);
	error.code = isAuthRefusal(code) ? CODE.JWT_EXPIRED : CODE.CONSOLE_ERROR;
	return error;
}
/**
* Unwrap the platform's `{code, message, data}` envelope.
*
* A body that carries no `code` at all is returned as-is rather than refused:
* a route that answers a bare object (or an array) is still a valid answer,
* and inventing a refusal for it would turn a working call into a permanent
* error. Only a STATED non-200 code is a refusal.
*
* @param {unknown} body - the parsed response body.
* @param {string} label - the endpoint, for the error message.
* @returns {unknown} the envelope's `data`, or the body itself when unwrapped.
* @throws {import("./types.ts").PluginError} when the envelope states a non-200 code.
*/
function unwrapEnvelope(body, label) {
	const source = obj(body);
	const code = source.code;
	if (code === void 0 || code === null) return body;
	if (Number(code) === ENVELOPE_OK) return source.data;
	throw refusalError(body, label);
}
/**
* Fetch one authenticated console endpoint with a bearer token, caching the
* unwrapped `data`.
*
* A 401/403 — at the HTTP layer OR in the envelope — means the token the
* console saw is no longer good, so the store is invalidated and the call
* retried exactly once with a fresh token. Without the retry a token that
* expires mid-poll would leave the panel stuck on an error until the next
* manual re-login; with it, the panel heals itself. The retry is not
* recursive: a token minted a moment ago that is ALSO refused means the
* account, not the token, is the problem — and retrying harder is how an
* account gets locked.
*
* @param settings - resolved plugin settings.
* @param path - the console path, e.g. `/api/usage/overview`.
* @param params - optional query parameters.
* @param cacheMs - how long to keep the response.
* @param cache - the cache map to use.
* @param inflight - the in-flight map to share requests through.
* @param tokenStore - the credentials-backed token store.
* @returns {Promise<unknown>} the unwrapped console `data`.
*/
async function fetchConsole(settings, path, params, cacheMs, cache, inflight, tokenStore) {
	const query = params && Object.keys(params).length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
	const url = `${settings.consoleBase}${path}${query}`;
	const cached = cache.get(url);
	if (cached !== void 0 && Date.now() - cached.at < cacheMs) return cached.body;
	const pending = inflight.get(url);
	if (pending !== void 0) return pending;
	const run = async () => {
		/** One attempt: `{data}` on success, `{authRefused: true}` when renewing helps. */
		const attempt = async (token) => {
			const response = await fetch(url, {
				headers: {
					authorization: `Bearer ${token}`,
					accept: "application/json"
				},
				signal: AbortSignal.timeout(settings.consoleTimeoutMs)
			});
			if (response.status === 401 || response.status === 403) return { authRefused: true };
			if (!response.ok) throw new Error(`console returned HTTP ${response.status} on ${path}`);
			const body = await response.json();
			const code = obj(body).code;
			if (code !== void 0 && code !== null && Number(code) !== ENVELOPE_OK) {
				if (isAuthRefusal(code)) return { authRefused: true };
				throw refusalError(body, path);
			}
			return { data: code === void 0 || code === null ? body : obj(body).data };
		};
		let token = await tokenStore.getToken();
		let result = await attempt(token);
		if (result.authRefused) {
			tokenStore.invalidate(token);
			token = await tokenStore.getToken();
			result = await attempt(token);
		}
		if (result.authRefused) {
			const error = /* @__PURE__ */ new Error(`console rejected the token (${path})`);
			error.code = CODE.JWT_EXPIRED;
			throw error;
		}
		cache.set(url, {
			body: result.data,
			at: Date.now()
		});
		sweepCache(cache);
		return result.data;
	};
	const flight = run().finally(() => {
		inflight.delete(url);
	});
	inflight.set(url, flight);
	return flight;
}
/**
* Fetch the public plan catalogue — the only quota source that needs no login.
*
* `GET /api/cn/user/subscription/plans` answers 200 to an anonymous request
* (verified 2026-10-01: six plans, `入门版`/`专业版`/`高级版` × monthly/yearly).
* Two things follow from that: the panel can show what upgrading buys without
* ever asking for a credential, and this is the one quota source that survives
* a partial failure of the authenticated half.
*
* @param settings - resolved plugin settings.
* @param cacheMs - how long to keep the response (long: the catalogue is stable).
* @param cache - the cache map to use.
* @param inflight - the in-flight map to share requests through.
* @returns {Promise<unknown>} the unwrapped `data` array, or `null` on failure.
*/
async function fetchPlans(settings, cacheMs, cache, inflight) {
	const url = `${settings.consoleBase}${PLANS_PATH}`;
	const cached = cache.get(url);
	if (cached !== void 0 && Date.now() - cached.at < cacheMs) return cached.body;
	const pending = inflight.get(url);
	if (pending !== void 0) return pending;
	const run = async () => {
		const response = await fetch(url, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(settings.consoleTimeoutMs)
		});
		if (!response.ok) throw new Error(`${PLANS_PATH} returned HTTP ${response.status}`);
		const body = unwrapEnvelope(await response.json(), PLANS_PATH);
		cache.set(url, {
			body,
			at: Date.now()
		});
		sweepCache(cache);
		return body;
	};
	const flight = run().finally(() => {
		inflight.delete(url);
	});
	inflight.set(url, flight);
	return flight;
}
/**
* Fetch the API-key model catalog: the models this key can actually call.
*
* This is a free, read-only `GET /v1/models` — it spends no quota and consumes
* no inference allowance. It is the same list the DSH Models page shows in
* "选择要添加的模型", and it is the ONLY per-model availability signal Agnes
* offers: the platform has no per-model quota, so "can this model be called"
* is answered by the key's own catalogue rather than by any pool.
*
* @param settings - resolved plugin settings.
* @param cacheMs - how long to keep the response (long: the catalog is stable).
* @param cache - the cache map to use.
* @param inflight - the in-flight map to share requests through.
* @param apiKey - the Agnes API key.
*/
async function fetchModelCatalog(settings, cacheMs, cache, inflight, apiKey) {
	const url = `${settings.apiBase}/models`;
	const cached = cache.get(url);
	if (cached !== void 0 && Date.now() - cached.at < cacheMs) return cached.body;
	const pending = inflight.get(url);
	if (pending !== void 0) return pending;
	const run = async () => {
		const response = await fetch(url, {
			headers: {
				authorization: `Bearer ${apiKey}`,
				accept: "application/json"
			},
			signal: AbortSignal.timeout(settings.consoleTimeoutMs)
		});
		if (!response.ok) throw new Error(`/v1/models returned HTTP ${response.status}`);
		const body = await response.json();
		const models = Array.isArray(body?.data) ? body.data.map((entry) => {
			const source = obj(entry);
			return {
				id: str(source.id, ""),
				...source
			};
		}).filter((entry) => entry.id !== "") : [];
		cache.set(url, {
			body: models,
			at: Date.now()
		});
		sweepCache(cache);
		return models;
	};
	const flight = run().finally(() => {
		inflight.delete(url);
	});
	inflight.set(url, flight);
	return flight;
}

//#endregion
//#region src/host/draw.ts
/**
* The Agnes image-generation module ("draw absorption", ARCHITECTURE §5.4
* route B) — the PEER-FREE half.
*
* Like `llm-models.ts` this module imports no runtime peer: it maps catalog
* entries, builds wire bodies and classifies failures as plain functions, so
* every decision here is testable on a clean checkout. The peer-dependent
* half lives in `index.ts`: the `@deepseek-ai/dsh-tools` import and the
* `ctx.tools` registration are loaded lazily and only when the `drawEnabled`
* opt-in is on — a Host without the tools service simply never sees the tool,
* exactly like the provider degrades without an `llm` service.
*
* Two design facts are load-bearing rather than cosmetic:
*
* 1. Model identification is delegated to `modality.ts` — the ONE resolver
*    this tool shares with the chat roster, so the two lists can never
*    disagree about what exists. ARCHITECTURE §5.4 originally had this module
*    read the catalog's own `output_modalities` field directly, to beat
*    `dsh-draw-router`'s name patterns (they miss `Agnes-u1.5-lite` outright).
*    That field does not exist on the Agnes gateway — its `/v1/models` entries
*    carry no modality metadata at all (live-verified 2026-10-01) — so the
*    strict reading left this tool unable to pick ANY model while the catalog
*    was full of image models. `modality.ts` keeps the declared field as the
*    first choice and falls back to the platform's own family segment; its
*    header carries the full record of the reversal.
* 2. The key is resolved per call (`resolveApiKey`), never cached: rotating
*    the panel-saved `AGNES_TOKEN_PLAN_API_KEY` reference takes effect on the next
*    draw without re-registration, mirroring the LLM adapter.
*
* @module dsh-connect-agnes-token-plan/draw
*/
/** The agent tool name. Scoped so it cannot collide with `dsh-draw-router`'s `draw_image`. */
const DRAW_TOOL_NAME = "agnes_draw_image";
/** How long after a failed draw the next attempt is refused. Borrowed from dsh-draw-router (its probe cooldown). */
const DRAW_COOLDOWN_MS = 3e4;
/** Default deadline for one image request; image models are slow, chat deadlines do not apply. */
const DRAW_DEFAULT_TIMEOUT_MS = 12e4;
/**
* Build the `images/generations` endpoint from the OpenAI-compatible base.
*
* Mirrors `dsh-draw-router`'s `buildEndpoint` (upstream line 72-79) so every
* operator spelling of `apiBase` lands on the same URL:
* `…/v1` → `…/v1/images/generations`; an URL already ending in
* `/images/generations` passes through; a deeper `/v1/<something>` is rewound
* to `/v1`; anything else gets `/v1/images/generations` appended.
* @param {string} apiBase - the configured base (default `https://token.Agnes.cn/v1`).
* @returns {string} the full draw endpoint.
*/
function buildDrawEndpoint(apiBase) {
	const trimmed = str(apiBase, "").trim().replace(/\/+$/, "");
	if (trimmed === "") return "";
	if (/\/images\/generations$/.test(trimmed)) return trimmed;
	if (/\/v1$/.test(trimmed)) return `${trimmed}/images/generations`;
	if (/\/v1\//.test(trimmed)) return trimmed.replace(/\/v1\/.*$/, "/v1/images/generations");
	return `${trimmed}/v1/images/generations`;
}
/**
* The draw-capable model ids of one catalog, de-duplicated in first-seen order.
*
* Deduping keeps the LAST occurrence at its first-seen position, exactly like
* `rosterOf` / `buildDescriptors` / `catalog-store.normalizeEntries`, so the
* draw list and the chat roster can never disagree about which ids exist.
* @param {object[]} entries - the normalized catalog entries.
* @returns {string[]}
*/
function imageGenModelIds(entries) {
	const position = /* @__PURE__ */ new Map();
	const out = [];
	for (const entry of Array.isArray(entries) ? entries : []) {
		if (!isImageGenModel(entry)) continue;
		const id = str(entry?.id, "");
		if (id === "") continue;
		if (position.has(id)) out[position.get(id)] = id;
		else {
			position.set(id, out.length);
			out.push(id);
		}
	}
	return out;
}
/**
* Choose the model one draw call addresses.
*
* Precedence: an explicitly requested id wins even when the catalog does not
* list it (a manual override, like `dsh-draw-router`; the platform answers
* the error itself if the id is wrong) — but an empty catalog with nothing
* requested yields `null`, and the caller turns that into the actionable
* "no draw models" error rather than sending a doomed request.
* @param {object[]} entries - the normalized catalog entries.
* @param {string} [requested] - the tool call's `model` parameter.
* @param {string} [preferred] - the configured default (`drawModelId`).
* @returns {string|null} the chosen id, or `null` when nothing can be picked.
*/
function pickDrawModel(entries, requested, preferred) {
	const want = str(requested, "").trim();
	if (want !== "") return want;
	const ids = imageGenModelIds(entries);
	if (ids.length === 0) return null;
	const config = str(preferred, "").trim();
	if (config !== "" && ids.includes(config)) return config;
	return ids[0];
}
/**
* Build the `images/generations` request body.
*
* Only the fields the endpoint actually consumes travel: `n` is clamped to a
* sane range (a fraction floors, junk and out-of-range values fall back to 1)
* and `response_format` defaults to `url` — the panel/agent-facing shape that
* renders as a Markdown image without the client having to handle base64.
* @param {object} options - `{ model, prompt, n, size, responseFormat }`.
* @returns {object} the wire body.
*/
function buildDrawBody(options = {}) {
	const { model, prompt, size, ratio, image, returnBase64, responseFormat } = options;
	const body = {
		model: str(model, ""),
		prompt: str(prompt, ""),
		n: 1,
		response_format: str(responseFormat, "url") || "url"
	};
	const dims = str(size, "").trim();
	if (dims !== "") body.size = dims;
	const ar = str(ratio, "").trim();
	const imgs = Array.isArray(image) ? image.map((x) => str(x, "")).filter((x) => x !== "") : [];
	const extra = {};
	if (ar !== "") extra.ratio = ar;
	if (imgs.length > 0) extra.image = imgs;
	if (returnBase64 === true) extra.return_base64 = true;
	if (Object.keys(extra).length > 0) body.extra_body = extra;
	return body;
}
/**
* Extract the first image out of an `images/generations` response.
* @param {object} data - the parsed response JSON.
* @returns {{url: string, b64Json: string, revisedPrompt: string}}
* @throws {Error} when the response carries no `data[0]` at all.
*/
function parseDrawResponse(data) {
	const item = data?.data?.[0];
	if (item === null || typeof item !== "object") throw new Error("draw: unexpected response, missing data[0]");
	return {
		url: str(item.url, ""),
		b64Json: str(item.b64_json, ""),
		revisedPrompt: str(item.revised_prompt, "")
	};
}
/**
* Turn a failed HTTP answer into the message the agent (and the trace) reads.
*
* The split mirrors the 429 discipline already fixed for chat (ROADMAP §1-2):
* "insufficient/quota" in a 429 means the shared pool is drained — retrying
* the same request is waste — while any other 429 is a rate limit and a plain
* wait helps. Auth failures point at the panel's key area instead of at
* "the endpoint is broken".
* @param {number} status - the HTTP status code.
* @param {string} bodyText - the raw body (best effort, may be empty).
* @returns {string} the panel/agent-facing message.
*/
function describeDrawFailure(status, bodyText) {
	const text = str(bodyText, "").slice(0, 300);
	if (status === 401 || status === 403) return `draw failed: HTTP ${status} — the AGNES_TOKEN_PLAN_API_KEY is missing, invalid or not authorized for this model. Set it in the panel's 模型接入 area${text === "" ? "" : `; body: ${text}`}`;
	if (status === 429) {
		if (/insufficient|quota/i.test(text)) return `draw failed: HTTP 429 — 配额不足（共享池已耗尽或该出图模型不在套餐内），稍后或换模型再试; body: ${text}`;
		return `draw failed: HTTP 429 — 限频，请稍等重试; body: ${text}`;
	}
	if (status === 404) return `draw failed: HTTP 404 — 模型不存在或 endpoint 不对（检查 apiBase 与模型 id）${text === "" ? "" : `; body: ${text}`}`;
	return `draw failed: HTTP ${status}${text === "" ? "" : ` ${text}`}`;
}
/**
* Fire one draw request and parse the answer.
*
* The deadline aborts through an `AbortController` (the `AbortSignal.timeout`
* spelling would do, but the controller also cancels the in-flight body read
* and keeps the whole flow injectable for tests). A non-2xx answer never
* reaches JSON parsing: its classified message is thrown with the raw body
* attached, so the agent sees WHY, not just that it failed.
* @param {object} options - wiring.
* @param {Function} options.fetchImpl - the fetch to use (injected; the real
*   `globalThis.fetch` arrives from `index.ts`).
* @param {string} options.endpoint - the full `images/generations` URL.
* @param {string} options.apiKey - the resolved `sk-` key.
* @param {object} options.body - the wire body (`buildDrawBody`).
* @param {number} [options.timeoutMs] - the deadline.
* @returns {Promise<{url: string, b64Json: string, revisedPrompt: string, model: string}>}
*/
async function drawOnce({ fetchImpl, endpoint, apiKey, body, timeoutMs = DRAW_DEFAULT_TIMEOUT_MS }) {
	if (typeof fetchImpl !== "function") throw new Error("drawOnce: fetchImpl is required");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(/* @__PURE__ */ new Error(`draw timeout after ${timeoutMs}ms`)), Math.max(1e3, timeoutMs));
	try {
		const response = await fetchImpl(endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`
			},
			body: JSON.stringify(body),
			signal: controller.signal
		});
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(describeDrawFailure(response.status, text));
		}
		return {
			...parseDrawResponse(await response.json().catch(() => {
				throw new Error("draw: response is not valid JSON");
			})),
			model: str(body?.model, "")
		};
	} finally {
		clearTimeout(timer);
	}
}
/**
* The failed-draw cooldown gate.
*
* Borrowed from `dsh-draw-router` (its probe failure cooldown, upstream line
* 196): after one failed draw the next attempt is refused for a window, so a
* drained pool does not get hammered by an agent retrying in a loop. The
* clock is wall-time, so the gate reopens by itself when the window passes —
* deliberately NO success-side reset: a tripped gate blocks the execute entry
* itself, so a success can only ever happen on an open gate and a reset call
* there would be dead code.
* @param {number} [cooldownMs] - the window.
* @returns {{blocked: Function, trip: Function, remainingMs: Function}}
*/
function createDrawCooldown(cooldownMs = DRAW_COOLDOWN_MS) {
	let until = 0;
	return {
		blocked: (now = Date.now()) => now < until,
		trip: (now = Date.now()) => {
			until = now + cooldownMs;
		},
		remainingMs: (now = Date.now()) => Math.max(0, until - now)
	};
}
/**
* Build the agent tool object for `ctx.tools.register`.
*
* Pure wiring: the peer's `defineTool` factory arrives as a parameter (so this
* module stays importable without the peer), and every side effect the tool
* needs — key resolution, the live catalog, the fetch, disposal — is injected.
* `index.ts` calls this only when `drawEnabled` is on AND a tools service is
* present; every failure inside `execute` throws so the agent reads the
* reason, and the panel is never involved (no snapshot key, no route).
* @param {object} options - wiring.
* @param {Function} options.defineTool - the peer's tool factory.
* @param {Function} options.resolveApiKey - async `() => Promise<string>`, the
*   live `AGNES_TOKEN_PLAN_API_KEY` value (empty when unset).
* @param {Function} options.getEntries - `() => catalog entries` (sync or
*   async), read at call time so a catalog refresh is picked up without
*   re-registration. The caller (`index.ts`) hands the FULL persisted catalog,
*   not the picker's allow-list-filtered offer — the curation binds the picker,
*   never the agent's tools.
* @param {object} options.settings - `{ apiBase, drawModelId, drawTimeoutMs }`.
* @param {Function} options.fetchImpl - the fetch for `drawOnce`.
* @param {object} [options.cooldown] - a `createDrawCooldown()` gate.
* @param {Function} [options.isDisposed] - `() => boolean`, true after unmount.
* @returns {object} the tool definition for `ctx.tools.register`.
*/
function defineDrawTool({ defineTool, resolveApiKey, getEntries, settings, fetchImpl, cooldown = createDrawCooldown(), isDisposed = () => false }) {
	const timeoutMs = Math.max(5e3, Math.floor(num(settings?.drawTimeoutMs, DRAW_DEFAULT_TIMEOUT_MS)));
	return defineTool({
		name: DRAW_TOOL_NAME,
		description: "Generate an image with the Agnes Token Plan key. Omit `model` to let the catalog's default image model be used; pass `model` only when you need a particular one — the available image model ids are reported in the result after the first successful call.",
		parameters: {
			prompt: {
				type: "string",
				required: true,
				description: "Image generation prompt"
			},
			model: {
				type: "string",
				description: "Agnes image model id; defaults to the first discovered one"
			},
			size: {
				type: "string",
				description: "Image size: '2K' (2048x2048) or '4K' (4096x4096) tier constant, or exact WIDTHxHEIGHT (32-multiple, 512-4096, max 3:1 ratio), e.g. 2720x1536 — live-verified on the Agnes endpoint (probe ⑤)"
			},
			ratio: {
				type: "string",
				description: "Aspect ratio: 1:1, 3:4, 4:3, 16:9, 9:16, 2:3, 3:2 (default 1:1); forwarded as extra_body.ratio"
			},
			image: {
				type: "array",
				items: { type: "string" },
				description: "Reference image URL(s) / Data URIs for img2img; forwarded as extra_body.image"
			},
			return_base64: {
				type: "boolean",
				description: "Request Base64 output instead of a URL (text2img only); forwarded as extra_body.return_base64"
			},
			n: {
				type: "number",
				description: "Image count; the platform currently requires exactly 1 (default 1)"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					source: { type: "string" },
					model: { type: "string" },
					url: { type: "string" },
					prompt: { type: "string" },
					hint: { type: "string" }
				}
			},
			render: (_args, result) => [{
				type: "text",
				text: result?.hint || "图片已生成"
			}]
		},
		timeoutMs: timeoutMs + 1e4,
		async execute(params) {
			if (isDisposed()) throw new Error("Agnes draw tool is no longer mounted");
			const prompt = str(params?.prompt, "").trim();
			if (prompt === "") throw new Error("prompt is required");
			if (cooldown.blocked()) throw new Error(`draw cooldown: 上一次出图失败，${Math.ceil(cooldown.remainingMs() / 1e3)}s 后再试`);
			const apiKey = await resolveApiKey();
			if (typeof apiKey !== "string" || apiKey.trim() === "") throw new Error("AGNES_TOKEN_PLAN_API_KEY 未配置：在面板「模型接入」粘贴 API Key（免费版 sk- 或 Token Plan cpk-），或设置该环境变量");
			let picked;
			try {
				picked = await getEntries?.() ?? [];
			} catch {
				picked = [];
			}
			const entries = Array.isArray(picked) ? picked : [];
			const model = pickDrawModel(entries, params?.model, settings?.drawModelId);
			if (model === null || model === void 0) throw new Error("catalog 中没有出图模型（`output_modalities` 字段与 `agnes-image-*` 名称判定均为空）：确认 Key 已配置、面板已至少轮询一次，且套餐含出图模型");
			const body = buildDrawBody({
				model,
				prompt,
				size: params?.size,
				ratio: params?.ratio,
				image: params?.image,
				returnBase64: params?.return_base64
			});
			let result;
			try {
				result = await drawOnce({
					fetchImpl,
					endpoint: buildDrawEndpoint(settings?.apiBase),
					apiKey,
					body,
					timeoutMs
				});
			} catch (error) {
				cooldown.trip();
				throw error;
			}
			const ids = imageGenModelIds(entries);
			const modelList = ids.length > 0 ? `\n可用出图模型: ${ids.join(", ")}` : "";
			const hint = result.url !== "" ? `图片已生成!\n模型: ${result.model}\nURL: ${result.url}\n请直接输出 Markdown: ![图](${result.url})${modelList}` : `图片已生成!\n模型: ${result.model}\n(base64 图片数据，请以 data:image/png;base64,… 形式在对话中展示)${modelList}`;
			return {
				source: "agnes",
				model: result.model,
				url: result.url,
				prompt,
				hint
			};
		}
	});
}

//#endregion
//#region src/host/video-models.ts
/**
* The Agnes VIDEO model roster — family recognition and catalog selection.
*
* Part of the 2026-10 split of `video.ts` (see that file's header for the
* family map; behaviour was frozen by `video.test.mjs` before and after).
* This module owns the two questions that are about the CATALOG rather than
* the wire:
*
*   - WHICH entries are video models — delegated to `modality.ts`, so this
*     roster and the chat roster can never disagree about which entries exist;
*   - WHICH family each video model speaks — the platform's own naming carries
*     the generation (`2.5` in the id means the seconds scheme), so the split
*     needs no table.
*
* The catalog lists two families that speak MUTUALLY EXCLUSIVE parameter
* systems: the V2.0 family (`agnes-video-v2.0`) takes `width` / `height` /
* `num_frames` / `frame_rate` (`video-protocol.ts`), and the 2.5 family
* (`agnes-video-2.5` / `agnes-video-2.5-flash`) takes `mode` / `seconds` /
* `size` / `aspect_ratio` (`video-protocol-25.ts`). {@link pickVideoModel}
* may address EITHER family, and the tool dispatches the matching body
* builder per model. `2.5-flash` is tighter (720P only, ≤5 reference images)
* and is converged by {@link isVideo25Flash} rather than being silently sent
* a 400.
*
* @module dsh-connect-agnes-token-plan/video-models
*/
/**
* Whether a model id belongs to the 2.5 family (a DIFFERENT parameter system).
*
* The platform's own naming carries the generation, so the split needs no
* table: anything with `2.5` in it speaks `mode`/`seconds`/`size`, everything
* else speaks the V2.0 `width`/`num_frames`/`frame_rate` system.
* @param {string} model - the catalog id.
* @returns {boolean}
*/
function isVideo25Family(model) {
	return /2\.5/.test(str(model, ""));
}
/**
* Whether a model id is the `-flash` variant of the 2.5 family.
*
* Flash is the same parameter system with TIGHTER limits (720P only, ≤5
* reference images); the split is by name, the same no-table approach as
* {@link isVideo25Family}.
* @param {string} model - the catalog id.
* @returns {boolean}
*/
function isVideo25Flash(model) {
	return isVideo25Family(model) && /flash/i.test(str(model, ""));
}
/**
* The video-generation model ids of one catalog, de-duplicated in first-seen order.
*
* Recognition is delegated to `modality.ts`, so this list and the chat roster
* can never disagree about which entries exist.
* @param {object[]} entries - the normalized catalog entries.
* @returns {string[]}
*/
function videoGenModelIds(entries) {
	const position = /* @__PURE__ */ new Map();
	const out = [];
	for (const entry of Array.isArray(entries) ? entries : []) {
		if (!isVideoGenModel(entry)) continue;
		const id = str(entry?.id, "");
		if (id === "") continue;
		if (position.has(id)) out[position.get(id)] = id;
		else {
			position.set(id, out.length);
			out.push(id);
		}
	}
	return out;
}
/**
* The subset of video ids this module can actually address — the V2.0 family.
* @param {object[]} entries - the normalized catalog entries.
* @returns {string[]}
*/
function videoV2ModelIds(entries) {
	return videoGenModelIds(entries).filter((id) => !isVideo25Family(id));
}
/**
* The subset of video ids that speak the 2.5 parameter system
* (`mode` / `seconds` / `size` / `aspect_ratio`).
* @param {object[]} entries - the normalized catalog entries.
* @returns {string[]}
*/
function video25ModelIds(entries) {
	return videoGenModelIds(entries).filter((id) => isVideo25Family(id));
}
/**
* Choose the model one video call addresses.
*
* Precedence mirrors `pickDrawModel`: an explicitly requested id wins even when
* the catalog does not list it (a manual override — the platform answers the
* error itself if the id is wrong), then the configured preference when the
* catalog confirms it (ANY family — a 2.5 preference is honoured, because the
* tool now drives both systems), then the auto-pick: the first V2.0 id, and
* only when the catalog holds NO V2.0 model at all does it fall through to the
* first 2.5 id. An empty catalog yields `null`, and the caller turns that into
* an actionable message rather than dispatching a request.
* @param {object[]} entries - the normalized catalog entries.
* @param {string} [requested] - the tool call's `model` parameter.
* @param {string} [preferred] - the configured default (`videoModelId`).
* @returns {string|null} the chosen id, or `null` when nothing can be picked.
*/
function pickVideoModel(entries, requested, preferred) {
	const want = str(requested, "").trim();
	if (want !== "") return want;
	const allVideo = videoGenModelIds(entries);
	if (allVideo.length === 0) return null;
	const config = str(preferred, "").trim();
	if (config !== "" && allVideo.includes(config)) return config;
	const v2 = videoV2ModelIds(entries);
	if (v2.length > 0) return v2[0];
	return allVideo[0];
}

//#endregion
//#region src/host/snapshot-aggregate.ts
/**
* The snapshot route's DATA AGGREGATION — the peer-free pure half.
*
* Keeps the router to only the HTTP surface (route registration, the trust
* fence, body reading, the `writeJson` responses) while the polling-side
* decisions — fetching through the cache, parsing the quota/usage/catalog
* sources, computing shape warnings, identifying vision models, building the
* `llm` status block — live here as one testable function.
*
* ## What Agnes actually reports
*
* The platform allocates quota by WINDOW, account-wide, on four dimensions
* (`requests5h` / `requestsWeekly` / `imagesDaily` / `videoDaily`) — there is
* no credit balance and no per-model split. Two consequences shape this file:
*
* 1. **No "remaining" is computed.** The console reports cumulative usage
*    (`/api/usage/overview`) and per-bucket usage (`/api/usage/series`); a
*    rolling 5-hour window cannot be derived from either. Printing
*    `limit - total` would be a fabricated number, so the limits and the
*    consumed totals are reported as two separate facts and the panel labels
*    them as such.
* 2. **Nothing is silently dropped from the picker.** Per-model exhaustion
*    does not exist here, so `unavailableModelIds` is empty by design rather
*    than by omission — see `rosterWithAvailability`.
*
* Every console source is fetched with the SAME failure policy: all five
* degrade, and each degradation is reported through `quota.error` while the
* sources that answered still render. The account's usage overview is not
* exempt — it is the auth probe (`quota.consoleConnected` is its outcome), but
* letting it reject the snapshot made the panel all-or-nothing: a console that
* was never signed in blanked every console-backed tab. A partial screen beats
* a full-page error, and an absent module must leave the rest usable
* (ARCHITECTURE.md §5).
*
* Pure by design: it takes the resolved `settings`, the shared `cache` /
* `inflight` maps, the `tokenStore`, the `apiKeyStore`, the `publisher` (from
* `provider-publish.ts`) and the `catalogStore`, and returns the exact
* snapshot body the route writes. No HTTP surface, no filesystem writes, no
* module-level state — so `test/routes.test.mjs` can pin every branch (the
* snapshot contract, the vision-vs-catalog distinction, the registration
* re-publish) without mounting the full container.
*
* @module dsh-connect-agnes-token-plan/snapshot-aggregate
*/
/** The authenticated console paths this poll reads. */
const USAGE_OVERVIEW_PATH = "/api/usage/overview";
const USAGE_SERIES_PATH = "/api/usage/series";
const SUBSCRIPTION_PATH = "/api/cn/user/subscription";
/**
* The date window the usage series is asked for, as `YYYY-MM-DD` (UTC).
*
* The series endpoint takes DATES, not timestamps (`start_date` / `end_date`),
* which is why the window is measured in days and not in the hours the
* SenseNova trend used. Snapping to whole days also makes the URL stable for
* the whole day, so the long series cache actually hits instead of
* re-fetching the console on every poll.
* @param {number} days - how many days back to ask for, inclusive of today.
* @param {number} [nowMs] - the reference instant (injectable for tests).
* @returns {{startDate: string, endDate: string}} the window bounds.
*/
function usageWindow(days, nowMs = Date.now()) {
	const span = Math.max(1, Math.floor(days)) - 1;
	const format = (ms) => new Date(ms).toISOString().slice(0, 10);
	return {
		startDate: format(nowMs - span * 864e5),
		endDate: format(nowMs)
	};
}
/**
* Run one console fetch, reporting its failure instead of throwing.
*
* Used for EVERY source, the account's usage overview included. It once
* excepted the overview, on the theory that the auth probe should stay fatal
* because the route's catch is what puts the sign-in form on screen — but that
* made the whole panel all-or-nothing: one missing module (the console) took
* down every console-backed tab. That
* is the exact shape ARCHITECTURE.md §5 forbids: a module that is absent must
* leave the panel usable, not blank it.
*
* So a failure becomes `{value: null, error}` everywhere. The panel renders the
* sources that did arrive, names the one that did not, and keeps the tabs
* reachable — and a signed-out Host still serves the API-key half (the model
* catalogue and the provider/draw switches), which is the one combination that
* made "I only want the models, not the quota" impossible.
* @param {() => Promise<unknown>} run - the fetch to attempt.
* @returns {Promise<{value: unknown, error: Error|null}>} the outcome.
*/
async function soft(run) {
	try {
		return {
			value: await run(),
			error: null
		};
	} catch (error) {
		return {
			value: null,
			error: error instanceof Error ? error : new Error(String(error))
		};
	}
}
/**
* The panel's projection of one catalogue entry: no `featureTexts`, no
* envelope leftovers — only the fields the quota screen reads or compares.
* @param {object} plan - one {@link parsePlans} entry.
* @returns {object} the projection.
*/
function planSummary(plan) {
	return {
		uuid: str(plan?.uuid, ""),
		planId: Number(plan?.planId) || 0,
		name: str(plan?.name, ""),
		displayName: str(plan?.displayName, ""),
		billingCycle: str(plan?.billingCycle, ""),
		displayCycle: str(plan?.displayCycle, ""),
		priceMinor: Number(plan?.priceMinor) || 0,
		currency: str(plan?.currency, ""),
		limits: {
			requests5h: Number(plan?.concurrencyLimit) || 0,
			requestsWindowH: Number(plan?.concurrencyWindowH) || 0,
			requestsWeekly: Number(plan?.textWeeklyLimit) || 0,
			imagesDaily: Number(plan?.imageDailyLimit) || 0,
			videoDaily: Number(plan?.videoDailyLimit) || 0
		}
	};
}
/**
* The first failure among the named sources, as a secret-free report.
* @param {Array<[string, {error: Error|null}]>} sources - name/outcome pairs.
* @returns {{source: string, code: string|null, message: string}|null} the report.
*/
function firstFailure(sources) {
	for (const [source, outcome] of sources) if (outcome.error !== null) return {
		source,
		code: typeof outcome.error.code === "string" ? outcome.error.code : null,
		message: redactSecrets(outcome.error.message)
	};
	return null;
}
/**
* The operator's pseudo multiplier that names one model id, or undefined.
*
* Matching is a case-insensitive SUBSTRING of the model id, first configured
* key wins (insertion order — `resolveTrendMultipliers` preserves it). It
* rides on the panel's model roster as a `×N` badge: Agnes publishes no
* per-model usage, so the badge is the operator's own comparison aid rather
* than a figure the platform backs.
*
* @param {unknown} modelId - a model id (roster row id).
* @param {Record<string, number>} multipliers - the sanitized config map.
* @returns {number|undefined} the hit value, or undefined when nothing matched.
*/
function matchMultiplier(modelId, multipliers) {
	const id = String(modelId ?? "").toLowerCase();
	for (const [key, value] of Object.entries(multipliers || {})) if (id.includes(key.toLowerCase())) return value;
}
/**
* Fetch the four console sources plus the model catalog and aggregate them
* into the snapshot body the route writes.
*
* All five are fetched in parallel through the shared `cache` + `inflight`
* maps (a single-flight per URL so concurrent polls share one call) and the
* `tokenStore` (so a 401 triggers one renewal before the call). Only the
* catalog is authenticated by the API key instead; a missing key degrades the
* model lists, not the quota — resolved per poll so a key that arrives after
* the plugin mounted still lights the lists on the next poll.
*
* @param {object} context
* @param {object} context.settings - the resolved settings row.
* @param {Map} context.cache - the console-response cache (shared across polls).
* @param {Map} context.inflight - the single-flight map (shared across polls).
* @param {object} context.tokenStore - the `createTokenStore` instance.
* @param {object} context.apiKeyStore - the `createApiKeyStore` instance.
* @param {object} context.publisher - the `createProviderPublisher` instance.
* @param {object} context.catalogStore - the `createFileCatalogStore` instance.
* @param {() => Promise<boolean|null>} context.panelSwitch - the panel-saved
*   provider switch (`provider-store.enabled()`); null when untouched.
* @param {() => Promise<boolean|null>} context.drawSwitch - the panel-saved
*   draw-tool switch (`draw-store.enabled()`), same shape and precedence.
* @param {() => Promise<string|null>} context.drawModelId - the panel-saved
*   draw-model preference (`draw-store.modelId()`); null when untouched.
* @param {() => Promise<boolean|null>} context.videoSwitch - the panel-saved
*   video-tool switch (`video-store.enabled()`). A SEPARATE opt-in from the
*   draw switch: the two modalities are independent.
* @param {() => Promise<string|null>} context.videoModelId - the panel-saved
*   video-model preference (`video-store.modelId()`); null when untouched.
* @returns {Promise<object>} the snapshot body.
*/
async function buildSnapshotBody({ settings, cache, inflight, tokenStore, apiKeyStore, publisher, catalogStore, panelSwitch, drawSwitch, drawModelId, videoSwitch, videoModelId }) {
	const providerState = publisher.state;
	const resolveApiKey = async () => (await apiKeyStore.resolve()).value;
	const { startDate, endDate } = usageWindow(settings.usageDays);
	const overview = await soft(() => fetchConsole(settings, USAGE_OVERVIEW_PATH, void 0, settings.cacheSeconds * 1e3, cache, inflight, tokenStore));
	const [series, subscription, plans, catalog] = await Promise.all([
		soft(() => fetchConsole(settings, USAGE_SERIES_PATH, {
			range: "custom",
			start_date: startDate,
			end_date: endDate
		}, Math.max(settings.cacheSeconds, 300) * 1e3, cache, inflight, tokenStore)),
		soft(() => fetchConsole(settings, SUBSCRIPTION_PATH, void 0, settings.cacheSeconds * 1e3, cache, inflight, tokenStore)),
		soft(() => fetchPlans(settings, 36e5, cache, inflight)),
		(async () => {
			const apiKey = await resolveApiKey();
			return apiKey === "" ? null : fetchModelCatalog(settings, 36e5, cache, inflight, apiKey).catch(() => null);
		})()
	]);
	const catalogue = parsePlans(plans.value);
	const currentPlan = matchCurrentPlan(subscription.value, catalogue);
	const windowUsage = parseSubscriptionUsage(subscription.value);
	const windows = quotaWindows(currentPlan).map((window) => {
		const usage = windowUsage?.[window.key];
		if (usage === void 0) return window;
		return {
			...window,
			used: usage.used,
			usagePct: usage.usagePct,
			rangeStart: usage.rangeStart,
			rangeEnd: usage.rangeEnd,
			resetAt: usage.resetAt,
			resetInSeconds: usage.resetInSeconds
		};
	});
	const quota = {
		plan: currentPlan === null ? null : planSummary(currentPlan),
		windows,
		totals: overview.value === null ? null : parseUsageOverview(overview.value),
		plans: catalogue.map(planSummary),
		expiresAt: readSubscriptionExpiry(subscription.value),
		consoleConnected: overview.value !== null,
		error: firstFailure([
			["usage-overview", overview],
			["series", series],
			["subscription", subscription],
			["plans", plans]
		])
	};
	const usage = series.value === null ? null : (() => {
		const parsed = parseUsageSeries(series.value, settings.usageDays);
		return {
			days: parsed.days,
			windowTotals: parsed.totals,
			buckets: parsed.buckets
		};
	})();
	const shapeWarnings = [
		...overview.value === null ? [] : checkShape(overview.value, "usage-overview").missing.map((key) => ({
			api: "usage-overview",
			missing: key
		})),
		...series.value === null ? [] : checkShape(series.value, "usage-series").missing.map((key) => ({
			api: "usage-series",
			missing: key
		})),
		...plans.value !== null && !Array.isArray(plans.value) ? [{
			api: "plans",
			missing: "array"
		}] : []
	];
	const catalogIds = Array.isArray(catalog) ? catalog.map((entry) => entry.id) : [];
	const unavailableModelIds = [];
	const visionModels = Array.isArray(catalog) ? catalog.map((entry) => visionOf(entry)).filter((entry) => entry.vision) : void 0;
	const keyState = await apiKeyStore.state().catch(() => ({
		hasApiKey: false,
		keySource: null,
		ephemeral: false
	}));
	const effectiveDrawModelId = await drawModelId?.().catch(() => null) ?? str(settings.drawModelId, "");
	const effectiveVideoModelId = await videoModelId?.().catch(() => null) ?? str(settings.videoModelId, "");
	const providerSwitch = resolveSwitchEnabled(await readPanelValue(panelSwitch), settings.registerProvider);
	const drawResolution = resolveSwitchEnabled(await readPanelValue(drawSwitch), settings.drawEnabled);
	const videoResolution = resolveSwitchEnabled(await readPanelValue(videoSwitch), settings.videoEnabled);
	const enabledIds = await catalogStore.listEnabledIds().catch(() => providerState.enabledIds);
	let offered = providerState.entries;
	let catalogChanged = false;
	if (Array.isArray(catalog)) {
		const freshSignature = catalogSignature(catalog, enabledIds);
		if (freshSignature !== providerState.signature) {
			catalogChanged = true;
			if (await catalogStore.replace(catalog, enabledIds).catch(() => false)) providerState.signature = freshSignature;
			await publisher.publish(catalog, enabledIds, unavailableModelIds);
		}
		offered = catalog;
	}
	const quotaSig = [...unavailableModelIds].sort().join(",");
	if (quotaSig !== providerState.quotaSignature) {
		providerState.quotaSignature = quotaSig;
		if (!catalogChanged) await publisher.publish(providerState.entries, providerState.enabledIds, unavailableModelIds);
	}
	const summary = summarizeCatalog(filterByEnabled(offered, enabledIds));
	const llmStatus = {
		...keyState,
		registerProvider: providerSwitch.enabled,
		registerSource: providerSwitch.source,
		llmAvailable: providerState.llmAvailable,
		providerRegistered: providerState.registered,
		providerId: LLM_PROVIDER_ID,
		modelCount: summary.modelCount,
		visionCount: summary.visionCount,
		thinkingDefault: DEFAULT_REASONING_EFFORT,
		models: rosterWithAvailability(offered, unavailableModelIds).map((row) => {
			const multiplier = matchMultiplier(row.id, settings.trendMultipliers);
			return multiplier === void 0 ? row : {
				...row,
				multiplier
			};
		}),
		enabledModelIds: enabledIds,
		quotaBlockedModelIds: unavailableModelIds,
		drawEnabled: drawResolution.enabled,
		drawSource: drawResolution.source,
		...Array.isArray(catalog) ? (() => {
			const candidates = imageGenModelIds(catalog);
			return {
				drawModel: pickDrawModel(catalog, "", effectiveDrawModelId) ?? void 0,
				drawCandidateCount: candidates.length,
				drawCandidateIds: candidates,
				...effectiveDrawModelId !== "" ? { drawPreferredModel: effectiveDrawModelId } : {}
			};
		})() : {},
		videoEnabled: videoResolution.enabled,
		videoSource: videoResolution.source,
		...Array.isArray(catalog) ? (() => {
			const candidates = videoGenModelIds(catalog);
			return {
				videoModel: pickVideoModel(catalog, "", effectiveVideoModelId) ?? void 0,
				videoCandidateCount: candidates.length,
				videoCandidateIds: candidates,
				video25ModelIds: video25ModelIds(catalog),
				...effectiveVideoModelId !== "" ? { videoPreferredModel: effectiveVideoModelId } : {}
			};
		})() : {},
		...providerState.error !== null ? { providerError: providerState.error } : {}
	};
	return {
		ok: true,
		now: Date.now(),
		consoleBase: settings.consoleBase,
		cacheSeconds: settings.cacheSeconds,
		pollSeconds: settings.pollSeconds,
		auth: await tokenStore.state(),
		catalogAvailable: Array.isArray(catalog),
		catalogModels: catalogIds,
		...visionModels !== void 0 ? { visionModels } : {},
		llm: llmStatus,
		quota,
		usage,
		shapeWarnings
	};
}

//#endregion
//#region src/host/routes/http.ts
/**
* The HTTP primitives shared by every route of the family: the JSON shape,
* the bounded body reader, and the two standard refusals.
*
* Extracted in the routes split (the token-store playbook: behaviour frozen
* first — `routes.test.mjs` and `agnescode.test.mjs` ran green against the
* `routes.ts` facade before and after the move). Handlers keep exactly the
* behaviour they had inline; only the wording of the fence/method refusals
* and the body ceilings lives here, so a route cannot drift its own 403.
*
* Nothing here imports a Host peer.
*
* @module dsh-connect-agnes-token-plan/routes/http
*/
/** Family default response headers for a JSON route. */
const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"referrer-policy": "no-referrer"
};
/** Write one JSON response with the family headers. */
function writeJson(res, status, body, headers = {}) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		...JSON_HEADERS,
		...headers
	});
	res.end(payload);
}
/** Ceiling on a submitted account, so a hostile page cannot stream a body. */
const MAX_ACCOUNT_BODY_BYTES = 4096;
/**
* Read a small JSON request body, refusing anything oversized.
*
* The account form is the only thing that posts here, so the ceiling is tiny
* and the reader is deliberately dull: no content-type negotiation, no
* streaming, just a bounded collect and a parse.
* @param request - the incoming HTTP request.
* @param limit - the byte ceiling.
* @returns {Promise<{ok: true, value: object} | {ok: false, error: string}>}
*/
async function readJsonBody(request, limit = MAX_ACCOUNT_BODY_BYTES) {
	const chunks = [];
	let received = 0;
	try {
		for await (const chunk of request) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			received += buffer.byteLength;
			if (received > limit) return {
				ok: false,
				error: "request body is too large"
			};
			chunks.push(buffer);
		}
	} catch {
		return {
			ok: false,
			error: "could not read the request body"
		};
	}
	if (chunks.length === 0) return {
		ok: false,
		error: "a JSON body is required"
	};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {
			ok: false,
			error: "the body must be a JSON object"
		};
		return {
			ok: true,
			value: parsed
		};
	} catch {
		return {
			ok: false,
			error: "the body is not valid JSON"
		};
	}
}
/**
* Refuse a request the trust fence rejects, with the one body the panel reads.
*
* Every route opens with the identical line, so the wording and the 403 shape
* live in one place: a route that forgets the fence, or words it differently,
* is now the odd one out rather than a second truth.
* @param response - the outgoing HTTP response.
* @returns {void}
*/
function refuseOrigin(response) {
	writeJson(response, 403, {
		ok: false,
		error: "forbidden: origin mismatch"
	});
}
/**
* Refuse a disallowed method with the family's 405 shape.
*
* The 405 carries no `cache-control`: unlike a snapshot, a method refusal is
* not a fresh answer anyone would want to keep, so there is nothing to tell a
* cache not to store.
* @param response - the outgoing HTTP response.
* @returns {void}
*/
function refuseMethod(response) {
	writeJson(response, 405, {
		ok: false,
		error: "method not allowed"
	});
}
/**
* Read and validate a JSON body, or answer 400 and signal the caller to stop.
*
* Collapses the "read body -> not ok ? write 400 and return" block every POST
* route repeats. Returns the `readJsonBody` result on success (so callers keep
* reading the parsed object through `body.value`, exactly as before), or `null`
* after it has already written the 400 — a `null` is the caller's cue to return.
* @param request - the incoming HTTP request.
* @param response - the outgoing HTTP response (written on failure).
* @returns {Promise<object|null>} the read result, or null if a 400 was sent.
*/
async function readJsonBodyOr400(request, response) {
	const body = await readJsonBody(request);
	if (!body.ok) {
		writeJson(response, 400, {
			ok: false,
			error: /** @type {{ok: false, error: string}} */ body.error
		}, { "cache-control": "no-store" });
		return null;
	}
	return body;
}

//#endregion
//#region src/host/routes/snapshot.ts
/**
* The snapshot route — the one read-only route the Client panel polls.
*
* Part of the routes split (see `../routes.ts` for the family map). The
* aggregation itself lives in `snapshot-aggregate.ts`; this module is the
* HTTP edge: the trust fence, the config-error short-circuit, the vision
* write-back, and the last-resort `ok:false` shape with its code taxonomy.
*
* @module dsh-connect-agnes-token-plan/routes/snapshot
*/
/** The one read-only route the Client panel polls. */
const SNAPSHOT_PATH = `/api/${name}/snapshot`;
/**
* Map a thrown console/auth error to the one code the panel branches on.
*
* A raw error message carries no intent, so the panel keys its guidance off
* this taxonomy instead: `not_configured` (the user can fix it) and
* `jwt_expired` (renewal already failed) pass through verbatim because the
* panel words them differently from every other case; an auth-shaped failure
* becomes `auth_error`; anything else is a console failure, which usually
* self-heals on the next poll.
* @param {unknown} error - the error a fetch or parse threw.
* @returns {string} the panel-facing code.
*/
function failureCode(error) {
	const code = error && typeof error === "object" ? error.code : void 0;
	if (code === CODE.NOT_CONFIGURED || code === CODE.JWT_EXPIRED) return code;
	return isAuthFailure(error) ? CODE.AUTH_ERROR : CODE.CONSOLE_ERROR;
}
/**
* Register the snapshot route. Wiring subset: `settings`, `configError`,
* `cache`, `inflight`, `tokenStore`, `apiKeyStore`, `publisher`,
* `catalogStore`, `providerStore`, `drawStore`, `videoStore`,
* `visionPublish`, `logger`.
* @param ctx - the host root context (only `ctx.webServer` is used here).
* @param {object} wiring - as assembled by `apply()` in `index.ts`.
* @returns {Function} the `off()` unregister callback.
*/
function registerSnapshotRoute(ctx, wiring) {
	const { settings, configError, cache, inflight, tokenStore, apiKeyStore, catalogStore, providerStore, drawStore, videoStore, publisher, visionPublish, logger } = wiring;
	return ctx.webServer.register({
		kind: "exact",
		path: SNAPSHOT_PATH,
		handler: async (request, response) => {
			if (!isAdmitted(request, settings.allowedHosts)) {
				refuseOrigin(response);
				return;
			}
			if (request.method !== void 0 && request.method !== "GET" && request.method !== "HEAD") {
				refuseMethod(response);
				return;
			}
			if (configError !== null) {
				writeJson(response, 200, {
					ok: false,
					code: CODE.CONFIG_ERROR,
					error: configError,
					auth: await tokenStore.state().catch(() => null)
				}, { "cache-control": "no-store" });
				return;
			}
			try {
				const body = await buildSnapshotBody({
					settings,
					cache,
					inflight,
					tokenStore,
					apiKeyStore,
					publisher,
					catalogStore,
					panelSwitch: () => providerStore.enabled().catch(() => null),
					drawSwitch: async () => drawStore ? await drawStore.enabled().catch(() => null) : null,
					drawModelId: async () => drawStore ? await drawStore.modelId().catch(() => null) : null,
					videoSwitch: async () => videoStore ? await videoStore.enabled().catch(() => null) : null,
					videoModelId: async () => videoStore ? await videoStore.modelId().catch(() => null) : null
				});
				if (body.visionModels !== void 0) visionPublish.current?.(body.visionModels, body.visionModels.map((entry) => entry.id)).catch((error) => {
					logger?.warn?.(`${name}: vision model list write failed: ${redactError(error)}`);
				});
				writeJson(response, 200, body, { "cache-control": "no-store" });
			} catch (error) {
				writeJson(response, 200, {
					ok: false,
					error: redactError(error),
					code: failureCode(error),
					auth: await tokenStore.state().catch(() => null)
				}, { "cache-control": "no-store" });
			}
		}
	});
}

//#endregion
//#region src/host/admission-audit.ts
/**
* Admission audit —— 让「不带 Origin 的写请求」事后可见。
*
* 同源闸（`host-config.ts` 的 `isAdmitted`）在 `Origin` 缺失时放行，这是**刻意**
* 的：浏览器的同站 GET 不发 `Origin`，而跨站 POST 必然发、发了就被比对拦掉。
* 所以那条分支上过的是**非浏览器客户端**（脚本 / curl / 本地进程），而它们本来
* 就能自己伪造 `Origin` 与 `Host`——补一条"写方法必须带 Origin"的规则不会增加
* 任何安全性，只会给"无源脚本"制造摩擦，外加一个"面板被代理剥掉 Origin 就全站
* 403"的功能性风险。
*
* 真正该做的是**让这条分支上的写请求留下痕迹**：它一旦被滥用（尤其
* `/agnescode`——一次无凭证 POST 就会触发本机 DPAPI 解密、凭据落库、provider
* 注册），事后必须能回答"有没有发生过"，而不是靠猜。
*
* 记录的内容刻意**不含任何值**：只有次数、最后一次的时间、与一个归一化后的
* 方法名。没有 Host / Origin / 路径 / 头值/ 凭据——这个文件要能被 `doctor`
* 读出来贴进工单，所以它必须生来就是可贴的。
*
* 与 `throttle-store` 同款：**故意不按 profile 分段**（PITFALLS §23）。这是
* "这台机器上是否有人打过无源写"的问题，不是某个 profile 的偏好。
* @module dsh-connect-agnes-token-plan/admission-audit
*/
/** 载荷形状版本。改动形状时 +1，旧文件按"无记录"读（见 `parse`）。 */
const ADMISSION_AUDIT_VERSION = 1;
/** 落盘文件名（`doctor` 按显式 home 读它，所以需要可导出）。 */
const ADMISSION_AUDIT_FILE = "admission-audit.json";
const FILE = ADMISSION_AUDIT_FILE;
/**
* Where the audit lives: the SHARED directory, `$DSH_HOME/state/<plugin>`.
*
* 同 `throttleDir()`——见该文件头注：这是机器级事实，不是 profile 偏好。
* @returns {string} the directory.
*/
function admissionAuditDir() {
	return stateDir(name);
}
/**
* 归一化一个 HTTP 方法名，只保留可信形状。
*
* 方法名来自请求头，是**外部输入**：直接落盘等于让别人往我们自己的状态文件里
* 写任意字符串（长度、编码、换行都能做文章）。所以只接受大写字母，超长截断，
* 其余一律 `OTHER`——排查只需要知道"是 POST 还是别的"，不需要原文。
* @param {unknown} method
* @returns {string}
*/
function normalizeMethod(method) {
	if (typeof method !== "string") return "OTHER";
	const upper = method.toUpperCase();
	return /^[A-Z]{3,8}$/.test(upper) ? upper : "OTHER";
}
/**
* 解析一条审计记录，`null` 表示"无记录"（缺席 / 损坏 / 外来版本）。
*
* 与节流同源的取舍方向：认不出来就读作"没发生过"。审计是**排查辅助**，不是闸
* 的一部分——它坏了不能让路由失败，也不能让 `doctor` 报出一个假的"发生过"。
* @param {unknown} raw
* @returns {{version: number, count: number, lastAt: number, lastMethod: string}|null}
*/
function parseAdmissionAudit(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const body = raw;
	if (body.version !== 1) return null;
	const count = typeof body.count === "number" && Number.isFinite(body.count) && body.count > 0 ? Math.floor(body.count) : 0;
	const lastAt = typeof body.lastAt === "number" && Number.isFinite(body.lastAt) && body.lastAt > 0 ? Math.floor(body.lastAt) : 0;
	if (count <= 0 && lastAt <= 0) return null;
	return {
		version: 1,
		count,
		lastAt,
		lastMethod: typeof body.lastMethod === "string" ? normalizeMethod(body.lastMethod) : "OTHER"
	};
}
/**
* 会改变状态的方法（除了这几个都算）。
*
* 判断是"不安全的才算写"，而不是"POST/PUT/DELETE 才算"：方法名是外部输入，
* 且账号路由（`routes/account.ts`）把**缺失**方法也当 POST 处理（那是为了照顾不带 method 的
* 客户端）。用黑名单（只放行安全的）能保证"没有方法"也被记成一次写——审计宁可
* 多记，不可漏记。
* @param {unknown} method
* @returns {boolean}
*/
function isStateChanging(method) {
	if (typeof method !== "string" || method === "") return true;
	return ![
		"GET",
		"HEAD",
		"OPTIONS",
		"TRACE"
	].includes(method.toUpperCase());
}
/**
* 同源闸 + 审计：写路由用这个替代直接调 `isAdmitted`。
*
* 放行结论与 `isAdmitted` **逐位相同**——审计挂在旁边，不改变任何一次请求的
* 命运。它只在"放行 + 未声明 Origin + 会改状态"这三个条件同时成立时落一笔；
* 那正是"非浏览器客户端在写"的分支，也是本机进程唯一能无声无息改掉凭据的入口。
* @param {{headers: {host?: string, origin?: unknown}, method?: string}} request
* @param {Set<string>} allowedHosts
* @param {{dir?: string, now?: () => number}} [options] - 透传给 `recordOriginlessWrite`
*   （测试用它指向临时目录，避免写进真实 state）。
* @returns {boolean} whether the request may be served（同 `isAdmitted`）。
*/
function isAdmittedWithAudit(request, allowedHosts, options = {}) {
	const admitted = isAdmitted(request, allowedHosts);
	if (admitted && isStateChanging(request?.method)) {
		const origin = request?.headers?.origin;
		if (!(typeof origin === "string" && origin !== "" && origin !== "null")) recordOriginlessWrite(request?.method, options);
	}
	return admitted;
}
/**
* 记一次"不带 Origin 的写请求"。
*
* Fire-and-forget 且**永不抛**：审计是旁路的，它不能影响请求本身——写文件失败、
* 目录不可建、并发写撞车，一律吞掉。计数采用"读-改-写"并且**不重试**：丢一次
* 计数只是让数字偏小，而为了精确去加重试/加锁会把一个诊断件变成热路径上的
* 竞争源，代价与收益不成比例。
* @param {unknown} method - 请求方法（会被 `normalizeMethod` 收敛）。
* @param {{dir?: string, now?: () => number}} [options]
* @returns {Promise<void>}
*/
async function recordOriginlessWrite(method, options = {}) {
	const dir = options.dir ?? admissionAuditDir();
	const now = options.now ?? Date.now;
	const lastMethod = normalizeMethod(method);
	try {
		await ensureStateDir(dir);
		const file = join(dir, FILE);
		const previous = parseAdmissionAudit(await readStateJson(file).catch(() => null));
		const payload = {
			version: 1,
			count: (previous?.count ?? 0) + 1,
			lastAt: now(),
			lastMethod
		};
		const temporary = temporaryOf(dir, FILE);
		await writeStateFile(file, JSON.stringify(payload), { temporary });
	} catch {}
}

//#endregion
//#region src/host/trace.ts
/**
* Login-trace persistence.
*
* Every sign-in attempt (success included) leaves one sanitized trace file in
* `$DSH_HOME/logs/`: a "browser works but the panel does not" report is only
* debuggable by diffing a working trace against a failing one. The sanitizing
* itself happens in `agnes-auth.ts` — no password, token, cookie, or
* authorization code ever reaches this module — so the only concern here is
* I/O failures, which must never break the login response.
* @module dsh-connect-agnes-token-plan/trace
*/
/**
* Where login traces are written. `$DSH_HOME/logs/` keeps them next to the
* other Host logs; `DSH_HOME` defaults to `~/.dsh`.
*/
function traceDir() {
	const home = str(process.env.DSH_HOME, join(homedir(), ".dsh"));
	return join(home, "logs");
}
/**
* Persist one login trace to disk, or fail silently.
*
* Written on EVERY attempt (success included): a "browser works but the panel
* does not" report is only debuggable by diffing a working trace against a
* failing one. The trace itself is already sanitized in Agnes-auth — no
* password, token, cookie, or authorization code ever reaches this file — so
* the only concerns here are I/O failures, which must never break the login
* response.
* @param {object[]|undefined} trace - the sanitized hop list from the auth module.
* @param {string} outcome - "ok" or the error code, for the filename.
* @returns {Promise<string|null>} the file path, or null when not written.
*/
async function writeLoginTrace(trace, outcome) {
	if (!Array.isArray(trace) || trace.length === 0) return null;
	try {
		const dir = traceDir();
		await promises.mkdir(dir, { recursive: true });
		const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
		const file = join(dir, `agnes-login-${stamp}-${str(outcome, "unknown").replace(/[^a-z_]/gi, "")}.json`);
		await promises.writeFile(file, `${JSON.stringify(trace, null, 2)}\n`, {
			encoding: "utf8",
			mode: 384
		});
		const files = (await promises.readdir(dir)).filter((name) => name.startsWith("agnes-login-")).sort();
		for (const stale of files.slice(0, Math.max(0, files.length - 20))) await promises.rm(join(dir, stale), { force: true }).catch(() => {});
		return file;
	} catch {
		return null;
	}
}

//#endregion
//#region src/host/routes/account.ts
/**
* The account route: the panel configures itself without editing `.env`.
*
* Part of the routes split (see `../routes.ts` for the family map). The
* credential red lines live here in their HTTP form: the GET and every error
* answer carry `tokenStore.state()` — shape facts only, never the password;
* a rejected login persists the sanitized trace and reports the platform's
* own words plus any `retryAfterMs` window so the panel can grey the form out
* instead of letting the user knock an account into lockout.
*
* @module dsh-connect-agnes-token-plan/routes/account
*/
/** The account route: the panel configures itself without editing `.env`. */
const ACCOUNT_PATH = `/api/${name}/account`;
/**
* Register the account route. Wiring subset: `settings`, `cache`, `tokenStore`.
* @param ctx - the host root context (only `ctx.webServer` is used here).
* @param {object} wiring - as assembled by `apply()` in `index.ts`.
* @returns {Function} the `off()` unregister callback.
*/
function registerAccountRoute(ctx, wiring) {
	const { settings, cache, tokenStore } = wiring;
	return ctx.webServer.register({
		kind: "exact",
		path: ACCOUNT_PATH,
		handler: async (request, response) => {
			if (!isAdmittedWithAudit(request, settings.allowedHosts)) {
				refuseOrigin(response);
				return;
			}
			const method = request.method === void 0 ? "POST" : request.method;
			if (method === "GET") {
				writeJson(response, 200, {
					ok: true,
					...await tokenStore.state()
				}, { "cache-control": "no-store" });
				return;
			}
			if (method !== "POST") {
				refuseMethod(response);
				return;
			}
			const body = await readJsonBodyOr400(request, response);
			if (body === null) return;
			if (body.value.forget === true) {
				try {
					await tokenStore.forgetAccount();
				} catch (error) {
					writeJson(response, 200, {
						...await tokenStore.state().catch(() => null),
						ok: false,
						error: redactError(error)
					}, { "cache-control": "no-store" });
					return;
				}
				cache.clear();
				writeJson(response, 200, {
					...await tokenStore.state(),
					ok: true
				}, { "cache-control": "no-store" });
				return;
			}
			try {
				await tokenStore.saveAccount({
					username: body.value.username,
					password: body.value.password
				});
			} catch (error) {
				const failure = error;
				const traceFile = await writeLoginTrace(failure?.trace, str(failure?.code, CODE.AUTH_ERROR));
				writeJson(response, 200, {
					...await tokenStore.state().catch(() => null),
					ok: false,
					code: str(failure?.code, CODE.AUTH_ERROR),
					error: redactError(error),
					...failure?.detail === void 0 ? {} : { detail: redactSecrets(String(failure.detail)) },
					...traceFile !== null ? { traceFile } : {},
					...typeof failure?.retryAfterMs === "number" ? { retryAfterMs: failure.retryAfterMs } : {}
				}, { "cache-control": "no-store" });
				return;
			}
			cache.clear();
			writeJson(response, 200, {
				...await tokenStore.state(),
				ok: true
			}, { "cache-control": "no-store" });
		}
	});
}

//#endregion
//#region src/host/routes/api-key.ts
/**
* The inference API-key route (`sk-…`) — step three of the one-stop plan.
*
* Part of the routes split (see `../routes.ts` for the family map). The
* secret-free discipline holds at this edge: every answer carries
* `apiKeyStore.state()` (present or not, which source), never the key; a
* forget drops the REFERENCE and every cached answer that was fetched with
* the old key, then publishes the empty offer.
*
* @module dsh-connect-agnes-token-plan/routes/api-key
*/
/** The inference API-key route (`sk-…`), step three of the one-stop plan. */
const API_KEY_PATH = `/api/${name}/api-key`;
/**
* Register the API-key route. Wiring subset: `settings`, `apiKeyStore`,
* `catalogStore`, `cache`, `providerState`, `publishProvider`, `logger`.
* @param ctx - the host root context (only `ctx.webServer` is used here).
* @param {object} wiring - as assembled by `apply()` in `index.ts`.
* @returns {Function} the `off()` unregister callback.
*/
function registerApiKeyRoute(ctx, wiring) {
	const { settings, apiKeyStore, catalogStore, cache, providerState, publishProvider, logger } = wiring;
	return ctx.webServer.register({
		kind: "exact",
		path: API_KEY_PATH,
		handler: async (request, response) => {
			if (!isAdmittedWithAudit(request, settings.allowedHosts)) {
				refuseOrigin(response);
				return;
			}
			const method = request.method === void 0 ? "GET" : request.method;
			const answer = async (extra = {}) => writeJson(response, 200, {
				ok: true,
				...await apiKeyStore.state().catch(() => ({
					hasApiKey: false,
					keySource: null,
					ephemeral: false
				})),
				...extra
			}, { "cache-control": "no-store" });
			if (method === "GET") {
				await answer();
				return;
			}
			if (method !== "POST") {
				refuseMethod(response);
				return;
			}
			const body = await readJsonBodyOr400(request, response);
			if (body === null) return;
			if (body.value.forget === true) {
				try {
					await apiKeyStore.forget();
					if (await catalogStore.clear().catch(() => false) === false) logger?.warn?.(`${name}: catalog cache clear failed after api-key forget; the next poll may still offer the old models`);
					cache.clear();
					providerState.signature = "";
					providerState.quotaSignature = "";
					await publishProvider([], [], []);
					await answer();
				} catch (error) {
					await answer({
						ok: false,
						error: redactError(error)
					});
				}
				return;
			}
			try {
				await apiKeyStore.save(body.value.apiKey);
			} catch (error) {
				await answer({
					ok: false,
					error: redactError(error)
				});
				return;
			}
			cache.clear();
			await answer();
		}
	});
}

//#endregion
//#region src/host/routes/provider.ts
/**
* The provider-registration switch route (docs/PROVIDER-HOT-RELOAD.md).
*
* Part of the routes split (see `../routes.ts` for the family map). Secret-free
* by construction: the effective switch, its source, and whether a provider is
* registered right now. A save publishes immediately with the CURRENT catalog —
* the switch decides whether the models are offered, not what they are; a
* failed publish rolls back inside `publishProvider`.
*
* @module dsh-connect-agnes-token-plan/routes/provider
*/
/** The provider-registration switch route (docs/PROVIDER-HOT-RELOAD.md). */
const PROVIDER_PATH = `/api/${name}/provider`;
/**
* Register the provider switch route. Wiring subset: `settings`,
* `providerStore`, `providerState`, `publishProvider`.
* @param ctx - the host root context (only `ctx.webServer` is used here).
* @param {object} wiring - as assembled by `apply()` in `index.ts`.
* @returns {Function} the `off()` unregister callback.
*/
function registerProviderRoute(ctx, wiring) {
	const { settings, providerStore, providerState, publishProvider } = wiring;
	return ctx.webServer.register({
		kind: "exact",
		path: PROVIDER_PATH,
		handler: async (request, response) => {
			if (!isAdmittedWithAudit(request, settings.allowedHosts)) {
				refuseOrigin(response);
				return;
			}
			const method = request.method === void 0 ? "GET" : request.method;
			const answer = async (extra = {}) => {
				const providerSwitch = resolveSwitchEnabled(await readPanelValue(() => providerStore.enabled()), settings.registerProvider);
				writeJson(response, 200, {
					ok: true,
					registerProvider: providerSwitch.enabled,
					registerSource: providerSwitch.source,
					providerRegistered: providerState.registered,
					...providerState.error !== null ? { providerError: providerState.error } : {},
					...extra
				}, { "cache-control": "no-store" });
			};
			if (method === "GET") {
				await answer();
				return;
			}
			if (method !== "POST") {
				refuseMethod(response);
				return;
			}
			const body = await readJsonBodyOr400(request, response);
			if (body === null) return;
			if (typeof body.value.enabled !== "boolean") {
				writeJson(response, 400, {
					ok: false,
					error: "expected { enabled: boolean }"
				}, { "cache-control": "no-store" });
				return;
			}
			try {
				await providerStore.save(body.value.enabled);
				await publishProvider(providerState.entries, providerState.enabledIds, providerState.unavailableIds ?? []);
			} catch (error) {
				await answer({
					ok: false,
					error: redactError(error)
				});
				return;
			}
			await answer();
		}
	});
}

//#endregion
//#region src/host/routes/models.ts
/**
* The model-roster route (docs/API.md) — the curated allow-list.
*
* Part of the routes split (see `../routes.ts` for the family map). The
* safety shape mirrors the provider switch: an absent field is REFUSED rather
* than read as "all models" (writing that would silently widen the offer), and
* a save adopts the signature of what was just offered so the next poll does
* not churn the registration.
*
* @module dsh-connect-agnes-token-plan/routes/models
*/
/** The model-roster route (docs/API.md). */
const MODELS_PATH = `/api/${name}/models`;
/** Ceiling on the curated allow-list: a catalogue this large is a posting accident. */
const MAX_ENABLED_MODEL_IDS = 500;
/**
* Register the model-roster route. Wiring subset: `settings`, `catalogStore`,
* `providerStore`, `providerState`, `publishProvider`.
* @param ctx - the host root context (only `ctx.webServer` is used here).
* @param {object} wiring - as assembled by `apply()` in `index.ts`.
* @returns {Function} the `off()` unregister callback.
*/
function registerModelsRoute(ctx, wiring) {
	const { settings, catalogStore, providerStore, providerState, publishProvider } = wiring;
	return ctx.webServer.register({
		kind: "exact",
		path: MODELS_PATH,
		handler: async (request, response) => {
			if (!isAdmittedWithAudit(request, settings.allowedHosts)) {
				refuseOrigin(response);
				return;
			}
			if ((request.method === void 0 ? "POST" : request.method) !== "POST") {
				refuseMethod(response);
				return;
			}
			const body = await readJsonBodyOr400(request, response);
			if (body === null) return;
			if (!Array.isArray(body.value.enabledModelIds)) {
				writeJson(response, 400, {
					ok: false,
					error: "expected { enabledModelIds: string[] }"
				}, { "cache-control": "no-store" });
				return;
			}
			const ids = normalizeEnabledIds(body.value.enabledModelIds);
			if (ids.length > 500) {
				writeJson(response, 400, {
					ok: false,
					error: `enabledModelIds is too long (max ${500})`
				}, { "cache-control": "no-store" });
				return;
			}
			const answer = async (extra = {}) => {
				writeJson(response, 200, {
					ok: true,
					enabledModelIds: await catalogStore.listEnabledIds().catch(() => providerState.enabledIds),
					registerProvider: resolveSwitchEnabled(await readPanelValue(() => providerStore.enabled()), settings.registerProvider).enabled,
					providerRegistered: providerState.registered,
					...providerState.error !== null ? { providerError: providerState.error } : {},
					...extra
				}, { "cache-control": "no-store" });
			};
			try {
				if (await catalogStore.setEnabledIds(ids)) providerState.signature = catalogSignature(providerState.entries, ids);
				await publishProvider(providerState.entries, ids, providerState.unavailableIds ?? []);
			} catch (error) {
				await answer({
					ok: false,
					error: redactError(error)
				});
				return;
			}
			await answer();
		}
	});
}

//#endregion
//#region src/host/routes/tool-switch.ts
/**
* The live tool-switch routes — the draw and video toggles.
*
* Part of the routes split (see `../routes.ts` for the family map). Both
* routes perform the same four operations in the same order — report the
* effective value, forget the saved one, save a model preference, save the
* boolean — and differ only in which store and which settings keys they name.
* Writing them ONCE is what keeps the two switches from drifting into
* behaving differently: a panel able to enable video but not disable drawing
* would be a bug with no visible cause.
*
* @module dsh-connect-agnes-token-plan/routes/tool-switch
*/
/** The draw-tool switch route (docs/PROVIDER-HOT-RELOAD.md, same discipline). */
const DRAW_PATH = `/api/${name}/draw`;
/** The video-tool switch route (same discipline, its own store and opt-in). */
const VIDEO_PATH = `/api/${name}/video`;
/**
* Register one live tool-switch route (the draw and video switches).
*
* Both routes perform the same four operations in the same order — report the
* effective value, forget the saved one, save a model preference, save the
* boolean — and differ only in which store and which settings keys they name.
* Writing them ONCE is what keeps the two switches from drifting into
* behaving differently: a panel able to enable video but not disable drawing
* would be a bug with no visible cause.
*
* Three purposes are distinguished by the POST body, the same shape the
* account and api-key routes use: a saved boolean, a saved model preference
* (`null` = auto), or a forget that returns the saved values to the config
* default.
* @param ctx - the host root context.
* @param {object} options - wiring.
* @param {string} options.path - the exact route path.
* @param {string} options.label - the noun used in "… store is unavailable" (`draw` / `video`).
* @param {object} [options.store] - the switch store (absent = every write refuses).
* @param {string} options.enabledKey - the response key carrying the boolean.
* @param {string} options.enabledSourceKey - the response key carrying its source.
* @param {boolean} options.configEnabled - the config default for the boolean.
* @param {string} options.modelKey - the response key carrying the model id.
* @param {string} options.modelSourceKey - the response key carrying its source.
* @param {string} options.configModelId - the config default for the model id.
* @param {Set<string>} options.allowedHosts - the trust fence.
* @returns {Function} the `off()` unregister callback.
*/
function registerToolSwitchRoute(ctx, { path, label, store, enabledKey, enabledSourceKey, configEnabled, modelKey, modelSourceKey, configModelId, allowedHosts }) {
	return ctx.webServer.register({
		kind: "exact",
		path,
		handler: async (request, response) => {
			if (!isAdmittedWithAudit(request, allowedHosts)) {
				refuseOrigin(response);
				return;
			}
			const method = request.method === void 0 ? "GET" : request.method;
			const answer = async (extra = {}) => {
				const panelEnabled = await readPanelValue(async () => await store?.enabled() ?? null);
				const panelModel = await readPanelValue(async () => await store?.modelId() ?? null);
				const enabled = resolveSwitchEnabled(panelEnabled, configEnabled);
				const model = resolveSwitchValue(panelModel, configModelId);
				writeJson(response, 200, {
					ok: true,
					[enabledKey]: enabled.enabled,
					[enabledSourceKey]: enabled.source,
					[modelKey]: model.value,
					[modelSourceKey]: model.source,
					...extra
				}, { "cache-control": "no-store" });
			};
			if (method === "GET") {
				await answer();
				return;
			}
			if (method !== "POST") {
				refuseMethod(response);
				return;
			}
			const body = await readJsonBodyOr400(request, response);
			if (body === null) return;
			if (body.value.forget === true) {
				if (!store) {
					await answer({
						ok: false,
						error: `${label} store is unavailable`
					});
					return;
				}
				try {
					await store.forget();
				} catch (error) {
					await answer({
						ok: false,
						error: redactError(error)
					});
					return;
				}
				await answer();
				return;
			}
			if (body.value[modelKey] !== void 0) {
				const raw = body.value[modelKey];
				if (raw !== null && (typeof raw !== "string" || raw.trim() === "")) {
					writeJson(response, 400, {
						ok: false,
						error: `${modelKey} expects a non-empty string or null`
					}, { "cache-control": "no-store" });
					return;
				}
				if (!store) {
					await answer({
						ok: false,
						error: `${label} store is unavailable`
					});
					return;
				}
				try {
					await store.saveModel(raw);
				} catch (error) {
					await answer({
						ok: false,
						error: redactError(error)
					});
					return;
				}
				await answer();
				return;
			}
			if (typeof body.value.enabled !== "boolean") {
				writeJson(response, 400, {
					ok: false,
					error: `expected { enabled: boolean }, { ${modelKey} }, or { forget: true }`
				}, { "cache-control": "no-store" });
				return;
			}
			if (!store) {
				await answer({
					ok: false,
					error: `${label} store is unavailable`
				});
				return;
			}
			try {
				await store.save(body.value.enabled);
			} catch (error) {
				await answer({
					ok: false,
					error: redactError(error)
				});
				return;
			}
			await answer();
		}
	});
}
/**
* Register the draw switch route. Wiring subset: `settings`, `drawStore`.
* @param ctx - the host root context.
* @param {object} wiring - as assembled by `apply()` in `index.ts`.
* @returns {Function} the `off()` unregister callback.
*/
function registerDrawRoute(ctx, wiring) {
	const { settings, drawStore } = wiring;
	return registerToolSwitchRoute(ctx, {
		path: DRAW_PATH,
		label: "draw",
		store: drawStore,
		enabledKey: "drawEnabled",
		enabledSourceKey: "drawSource",
		configEnabled: settings.drawEnabled,
		modelKey: "drawModelId",
		modelSourceKey: "drawModelSource",
		configModelId: settings.drawModelId,
		allowedHosts: settings.allowedHosts
	});
}
/**
* Register the video switch route. Wiring subset: `settings`, `videoStore`.
* @param ctx - the host root context.
* @param {object} wiring - as assembled by `apply()` in `index.ts`.
* @returns {Function} the `off()` unregister callback.
*/
function registerVideoRoute(ctx, wiring) {
	const { settings, videoStore } = wiring;
	return registerToolSwitchRoute(ctx, {
		path: VIDEO_PATH,
		label: "video",
		store: videoStore,
		enabledKey: "videoEnabled",
		enabledSourceKey: "videoSource",
		configEnabled: settings.videoEnabled,
		modelKey: "videoModelId",
		modelSourceKey: "videoModelSource",
		configModelId: settings.videoModelId,
		allowedHosts: settings.allowedHosts
	});
}

//#endregion
//#region src/host/routes/agnescode.ts
/**
* The AgnesCode provider route — the desktop-app upstream (ROADMAP §6.3).
*
* Part of the routes split (see `../routes.ts` for the family map). The
* credential is HARVESTED from the desktop App's os_crypt session file (the
* user logs in THERE, WeChat-side), so the login-equivalent action is
* 「检测本机登录态」— a harvest-then-save walk whose failure mode is the
* per-file diagnosis list the tab renders. Every answer is secret-free:
* tier codes and shape facts only — a token NEVER enters this payload, and
* error text passes `redactSecrets` before it can.
*
* The last walk's rows and the in-flight walk live at the ROUTE scope, not
* per request. Two reasons, and the first one is a bug that shipped:
*   * per-request `let lastHarvest` sat AFTER the GET branch, so the GET ran
*     `agnescodeState()` while the binding was still in its temporal dead
*     zone and the whole route threw — the panel's poll never saw the
*     harvested account and kept showing「未关联」while the credential was
*     already stored;
*   * the single-flight comment only holds across requests if the promise
*     outlives one, and the panel genuinely does poll while a walk runs.
*
* @module dsh-connect-agnes-token-plan/routes/agnescode
*/
/** The AgnesCode provider route (ROADMAP §6.3 "third upstream provider"). */
const AGNESCODE_PATH = `/api/${name}/agnescode`;
/** Ceiling on an AgnesCode action body: every action posts a bare `{action}`. */
const MAX_AGNESCODE_BODY_BYTES = 2048;
/** The GET self-heal publishes at most once per this window (see the GET branch). */
const AGNESCODE_SELF_HEAL_COOLDOWN_MS = 6e4;
/**
* Register the AgnesCode route. Wiring subset: `settings`, `agnescodeStore`,
* `agnescodeSwitch`, `agnescodePublisher`.
* @param ctx - the host root context (only `ctx.webServer` is used here).
* @param {object} wiring - as assembled by `apply()` in `index.ts`.
* @returns {Function} the `off()` unregister callback.
*/
function registerAgnescodeRoute(ctx, wiring) {
	const { settings, agnescodeStore, agnescodeSwitch, agnescodePublisher, agnescodeModels } = wiring;
	let lastHarvest = null;
	let agnescodeHarvestInFlight = null;
	let agnescodeSelfHealAt = 0;
	return ctx.webServer.register({
		kind: "exact",
		path: AGNESCODE_PATH,
		handler: async (request, response) => {
			if (!isAdmittedWithAudit(request, settings.allowedHosts)) {
				refuseOrigin(response);
				return;
			}
			const agnescodeState = async () => {
				const { enabled: effectiveEnabled, source: switchSource } = resolveSwitchEnabled(await readPanelValue(() => agnescodeSwitch?.enabled()));
				let loggedIn = false;
				let nickname = "";
				let bffBase = "";
				let expiresAtMs = null;
				let balance = null;
				let error = null;
				try {
					if (agnescodeStore !== null && agnescodeStore !== void 0) {
						const state = await agnescodeStore.state().catch(() => null);
						loggedIn = state?.hasCredential === true;
						nickname = state?.nickname ?? "";
						bffBase = state?.bffBase ?? "";
						expiresAtMs = state?.expiresAtMs ?? null;
						if (loggedIn) {
							const { credential } = await agnescodeStore.resolve().catch(() => ({ credential: null }));
							if (credential?.accessToken) balance = await fetchAgnescodeBalance(credential).catch(() => null);
						}
					}
				} catch (why) {
					error = redactSecrets(why instanceof Error ? why.message : String(why));
				}
				let models = null;
				try {
					if (agnescodeStore !== null && agnescodeStore !== void 0) {
						const { credential } = await agnescodeStore.resolve().catch(() => ({ credential: null }));
						if (credential?.accessToken) models = await fetchAgnescodeCatalog(credential).catch(() => null);
					}
				} catch {
					models = null;
				}
				const roster = models !== null && Array.isArray(models) && models.length > 0 ? models : AGNESCODE_FALLBACK_MODELS;
				const publisherState = agnescodePublisher?.state ?? null;
				const enabledModelIds = agnescodeModels !== null && agnescodeModels !== void 0 ? await agnescodeModels.listEnabledIds().catch(() => []) : [];
				return {
					ok: true,
					enabled: effectiveEnabled,
					switchSource,
					loggedIn,
					nickname,
					bffBase,
					expiresAtMs,
					balance,
					models: roster,
					enabledModelIds,
					providerRegistered: publisherState?.registered === true,
					...publisherState?.error !== null && publisherState?.error !== void 0 ? { providerError: publisherState.error } : {},
					...lastHarvest !== null ? { harvest: lastHarvest } : {},
					...error !== null ? { error } : {}
				};
			};
			/** Drive the registration from the CURRENT stored credential: the live
			*  catalogue wins over the fallback, the base comes from the credential
			*  (empty when there is none — the publisher's gate then releases). */
			const publishFromStore = async () => {
				if (agnescodePublisher === null || agnescodePublisher === void 0) return;
				let rows = AGNESCODE_FALLBACK_MODELS;
				let bffBase = "";
				try {
					const { credential } = agnescodeStore ? await agnescodeStore.resolve().catch(() => ({ credential: null })) : { credential: null };
					if (credential?.accessToken) {
						const live = await fetchAgnescodeCatalog(credential).catch(() => null);
						if (live !== null && live.length > 0) rows = live;
						bffBase = credential.bffBase ?? "";
					}
				} catch {}
				const enabledIds = agnescodeModels !== null && agnescodeModels !== void 0 ? await agnescodeModels.listEnabledIds().catch(() => []) : [];
				await agnescodePublisher.publish(filterAgnescodeRows(rows, enabledIds), bffBase);
			};
			const method = request.method === void 0 ? "GET" : request.method;
			if (method === "GET") {
				let state = await agnescodeState();
				const staleRegistration = state.providerRegistered !== true && state.providerError !== null && state.providerError !== void 0 && state.providerError !== "";
				if (state.enabled === true && state.loggedIn === true && staleRegistration && Date.now() - agnescodeSelfHealAt > AGNESCODE_SELF_HEAL_COOLDOWN_MS) {
					agnescodeSelfHealAt = Date.now();
					await publishFromStore();
					state = await agnescodeState();
				}
				writeJson(response, 200, state, { "cache-control": "no-store" });
				return;
			}
			if (method !== "POST") {
				refuseMethod(response);
				return;
			}
			const body = await readJsonBody(request, MAX_AGNESCODE_BODY_BYTES);
			if (!body.ok) {
				writeJson(response, 400, {
					ok: false,
					error: body.error
				}, { "cache-control": "no-store" });
				return;
			}
			const { action } = body.value;
			const answer = async (extra = {}) => {
				const state = await agnescodeState();
				writeJson(response, 200, {
					...state,
					...extra
				}, { "cache-control": "no-store" });
			};
			if (action === "switch") {
				if (typeof body.value.enabled !== "boolean") {
					writeJson(response, 400, {
						ok: false,
						error: "expected { action: \"switch\", enabled: boolean }"
					}, { "cache-control": "no-store" });
					return;
				}
				if (agnescodeSwitch === null || agnescodeSwitch === void 0) {
					await answer({
						ok: false,
						error: "the agnescode switch is unavailable"
					});
					return;
				}
				try {
					await agnescodeSwitch.save(body.value.enabled);
					await publishFromStore();
				} catch (error) {
					await answer({
						ok: false,
						error: redactSecrets(error instanceof Error ? error.message : String(error))
					});
					return;
				}
				await answer();
				return;
			}
			if (action === "saveModels") {
				if (!Array.isArray(body.value.enabledModelIds)) {
					writeJson(response, 400, {
						ok: false,
						error: "expected { action: \"saveModels\", enabledModelIds: string[] }"
					}, { "cache-control": "no-store" });
					return;
				}
				if (agnescodeModels === null || agnescodeModels === void 0) {
					await answer({
						ok: false,
						error: "the agnescode model store is unavailable"
					});
					return;
				}
				try {
					await agnescodeModels.save(body.value.enabledModelIds);
					await publishFromStore();
				} catch (error) {
					await answer({
						ok: false,
						error: redactSecrets(error instanceof Error ? error.message : String(error))
					});
					return;
				}
				await answer();
				return;
			}
			if (action === "harvest") {
				if (agnescodeStore === null || agnescodeStore === void 0) {
					await answer({
						ok: false,
						error: "the agnescode credential store is unavailable"
					});
					return;
				}
				try {
					if (agnescodeHarvestInFlight === null) agnescodeHarvestInFlight = (async () => {
						const walk = await harvestAgnescodeLocalSession();
						lastHarvest = {
							ok: walk.ok,
							attempts: walk.attempts
						};
						if (walk.ok !== true) return {
							ok: false,
							attempts: walk.attempts
						};
						const expMs = decodeAgnescodeJwtExpMs(walk.session.accessToken);
						await agnescodeStore.save({
							accessToken: walk.session.accessToken,
							bffBase: walk.session.bffBase,
							...walk.session.userId !== "" ? { userId: walk.session.userId } : {},
							...walk.session.nickname !== "" ? { nickname: walk.session.nickname } : {},
							...expMs !== void 0 ? { expiresAtMs: expMs } : {}
						});
						return {
							ok: true,
							attempts: walk.attempts
						};
					})().finally(() => {
						agnescodeHarvestInFlight = null;
					});
					const walk = await agnescodeHarvestInFlight;
					if (walk.ok !== true) {
						await answer({
							ok: false,
							status: "not_found",
							harvest: walk
						});
						return;
					}
				} catch (error) {
					await answer({
						ok: false,
						error: redactSecrets(error instanceof Error ? error.message : String(error))
					});
					return;
				}
				if (agnescodePublisher !== null && agnescodePublisher !== void 0 && agnescodePublisher.isDisposed() === false) {
					if (resolveSwitchEnabled(await readPanelValue(() => agnescodeSwitch?.enabled())).enabled) await publishFromStore();
				}
				await answer({
					ok: true,
					status: "harvested"
				});
				return;
			}
			if (action === "logout") {
				if (agnescodeStore === null || agnescodeStore === void 0) {
					await answer({
						ok: false,
						error: "the agnescode credential store is unavailable"
					});
					return;
				}
				try {
					await agnescodeStore.forget();
					if (agnescodePublisher !== null && agnescodePublisher !== void 0) await agnescodePublisher.publish(AGNESCODE_FALLBACK_MODELS, "");
				} catch (error) {
					await answer({
						ok: false,
						error: redactSecrets(error instanceof Error ? error.message : String(error))
					});
					return;
				}
				await answer({
					ok: true,
					status: "logged_out"
				});
				return;
			}
			writeJson(response, 400, {
				ok: false,
				error: "expected { action: \"switch\"|\"harvest\"|\"logout\"|\"saveModels\" }"
			}, { "cache-control": "no-store" });
		}
	});
}

//#endregion
//#region src/host/routes.ts
/**
* The HTTP route handlers — the registry facade of the routes family.
*
* `apply()` stays the single mount seam: it assembles a `wiring` object and
* hands it to {@link registerRoutes}; the handlers keep exactly the behaviour
* they had inline (the trust fence, the method allowances, the body ceilings,
* the trace writes, the publish-after-save calls). Nothing here imports a Host
* peer — the only lazy peer loads (the adapter / tools modules) live in
* `lifecycle.ts` and are injected from `apply` via `deps`.
*
* 2026-10 split (the token-store playbook: behaviour frozen first —
* `routes.test.mjs` + `agnescode.test.mjs` + `wiring.test.mjs` ran green
* against THIS facade, unchanged, before and after the move). The family:
*
*   - `routes/http.ts`         — the shared primitives (writeJson, the bounded
*                                body reader, the fence/method refusals);
*   - `routes/snapshot.ts`     — the polled read-only snapshot (and the
*                                failure-code taxonomy);
*   - `routes/account.ts`      — panel sign-in / forget, trace writes;
*   - `routes/api-key.ts`      — the `sk-` reference, forget-and-republish;
*   - `routes/provider.ts`     — the registration switch;
*   - `routes/models.ts`       — the curated allow-list;
*   - `routes/tool-switch.ts`  — ONE handler body serving draw AND video;
*   - `routes/agnescode.ts`    — the desktop-upstream provider (switch /
*                                harvest / logout, route-scoped state).
*
* The registration ORDER is load-bearing: the returned `off()` callbacks run
* in this order on teardown. Public API and export surface are unchanged.
*
* @module dsh-connect-agnes-token-plan/routes
*/
/**
* Register the routes on the Host's web server.
*
* The handlers close over `wiring` only — every service they touch is listed
* there, so `apply()` is the single place that decides what a route can do.
* @param ctx - the host root context (only `ctx.webServer` is used here).
* @param {object} wiring - assembled by `apply()` in `index.ts`.
* @param {object} wiring.settings - the resolved settings row.
* @param {string|null} wiring.configError - a settings/auth misconfiguration
*   surfaced through the snapshot instead of a mount crash.
* @param {Map} wiring.cache - the console-response cache (shared across polls).
* @param {Map} wiring.inflight - the single-flight map (shared across polls).
* @param {object} wiring.tokenStore - the `createTokenStore` instance.
* @param {object} wiring.apiKeyStore - the `createApiKeyStore` instance.
* @param {object} wiring.catalogStore - the `createFileCatalogStore` instance.
* @param {object} wiring.providerStore - the `createFileProviderStore` instance.
* @param {object} wiring.publisher - the `createProviderPublisher` instance.
* @param {object} wiring.providerState - `publisher.state` (shared reference).
* @param {Function} wiring.publishProvider - (entries, enabledIds, unavailableIds) =>
*   publisher.publish with rollback.
* @param {{current: Function|null}} wiring.visionPublish - the settings-row
*   writer filled by `startSideEffects` (no-op until then).
* @param {object} wiring.drawStore - the `createFileDrawStore` instance; the
*   draw switch route reads and writes it.
* @param {object} wiring.videoStore - the `createFileVideoStore` instance; the
*   video switch route reads and writes it (a SEPARATE opt-in from drawing).
* @param {object} [wiring.logger] - `ctx.logger` (Host logging), used by the
*   trace-write handler; optional so tests may omit it.
* @param {object} [wiring.agnescodeStore] - the AgnesCode credential store
*   (ROADMAP §6.3); the agnescode route reads, harvests and forgets through it.
* @param {object} [wiring.agnescodeSwitch] - the AgnesCode panel switch.
* @param {object} [wiring.agnescodePublisher] - the AgnesCode provider
*   publisher (a SEPARATE provider from the main one; same route discipline).
* @returns {Function[]} the `off()` unregister callbacks, in registration
*   order — `teardown` runs them last.
*/
function registerRoutes(ctx, wiring) {
	return [
		registerSnapshotRoute(ctx, wiring),
		registerAccountRoute(ctx, wiring),
		registerApiKeyRoute(ctx, wiring),
		registerProviderRoute(ctx, wiring),
		registerModelsRoute(ctx, wiring),
		registerDrawRoute(ctx, wiring),
		registerVideoRoute(ctx, wiring),
		registerAgnescodeRoute(ctx, wiring)
	];
}

//#endregion
//#region src/host/video-protocol.ts
/**
* The Agnes VIDEO wire protocol — endpoint building, the V2.0 request body,
* task-response parsing and failure triage. NO fetch, NO clock, NO tool:
* everything here is pure text-in / text-out.
*
* This module was extracted from the original single-file `video.ts` in the
* 2026-10 split (the token-store playbook: behaviour frozen first —
* `video.test.mjs` ran green against the `video.ts` compatibility barrel
* before and after the move, unchanged). The video family now lives in:
*
*   - `video-protocol.ts`      — THIS module: endpoints, V2.0 body, parsing;
*   - `video-protocol-25.ts`   — the 2.5 whole-second scheme;
*   - `video-models.ts`        — family recognition & catalog selection;
*   - `video-client.ts`        — the create → poll async spine (fetch/sleep);
*   - `video.ts`               — the `agnes_video_generate` tool + barrel.
*
* The contract is not guessed. Four independent upstream implementations were
* read rather than assumed — all four live in the SIBLING checkout's reference
* tree (`~/.dsh/plugins/dsh-connect-agnes/upstream`, which is NOT this repo's
* `upstream/`):
*
*   - the `dsh-agnes` DSH plugin (v0.6.0) — TypeScript, talks to the SAME host
*     this plugin does; its video module is the closest analogue;
*   - the `dsh-agnes-gen` JS plugin;
*   - the `agnes-ai-generation-skill` tree — its `references/api.md` is the
*     vendor-facing written contract;
*   - the `Agnes-Media-Create` Python reference.
*
* ⚠️ THE HOST TRAP, measured rather than inferred: the Python reference
* hardcodes `https://apihub.agnes-ai.com`, the INTERNATIONAL site. The two
* sites expose identical paths on different hosts with NON-INTERCHANGEABLE
* tokens — the JS plugin's own source comment records it ("拿国际站的 Key 打
* 国内站的域名只会得到 401"), and it was re-measured here on 2026-10-01: this
* plugin's key returns `Invalid token` from `apihub.agnes-ai.com` and works on
* `api.agnes-ai.cn`. This module therefore derives EVERY endpoint from the
* configured `apiBase` and hardcodes no host.
*
* ⚠️ AND THE PATH ASYMMETRY: creation lives under the OpenAI-compatible root
* (`{apiBase}/videos` = `https://api.agnes-ai.cn/v1/videos`), but the query
* endpoint does NOT — it is `https://api.agnes-ai.cn/agnesapi`, one level
* ABOVE `/v1`. `buildVideoQueryEndpoint` strips the version segment for
* exactly this reason; appending `/v1` there would 404.
*
* The V2.0 parameter system is `width` / `height` / `num_frames` (8n+1) /
* `frame_rate`. The 2.5 family (`agnes-video-2.5` / `agnes-video-2.5-flash`)
* speaks a MUTUALLY EXCLUSIVE scheme — `mode` / `seconds` / `size` /
* `aspect_ratio` — see `video-protocol-25.ts`. Sending the V2.0 frame fields
* straight to a 2.5 model is a 400, and the reverse is too; neither builder
* ever emits the other family's fields.
*
* @module dsh-connect-agnes-token-plan/video-protocol
*/
/** How long to wait between two status queries. */
const VIDEO_POLL_INTERVAL_MS = 5e3;
/**
* A hard ceiling on the number of status queries in one poll loop.
*
* The real bound is the wall-clock budget below, and with the real `Date.now`
* that alone terminates the loop. This exists because the clock is INJECTABLE:
* a non-advancing one would make `remaining <= 0` unreachable and spin forever
* — a failure mode first hit while writing the video module's own tests. 1000
* is far above any legitimate count (a 10-minute budget at 5s intervals is
* 120), so it can only ever fire on a broken clock.
*/
const VIDEO_MAX_POLLS = 1e3;
/** The poll budget for one generation; video tasks run for minutes, not seconds. */
const VIDEO_DEFAULT_TIMEOUT_MS = 6e5;
/** Per-HTTP-call deadline (create and each query), independent of the poll budget. */
const VIDEO_REQUEST_TIMEOUT_MS = 12e4;
/** `num_frames` ceiling the platform enforces. */
const VIDEO_MAX_FRAMES = 441;
/** `frame_rate` bounds the platform enforces. */
const VIDEO_MIN_FRAME_RATE = 1;
/** Upper `frame_rate` bound. */
const VIDEO_MAX_FRAME_RATE = 60;
/** Documented default width (16:9). */
const VIDEO_DEFAULT_WIDTH = 1152;
/**
* The frame counts the platform documents as common, for error hints only.
*
* The real rule is the arithmetic one (`8n + 1`, `≤ 441`); this list exists so
* a rejected value can name the nearest legal neighbour instead of just
* refusing.
*/
const VIDEO_COMMON_FRAME_COUNTS = Object.freeze([
	81,
	121,
	161,
	241,
	441
]);
/** Task states that end the poll loop. */
const VIDEO_TERMINAL_STATUSES = Object.freeze(["completed", "failed"]);
/** Reference images must be URLs the platform can fetch itself. */
const VIDEO_IMAGE_PATTERN = /^https?:\/\//;
/**
* The version segment the query endpoint must NOT carry.
*
* `apiBase` is the OpenAI-compatible root (`…/v1`); `/agnesapi` hangs off the
* host root instead. Stripping `/v1` (and anything deeper, so an operator who
* pasted a full `/v1/chat/completions` still lands correctly) is what keeps a
* hand-edited `apiBase` from producing a 404 on every poll.
* @param {string} apiBase - the configured base.
* @returns {string} the host root, or `""` when nothing usable was given.
*/
function hostRootOf(apiBase) {
	const trimmed = str(apiBase, "").trim().replace(/\/+$/, "");
	if (trimmed === "") return "";
	return trimmed.replace(/\/v1(\/.*)?$/, "");
}
/**
* Build the task-creation endpoint from the OpenAI-compatible base.
*
* Every operator spelling lands on the same URL: `…/v1` → `…/v1/videos`; a
* value already ending in `/videos` passes through; a deeper `/v1/<something>`
* is rewound to `/v1`; anything else gets `/v1/videos` appended.
* @param {string} apiBase - the configured base (default `https://api.agnes-ai.cn/v1`).
* @returns {string} the full create endpoint.
*/
function buildVideoEndpoint(apiBase) {
	const trimmed = str(apiBase, "").trim().replace(/\/+$/, "");
	if (trimmed === "") return "";
	if (/\/videos$/.test(trimmed)) return trimmed;
	if (/\/v1$/.test(trimmed)) return `${trimmed}/videos`;
	if (/\/v1\//.test(trimmed)) return trimmed.replace(/\/v1\/.*$/, "/v1/videos");
	return `${trimmed}/v1/videos`;
}
/**
* Build the status-query endpoint — deliberately NOT under `/v1`.
*
* See the module header: the query route lives at `{host}/agnesapi`, so the
* version segment is stripped rather than appended.
* @param {string} apiBase - the configured base.
* @returns {string} the full query endpoint, or `""` when the base is unusable.
*/
function buildVideoQueryEndpoint(apiBase) {
	const root = hostRootOf(apiBase);
	return root === "" ? "" : `${root}/agnesapi`;
}
/**
* Whether a frame count satisfies the platform's `8n + 1` rule within bounds.
* @param {unknown} value - the candidate.
* @returns {boolean}
*/
function isValidFrameCount(value) {
	return Number.isInteger(value) && value >= 1 && value <= 441 && (value - 1) % 8 === 0;
}
/**
* The nearest legal frame count at or above `value`, for an error hint.
* @param {number} value - the rejected value.
* @returns {number} a legal frame count.
*/
function nearestFrameCount(value) {
	return VIDEO_COMMON_FRAME_COUNTS.find((count) => count >= value) ?? 441;
}
/**
* Build the `videos` request body for the V2.0 parameter system.
*
* Invalid EXPLICIT values THROW rather than being clamped, unlike
* `buildDrawBody`'s `n`. The difference is deliberate: a clamped image count
* costs one cheap extra image, while a clamped frame count silently changes the
* video's DURATION after minutes of generation — the caller must be told, not
* quietly overruled.
* @param {object} options - `{ model, prompt, width, height, numFrames, frameRate, seed, negativePrompt, image }`.
* @returns {object} the wire body.
* @throws {Error} on any out-of-range explicit value.
*/
function buildVideoBody(options = {}) {
	const { model, prompt, width, height, numFrames, frameRate, seed, negativePrompt, image } = options;
	const body = {
		model: str(model, ""),
		prompt: str(prompt, "")
	};
	if (width !== void 0 && width !== null) {
		if (!Number.isInteger(width) || width <= 0) throw new Error(`无效的 width ${width}：必须是正整数`);
		body.width = width;
	}
	if (height !== void 0 && height !== null) {
		if (!Number.isInteger(height) || height <= 0) throw new Error(`无效的 height ${height}：必须是正整数`);
		body.height = height;
	}
	if (numFrames !== void 0 && numFrames !== null) {
		if (!isValidFrameCount(numFrames)) throw new Error(`无效的 num_frames ${numFrames}：必须 ≤ ${441} 且满足 8n+1（常用值 ${VIDEO_COMMON_FRAME_COUNTS.join(" / ")}，最接近的较大合法值 ${nearestFrameCount(Number(numFrames) || 1)}）`);
		body.num_frames = numFrames;
	}
	if (frameRate !== void 0 && frameRate !== null) {
		if (typeof frameRate !== "number" || !Number.isFinite(frameRate) || frameRate < 1 || frameRate > 60) throw new Error(`无效的 frame_rate ${frameRate}：支持范围 ${1}–${60}`);
		body.frame_rate = frameRate;
	}
	if (seed !== void 0 && seed !== null) {
		if (!Number.isInteger(seed)) throw new Error(`无效的 seed ${seed}：必须是整数`);
		body.seed = seed;
	}
	const negative = str(negativePrompt, "");
	if (negative !== "") body.negative_prompt = negative;
	const source = str(image, "");
	if (source !== "") {
		if (!VIDEO_IMAGE_PATTERN.test(source)) throw new Error(`无效的 image "${source.slice(0, 64)}"：必须是平台可直接抓取的公共 HTTP(S) 图片 URL`);
		body.image = source;
	}
	return body;
}
/**
* Read the task identifiers out of a create-task response.
*
* `video_id` is the recommended lookup key and is preferred; `task_id` (with
* `id` as the same field under its other spelling) is the legacy fallback the
* upstream reference also honours.
* @param {object} data - the parsed create response.
* @returns {{videoId: string, taskId: string, status: string}}
*/
function parseVideoTask(data) {
	const source = obj(data);
	return {
		videoId: str(source.video_id, ""),
		taskId: str(source.task_id, "") || str(source.id, ""),
		status: str(source.status, "")
	};
}
/**
* The identifier a poll should address: `video_id` when present, else `task_id`.
* @param {object} task - a {@link parseVideoTask} result.
* @returns {string} the id, or `""` when the platform returned neither.
*/
function videoTaskIdOf(task) {
	return str(task?.videoId, "") || str(task?.taskId, "");
}
/**
* Read a status-query response into the fields the tool and its hint use.
*
* `url` is read from the top level AND from `metadata.url` because the live
* response and the documented example disagree on which one carries it (the
* upstream reference records the same two-layer fallback).
* @param {object} data - the parsed query response.
* @returns {{videoId: string, taskId: string, status: string, progress: number, seconds: string, size: string, url: string, error: unknown}}
*/
function parseVideoQuery(data) {
	const source = obj(data);
	const metadata = obj(source.metadata);
	const progress = typeof source.progress === "number" && Number.isFinite(source.progress) ? source.progress : 0;
	return {
		videoId: str(source.video_id, ""),
		taskId: str(source.task_id, ""),
		status: str(source.status, "").toLowerCase(),
		progress,
		seconds: str(source.seconds, "") || (typeof source.seconds === "number" ? String(source.seconds) : ""),
		size: str(source.size, ""),
		url: str(source.url, "") || str(metadata.url, ""),
		error: source.error ?? metadata.error
	};
}
/**
* Whether a task state ends the poll loop.
* @param {string} status - the state string.
* @returns {boolean}
*/
function isVideoTerminal(status) {
	return VIDEO_TERMINAL_STATUSES.includes(str(status, "").toLowerCase());
}
/**
* Turn a failed HTTP answer into the message the agent (and the trace) reads.
*
* The 429 split mirrors the chat and draw discipline: a drained shared pool is
* not worth retrying, a plain rate limit is. The 400 branch carries the
* platform's own words, which for this gateway name the exact parameter that
* was rejected.
* @param {number} status - the HTTP status code.
* @param {string} bodyText - the raw body (best effort, may be empty).
* @returns {string} the agent-facing message.
*/
function describeVideoFailure(status, bodyText) {
	const text = str(bodyText, "").slice(0, 300);
	if (status === 401 || status === 403) return `video failed: HTTP ${status} — the AGNES_TOKEN_PLAN_API_KEY is missing, invalid or not authorized for this model. Set it in the panel's 模型接入 area${text === "" ? "" : `; body: ${text}`}`;
	if (status === 429) {
		if (/insufficient|quota/i.test(text)) return `video failed: HTTP 429 — 配额不足（共享池已耗尽或该视频模型不在套餐内），稍后或换模型再试; body: ${text}`;
		return `video failed: HTTP 429 — 限频（token-plan 档视频约 5 RPM，且建任务与轮询共用同一个池），请稍等重试; body: ${text}`;
	}
	if (status === 404) return `video failed: HTTP 404 — 任务不存在或 endpoint 不对（检查 apiBase；建任务走 {apiBase}/videos，查询走 {host}/agnesapi）${text === "" ? "" : `; body: ${text}`}`;
	return `video failed: HTTP ${status}${text === "" ? "" : ` ${text}`}`;
}

//#endregion
//#region src/host/video-protocol-25.ts
/**
* The Agnes VIDEO 2.5 parameter family — the OpenAI-Videos-compatible
* whole-second scheme.
*
* Part of the 2026-10 split of `video.ts` (see that file's header for the
* family map; behaviour was frozen by `video.test.mjs` before and after).
*
* Mutually exclusive with the V2.0 body (`video-protocol.ts`): `mode` /
* `seconds` / `size` / `aspect_ratio` (plus `first_frame` / `last_frame` /
* `images` media fields and `seed`). Sending the V2.0 `width` / `height` /
* `num_frames` / `frame_rate` fields to a 2.5 model is a 400, and the reverse
* is too — so {@link buildVideoBody25} never emits a V2.0 field, and the V2.0
* builder never emits a 2.5 one. The two builders are dispatched per model by
* `isVideo25Family` inside `defineVideoTool`.
*
* @module dsh-connect-agnes-token-plan/video-protocol-25
*/
/** The resolution tiers the 2.5 family documents. */
const VIDEO25_SIZES = Object.freeze([
	"720P",
	"960P",
	"2K"
]);
/** `2.5-flash` only supports this tier; anything else is a 400. */
const VIDEO25_FLASH_ONLY_SIZE = "720P";
/** The whole-second range the 2.5 family accepts (submitted as a string). */
const VIDEO25_SECONDS_MIN = 4;
const VIDEO25_SECONDS_MAX = 12;
/** The `2.5-flash` reference-mode image ceiling. */
const VIDEO25_FLASH_REFERENCE_LIMIT = 5;
/** The 2.5 aspect whitelist and their width/height values, for nearest-match. */
const VIDEO25_ASPECT_TABLE = Object.freeze([
	{
		ratio: "21:9",
		value: 21 / 9
	},
	{
		ratio: "16:9",
		value: 16 / 9
	},
	{
		ratio: "4:3",
		value: 4 / 3
	},
	{
		ratio: "1:1",
		value: 1
	},
	{
		ratio: "3:4",
		value: 3 / 4
	},
	{
		ratio: "9:16",
		value: 9 / 16
	}
]);
/** The 2.5 mode whitelist. */
const VIDEO25_MODES = Object.freeze([
	"text",
	"keyframe",
	"reference"
]);
/** Documented default resolution tier. */
const VIDEO25_DEFAULT_SIZE = "720P";
/**
* The tool-call fields that ONLY the 2.5 family understands.
*
* `buildVideoBody` destructures only the V2.0 fields, so any of these handed to
* a V2.0 model would be SILENTLY IGNORED: a caller asking for a 10s 2K clip
* would receive a 5s 720P one with no signal. `defineVideoTool` uses this list
* to refuse the mix instead (AGNES-API.md §7.5.1b).
*/
const VIDEO25_ONLY_FIELDS = Object.freeze([
	"seconds",
	"size",
	"aspect_ratio",
	"mode",
	"keyframes"
]);
/**
* The prefix every 2.5-family error carries: the model id the builder actually
* resolved, plus which parameter system that model speaks.
*
* Before this the messages said only "2.5 系列", which named a FAMILY without
* naming what the agent had actually addressed — the only way to learn which
* model was dispatched was to read the catalog. Naming it makes the error
* self-correcting on its own line.
* @param {unknown} model - the resolved model id.
* @returns {string} e.g. `模型 agnes-video-2.5-flash（2.5 秒数制）：`
*/
function video25ErrorContext(model) {
	return `模型 ${str(model, "") || "(未指定模型)"}（2.5 秒数制）：`;
}
/**
* The resolution tier one 2.5 call resolves to.
*
* An EXPLICIT `size` must be whitelisted — and a flash variant may only be
* `720P` — so an illegal value throws, matching the V2.0 throw-not-clamp
* discipline. When nothing is given, the flash variant is pinned to its only
* legal tier, and every other 2.5 model defaults to 720P.
* @param {unknown} explicit - the requested size.
* @param {string} model - the catalog id (decides the flash pinning).
* @returns {string} a whitelisted tier.
* @throws {Error} on a non-whitelisted explicit value, or a flash value above 720P.
*/
function resolveVideo25Size(explicit, model) {
	if (explicit !== void 0 && explicit !== null) {
		const tier = String(explicit).trim().toUpperCase();
		if (!VIDEO25_SIZES.includes(tier)) throw new Error(`${video25ErrorContext(model)}无效的 size ${String(explicit)}：支持 ${VIDEO25_SIZES.join(" / ")}${isVideo25Flash(model) ? `，且该模型（2.5-flash）仅支持 ${VIDEO25_FLASH_ONLY_SIZE}` : ""}`);
		if (isVideo25Flash(model) && tier !== "720P") throw new Error(`${video25ErrorContext(model)}无效的 size ${String(explicit)}：该模型（2.5-flash）仅支持 ${VIDEO25_FLASH_ONLY_SIZE}`);
		return tier;
	}
	return isVideo25Flash(model) ? VIDEO25_FLASH_ONLY_SIZE : VIDEO25_DEFAULT_SIZE;
}
/** Documented default aspect (the "16:9" a call with no width/height steers to). */
const VIDEO25_DEFAULT_ASPECT = "16:9";
/**
* Match any width/height to the 2.5 aspect whitelist, nearest ratio.
*
* The 2.5 family does not take `width` / `height` — those are a 400. This is
* how an operator's preferred dimensions still steer the output: nearest
* whitelisted aspect. A call with NO usable dimensions lands exactly on the
* documented default 16:9 (the target IS 16/9, which is a whitelisted value —
* no tie-break involved). Invalid dimensions likewise fall back to that
* default.
* @param {unknown} width - the candidate width.
* @param {unknown} height - the candidate height.
* @returns {string} a whitelisted aspect ratio.
*/
function nearestAspect25(width, height) {
	const target = typeof width === "number" && width > 0 && typeof height === "number" && height > 0 ? width / height : 16 / 9;
	let best = VIDEO25_ASPECT_TABLE.find((row) => row.ratio === "16:9") ?? VIDEO25_ASPECT_TABLE[0];
	for (const row of VIDEO25_ASPECT_TABLE) if (Math.abs(row.value - target) < Math.abs(best.value - target)) best = row;
	return best.ratio;
}
/**
* Frame count / frame rate → whole seconds, clamped to the 2.5 range.
*
* This is the bridge that lets a caller who thinks in frames (the V2.0
* mental model) still steer a 2.5 call's DURATION: `121 @ 24fps` → `5`
* seconds. Bad frame rate falls back to the documented 24; a bad frame count
* to 121 (≈5s). The clamp is deliberate here (unlike the V2.0 frame-count
* throw): the 2.5 platform only accepts whole seconds 4–12, so a frame count
* that would imply 3s or 15s must land on a legal value rather than a 400.
* @param {unknown} numFrames - the candidate frame count.
* @param {unknown} frameRate - the candidate frame rate.
* @returns {number} a whole second in `4–12`.
*/
function secondsFromFrameTiming(numFrames, frameRate) {
	const fps = typeof frameRate === "number" && Number.isFinite(frameRate) && frameRate > 0 ? frameRate : 24;
	return Math.min(12, Math.max(4, Math.round((typeof numFrames === "number" && Number.isFinite(numFrames) && numFrames > 0 ? numFrames : 121) / fps)));
}
/**
* Build the `videos` request body for the 2.5 parameter system.
*
* The 2.5 family is OpenAI-Videos-compatible: `mode` (`text` / `keyframe` /
* `reference`) + `seconds` (whole, `4–12`) + `size` (720P/960P/2K) +
* `aspect_ratio` (whitelist), with media fields `first_frame` / `last_frame`
* / `images` and an optional `seed`. It does NOT accept the V2.0
* `width` / `height` / `num_frames` / `frame_rate` fields — sending them is a
* 400 — so those are translated, not passed through:
*
*   - an EXPLICIT `seconds` wins (and must be a whole 4–12, else throw);
*   - otherwise `num_frames` / `frame_rate` are converted to the nearest
*     whole second via {@link secondsFromFrameTiming};
*   - `size` resolves through {@link resolveVideo25Size} (flash pinned to
*     720P, illegal values throw);
*   - `aspect_ratio` takes an EXPLICIT whitelisted value, or falls back to
*     the nearest match of `width` / `height` via {@link nearestAspect25};
*   - the media inputs map to a mode: `image` alone → `keyframe`
*     (`first_frame`); two `keyframes` → `keyframe` (`first_frame` +
*     `last_frame`); three or more `keyframes` → `reference` (`images`,
*     ≤5 on flash); no media → `text`.
*
* `negative_prompt` is a V2.0 field and is intentionally NOT forwarded: the
* 2.5 system has no equivalent, and an unknown top-level field is a 400.
* @param {object} options - `{ model, prompt, mode, seconds, size, aspectRatio, width, height, numFrames, frameRate, image, keyframes, seed }`.
* @returns {object} the wire body.
* @throws {Error} on an out-of-range explicit value (seconds / size / aspect /
*   seed) or a conflicting media combination.
*/
function buildVideoBody25(options = {}) {
	const { model, prompt, mode, seconds, size, aspectRatio, width, height, numFrames, frameRate, image, keyframes, seed } = options;
	const flash = isVideo25Flash(model);
	const frameUrls = Array.isArray(keyframes) ? keyframes.filter((item) => typeof item === "string" && item !== "") : [];
	const imageUrl = typeof image === "string" && image.trim() !== "" ? image.trim() : void 0;
	if (frameUrls.length > 0 && imageUrl !== void 0) throw new Error(`${video25ErrorContext(model)}image 与 keyframes 不能同时使用：图生视频传单张 image，关键帧动画传 keyframes 数组`);
	const mediaUrls = [...frameUrls, ...imageUrl === void 0 ? [] : [imageUrl]];
	for (const url of mediaUrls) if (!VIDEO_IMAGE_PATTERN.test(url)) throw new Error(`${video25ErrorContext(model)}无效的参考图 "${url.slice(0, 64)}"：必须是平台可直接抓取的公共 HTTP(S) 图片 URL`);
	let resolvedMode;
	const media = {};
	const explicitMode = mode !== void 0 && mode !== null && String(mode).trim() !== "" ? String(mode).trim() : void 0;
	if (explicitMode !== void 0) {
		if (!VIDEO25_MODES.includes(explicitMode)) throw new Error(`${video25ErrorContext(model)}无效的 mode "${explicitMode}"：支持 ${VIDEO25_MODES.join(" / ")}`);
		resolvedMode = explicitMode;
		if (frameUrls.length >= 2) {
			if (frameUrls.length === 2) {
				media.first_frame = frameUrls[0];
				media.last_frame = frameUrls[1];
			} else {
				if (flash && frameUrls.length > 5) throw new Error(`${video25ErrorContext(model)}reference 图片最多 ${5} 张，收到 ${frameUrls.length} 张，请减少关键帧数量`);
				media.images = frameUrls;
			}
		} else if (imageUrl !== void 0) media.first_frame = imageUrl;
	} else if (frameUrls.length >= 2) {
		if (frameUrls.length === 2) {
			resolvedMode = "keyframe";
			media.first_frame = frameUrls[0];
			media.last_frame = frameUrls[1];
		} else {
			resolvedMode = "reference";
			if (flash && frameUrls.length > 5) throw new Error(`${video25ErrorContext(model)}reference 图片最多 ${5} 张，收到 ${frameUrls.length} 张，请减少关键帧数量`);
			media.images = frameUrls;
		}
	} else if (imageUrl !== void 0) {
		resolvedMode = "keyframe";
		media.first_frame = imageUrl;
	} else resolvedMode = "text";
	let resolvedSeconds;
	if (seconds !== void 0 && seconds !== null) {
		const explicit = Number(seconds);
		if (!Number.isInteger(explicit) || explicit < 4 || explicit > 12) throw new Error(`${video25ErrorContext(model)}无效的 seconds ${String(seconds)}：须为 ${4}–${12} 的整数秒`);
		resolvedSeconds = explicit;
	} else resolvedSeconds = secondsFromFrameTiming(numFrames, frameRate);
	const resolvedSize = resolveVideo25Size(size, model);
	let resolvedAspect;
	if (aspectRatio !== void 0 && aspectRatio !== null && String(aspectRatio).trim() !== "") {
		const a = String(aspectRatio).trim();
		if (!VIDEO25_ASPECT_TABLE.some((row) => row.ratio === a)) throw new Error(`${video25ErrorContext(model)}无效的 aspect_ratio "${a}"：支持 ${VIDEO25_ASPECT_TABLE.map((row) => row.ratio).join(" / ")}`);
		resolvedAspect = a;
	} else resolvedAspect = nearestAspect25(width, height);
	const body = {
		model: str(model, ""),
		prompt: str(prompt, ""),
		mode: resolvedMode,
		seconds: String(resolvedSeconds),
		size: resolvedSize,
		aspect_ratio: resolvedAspect
	};
	Object.assign(body, media);
	if (seed !== void 0 && seed !== null) {
		if (!Number.isInteger(seed)) throw new Error(`${video25ErrorContext(model)}无效的 seed ${seed}：必须是整数`);
		body.seed = seed;
	}
	return body;
}

//#endregion
//#region src/host/video-client.ts
/**
* The Agnes VIDEO async client — the create → poll spine.
*
* Part of the 2026-10 split of `video.ts` (see that file's header for the
* family map; behaviour was frozen by `video.test.mjs` before and after).
*
* This is the half that is deliberately NOT shaped like `draw.ts`: the draw
* protocol is a single request/response (`drawOnce`), video is an
* ASYNCHRONOUS TASK — you POST to create, then poll until the task reaches a
* terminal state. So the spine here is {@link createVideoTask} →
* {@link pollVideoResult}, everything is injectable (`fetchImpl`, `sleep`,
* `now`, `isDisposed`) so the whole loop runs offline against fakes, and a
* 10-minute wall-clock budget is testable in milliseconds.
*
* WHY NO COOLDOWN GATE, unlike `draw.ts`: that gate exists to stop an agent
* hammering a drained pool with attempts that cost seconds each. One video
* attempt costs MINUTES (create + poll) and draws on the same shared video
* rate-limit pool — on the token-plan tier, 5 RPM. The protocol's own latency
* spaces retries far wider than the 30s gate would, so a gate here would be
* dead code that merely looks protective. Recorded as a decision, not an
* omission.
*
* @module dsh-connect-agnes-token-plan/video-client
*/
/**
* Fire one JSON request and parse the answer.
*
* The deadline aborts through an `AbortController` so an in-flight body read is
* cancelled too, and the whole flow stays injectable for the tests.
* @param {object} options - wiring.
* @param {Function} options.fetchImpl - the fetch to use (injected).
* @param {string} options.url - the full endpoint.
* @param {string} options.method - `"POST"` or `"GET"`.
* @param {string} options.apiKey - the resolved `sk-` key.
* @param {object} [options.body] - the wire body (POST only).
* @param {number} [options.timeoutMs] - the per-call deadline.
* @returns {Promise<object>} the parsed JSON.
*/
async function requestJson({ fetchImpl, url, method, apiKey, body = void 0, timeoutMs = VIDEO_REQUEST_TIMEOUT_MS }) {
	if (typeof fetchImpl !== "function") throw new Error("video: fetchImpl is required");
	if (str(url, "") === "") throw new Error("video: endpoint is empty — check apiBase");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(/* @__PURE__ */ new Error(`video request timeout after ${timeoutMs}ms`)), Math.max(1e3, timeoutMs));
	try {
		const response = await fetchImpl(url, {
			method,
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`
			},
			...method === "POST" ? { body: JSON.stringify(body ?? {}) } : {},
			signal: controller.signal
		});
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(describeVideoFailure(response.status, text));
		}
		return await response.json().catch(() => {
			throw new Error("video: response is not valid JSON");
		});
	} finally {
		clearTimeout(timer);
	}
}
/**
* Create one video task.
* @param {object} options - `{ fetchImpl, endpoint, apiKey, body, timeoutMs }`.
* @returns {Promise<{videoId: string, taskId: string, status: string}>}
* @throws {Error} when the platform refuses, or returns no task identifier.
*/
async function createVideoTask({ fetchImpl, endpoint, apiKey, body, timeoutMs = VIDEO_REQUEST_TIMEOUT_MS }) {
	const data = await requestJson({
		fetchImpl,
		url: endpoint,
		method: "POST",
		apiKey,
		body,
		timeoutMs
	});
	const task = parseVideoTask(data);
	if (videoTaskIdOf(task) === "") throw new Error(`video: 平台未返回 video_id/task_id，无法轮询：${JSON.stringify(data).slice(0, 300)}`);
	return task;
}
/**
* Query one task's current state.
* @param {object} options - `{ fetchImpl, queryEndpoint, apiKey, videoId, model, timeoutMs }`.
* @returns {Promise<object>} a {@link parseVideoQuery} result.
*/
async function queryVideoTask({ fetchImpl, queryEndpoint, apiKey, videoId, model, timeoutMs = VIDEO_REQUEST_TIMEOUT_MS }) {
	const params = new URLSearchParams();
	params.set("video_id", str(videoId, ""));
	const name = str(model, "");
	if (name !== "") params.set("model_name", name);
	const data = await requestJson({
		fetchImpl,
		url: `${queryEndpoint}${queryEndpoint.includes("?") ? "&" : "?"}${params.toString()}`,
		method: "GET",
		apiKey,
		timeoutMs
	});
	return parseVideoQuery(data);
}
/** The default sleep, injected in tests so a poll loop runs instantly. */
function defaultSleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
* Poll a task until it reaches a terminal state or the budget runs out.
*
* The budget is wall-clock and enforced here rather than by a request count, so
* a slow platform cannot stretch the wait past `timeoutMs`. The timeout error
* carries the task id, because the task keeps running server-side — the agent
* can come back for it instead of re-generating.
* @param {object} options - wiring.
* @param {Function} options.fetchImpl - the fetch to use.
* @param {string} options.queryEndpoint - the `agnesapi` URL.
* @param {string} options.apiKey - the resolved key.
* @param {string} options.videoId - the task identifier.
* @param {string} [options.model] - sent as `model_name`.
* @param {number} [options.timeoutMs] - the poll budget.
* @param {number} [options.pollIntervalMs] - the gap between queries.
* @param {Function} [options.sleep] - injected sleeper.
* @param {Function} [options.now] - injected clock.
* @param {Function} [options.isDisposed] - `() => boolean`, true after unmount.
* @returns {Promise<object>} the terminal {@link parseVideoQuery} result.
* @throws {Error} on timeout, disposal, or a refused query.
*/
async function pollVideoResult({ fetchImpl, queryEndpoint, apiKey, videoId, model, timeoutMs = VIDEO_DEFAULT_TIMEOUT_MS, pollIntervalMs = VIDEO_POLL_INTERVAL_MS, sleep = defaultSleep, now = Date.now, isDisposed = () => false }) {
	const budget = Math.max(1e3, Math.floor(num(timeoutMs, VIDEO_DEFAULT_TIMEOUT_MS)));
	const interval = Math.max(100, Math.floor(num(pollIntervalMs, VIDEO_POLL_INTERVAL_MS)));
	const deadline = now() + budget;
	let attempts = 0;
	for (;;) {
		if (isDisposed()) throw new Error("Agnes video tool is no longer mounted");
		if (++attempts > 1e3) throw new Error(`视频生成轮询超过 ${VIDEO_MAX_POLLS} 次仍未结束（video_id=${videoId}）——任务仍在平台侧运行，请稍后用 video_id 重新查询，不要重复提交`);
		const value = await queryVideoTask({
			fetchImpl,
			queryEndpoint,
			apiKey,
			videoId,
			model
		});
		if (isVideoTerminal(value.status)) return value;
		const remaining = deadline - now();
		if (remaining <= 0) throw new Error(`视频生成超时（超过 ${budget}ms，任务仍处于 ${value.status === "" ? "unknown" : value.status}）——任务仍在平台侧运行，可用 video_id=${videoId} 稍后重新查询，不要重复提交`);
		await sleep(Math.min(interval, remaining));
	}
}

//#endregion
//#region src/host/video.ts
/**
* The Agnes VIDEO tool definition — `agnes_video_generate` — and the
* compatibility barrel of the whole video family.
*
* Sibling of `draw.ts`, and deliberately NOT a copy of it: the two protocols
* differ in the one way that decides the whole shape of the code. `draw.ts` is
* a single request/response (`drawOnce`); video is an ASYNCHRONOUS TASK — you
* POST to create, then poll until the task reaches a terminal state. The
* spine and its no-cooldown rationale live in `video-client.ts`.
*
* 2026-10 split (the token-store playbook: behaviour frozen first, then moved
* — `video.test.mjs` ran green against THIS file, unchanged, before and after
* the split). The family now reads:
*
*   - `video-protocol.ts`      — endpoints (the host trap, the `/v1` vs
*                                `/agnesapi` asymmetry), the V2.0 frame body,
*                                task-response parsing, failure triage;
*   - `video-protocol-25.ts`   — the 2.5 whole-second body (mutually exclusive
*                                with V2.0 at the wire level; `isVideo25Family`
*                                dispatches between the two builders);
*   - `video-models.ts`        — catalog roster: which entries are video,
*                                which family each speaks, and the pick;
*   - `video-client.ts`        — the create → poll async client (fetch, sleep,
*                                clock, disposal — all injectable);
*   - `video.ts` (THIS module) — {@link defineVideoTool} wiring + the barrel
*                                below, which re-exports the pre-split surface
*                                verbatim so `import ... from "./video.ts"`
*                                keeps working unchanged.
*
* @module dsh-connect-agnes-token-plan/video
*/
/** The agent tool name. Prefixed like `agnes_draw_image` so it cannot collide with another plugin's tool. */
const VIDEO_TOOL_NAME = "agnes_video_generate";
/**
* Build the agent tool object for `ctx.tools.register`.
*
* Pure wiring, exactly like `defineDrawTool`: the peer's `defineTool` factory
* arrives as a parameter, and every side effect (key resolution, the live
* catalog, the fetch, disposal) is injected. `lifecycle.ts` calls this only
* when `videoEnabled` is on AND a tools service is present.
* @param {object} options - wiring.
* @param {Function} options.defineTool - the peer's tool factory.
* @param {Function} options.resolveApiKey - async `() => Promise<string>`.
* @param {Function} options.getEntries - `() => catalog entries` (sync or async), read at call time.
* @param {object} options.settings - `{ apiBase, videoModelId, videoTimeoutMs, videoWidth, videoHeight, videoNumFrames, videoFrameRate }`.
* @param {Function} options.fetchImpl - the fetch for the two HTTP calls.
* @param {Function} [options.isDisposed] - `() => boolean`, true after unmount.
* @returns {object} the tool definition for `ctx.tools.register`.
*/
function defineVideoTool({ defineTool, resolveApiKey, getEntries, settings, fetchImpl, isDisposed = () => false }) {
	const budget = Math.max(5e3, Math.floor(num(settings?.videoTimeoutMs, VIDEO_DEFAULT_TIMEOUT_MS)));
	const defaults = {
		width: Math.floor(num(settings?.videoWidth, VIDEO_DEFAULT_WIDTH)),
		height: Math.floor(num(settings?.videoHeight, 768)),
		numFrames: Math.floor(num(settings?.videoNumFrames, 121)),
		frameRate: num(settings?.videoFrameRate, 24)
	};
	return defineTool({
		name: VIDEO_TOOL_NAME,
		description: "Generate a video with the Agnes Token Plan key (asynchronous: this creates a task and then polls it, so one call can take minutes). Models are auto-discovered from this key's catalog; pass `model` only when you specifically need one. Two parameter families exist and the tool picks the matching one per model: V2.0 (`agnes-video-v2.0`) takes `width` / `height` / `num_frames` (8n+1, ≤ " + 441 + "; 81≈3s, 121≈5s, 241≈10s at " + 24 + "fps) / `frame_rate`; 2.5 (`agnes-video-2.5` / `agnes-video-2.5-flash`) takes the whole-second scheme instead — `seconds` (" + 4 + "–" + 12 + "), `size` (" + VIDEO25_SIZES.join("/") + ", flash is 720P only) and `aspect_ratio` (21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16). The two families do not mix at the platform — sending V2.0 frame fields straight to a 2.5 model is a 400, so the tool translates `num_frames` / `frame_rate` to the nearest whole second when `seconds` is omitted, and `width` / `height` steer the aspect ratio. The reverse mix is refused, not dropped: 2.5-only fields (`seconds` / `size` / `aspect_ratio` / `mode` / `keyframes`) sent to a V2.0 model throw — set `model` to a 2.5 id. Image-to-video: `image` (one URL); keyframe animation on 2.5: `keyframes` (≥2 URLs, or a single `image` as the first frame).",
		parameters: {
			prompt: {
				type: "string",
				required: true,
				description: "Video content description"
			},
			model: {
				type: "string",
				description: "Agnes video model id; defaults to the first V2.0 model, or the first 2.5 model when the catalog holds no V2.0 one"
			},
			image: {
				type: "string",
				description: "Optional public HTTPS image URL for image-to-video (2.5: used as the keyframe first frame); never combined with keyframes"
			},
			keyframes: {
				type: "array",
				items: { type: "string" },
				description: "2.5 only: keyframe image URLs, ≥2; exactly 2 becomes a first/last-frame keyframe animation, 3+ a reference set (2.5-flash: ≤5); never combined with image"
			},
			width: {
				type: "number",
				description: `V2.0: video width in pixels, default ${VIDEO_DEFAULT_WIDTH}; on 2.5 models it only feeds the aspect-ratio nearest-match`
			},
			height: {
				type: "number",
				description: `V2.0: video height in pixels, default ${768}; on 2.5 models it only feeds the aspect-ratio nearest-match`
			},
			num_frames: {
				type: "number",
				description: `V2.0: frame count, ≤ ${441} and 8n+1, default ${121}; on 2.5 models it converts to the nearest whole second when seconds is omitted`
			},
			frame_rate: {
				type: "number",
				description: `V2.0: frames per second, ${1}-${60}, default ${24}; on 2.5 models it only joins the seconds conversion`
			},
			seconds: {
				type: "number",
				description: `2.5 only: duration in whole seconds, ${4}-${12}; omitted = derived from num_frames/frame_rate or the documented default ${5}`
			},
			size: {
				type: "string",
				description: `2.5 only: resolution tier ${VIDEO25_SIZES.join(" / ")}; 2.5-flash accepts ${VIDEO25_FLASH_ONLY_SIZE} only; omitted = ${VIDEO25_DEFAULT_SIZE}`
			},
			aspect_ratio: {
				type: "string",
				description: `2.5 only: aspect ratio ${VIDEO25_ASPECT_TABLE.map((row) => row.ratio).join(" / ")}; omitted = nearest match of width/height`
			},
			mode: {
				type: "string",
				description: `2.5 only: generation mode ${VIDEO25_MODES.join(" / ")}; omitted = derived from image/keyframes (none → text, one → keyframe, 2 → keyframe first/last, 3+ → reference)`
			},
			seed: {
				type: "number",
				description: "Integer seed for reproducible output; omit for a random one"
			},
			negative_prompt: {
				type: "string",
				description: "V2.0 only: content to avoid (the 2.5 system has no equivalent and it is not forwarded)"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					source: { type: "string" },
					model: { type: "string" },
					videoId: { type: "string" },
					status: { type: "string" },
					url: { type: "string" },
					seconds: { type: "string" },
					prompt: { type: "string" },
					hint: { type: "string" }
				}
			},
			render: (_args, result) => [{
				type: "text",
				text: result?.hint || "视频已生成"
			}]
		},
		timeoutMs: budget + 6e4,
		async execute(params) {
			if (isDisposed()) throw new Error("Agnes video tool is no longer mounted");
			const prompt = str(params?.prompt, "").trim();
			if (prompt === "") throw new Error("prompt is required");
			const apiKey = await resolveApiKey();
			if (typeof apiKey !== "string" || apiKey.trim() === "") throw new Error("AGNES_TOKEN_PLAN_API_KEY 未配置：在面板「模型接入」粘贴 API Key（免费版 sk- 或 Token Plan cpk-），或设置该环境变量");
			let picked;
			try {
				picked = await getEntries?.() ?? [];
			} catch {
				picked = [];
			}
			const model = pickVideoModel(Array.isArray(picked) ? picked : [], params?.model, settings?.videoModelId);
			if (model === null) throw new Error("catalog 中没有视频模型（`output_modalities` 字段与 `agnes-video-*` 名称判定均为空）：确认 Key 已配置、面板已至少轮询一次，且套餐含视频模型");
			if (!isVideo25Family(model)) {
				const twentyFiveOnly = VIDEO25_ONLY_FIELDS.filter((field) => params?.[field] !== void 0 && params?.[field] !== null);
				if (twentyFiveOnly.length > 0) throw new Error(`模型 ${model} 是 V2.0 帧制（width / height / num_frames / frame_rate），不识别 2.5 秒数制的 ` + twentyFiveOnly.map((field) => `\`${field}\``).join(" / ") + "；请显式传 model 指向 2.5 家族（agnes-video-2.5 / agnes-video-2.5-flash），或去掉这些参数、改用 num_frames / frame_rate");
			}
			const body = isVideo25Family(model) ? buildVideoBody25({
				model,
				prompt,
				mode: params?.mode,
				seconds: params?.seconds,
				size: params?.size,
				aspectRatio: params?.aspect_ratio,
				width: params?.width,
				height: params?.height,
				numFrames: params?.num_frames,
				frameRate: params?.frame_rate,
				image: params?.image,
				keyframes: params?.keyframes,
				seed: params?.seed
			}) : buildVideoBody({
				model,
				prompt,
				width: params?.width ?? defaults.width,
				height: params?.height ?? defaults.height,
				numFrames: params?.num_frames ?? defaults.numFrames,
				frameRate: params?.frame_rate ?? defaults.frameRate,
				seed: params?.seed,
				negativePrompt: params?.negative_prompt,
				image: params?.image
			});
			const created = await createVideoTask({
				fetchImpl,
				endpoint: buildVideoEndpoint(settings?.apiBase),
				apiKey,
				body
			});
			const videoId = videoTaskIdOf(created);
			const result = await pollVideoResult({
				fetchImpl,
				queryEndpoint: buildVideoQueryEndpoint(settings?.apiBase),
				apiKey,
				videoId,
				model,
				timeoutMs: budget,
				isDisposed
			});
			if (result.status === "failed") {
				const detail = typeof result.error === "string" ? result.error : JSON.stringify(result.error ?? "(无错误详情)");
				throw new Error(`视频生成失败（video_id=${videoId}，模型 ${model}）：${detail}`);
			}
			const hint = result.url !== "" ? `视频已生成!\n模型: ${model}\nvideo_id: ${videoId}${result.seconds === "" ? "" : `\n时长: ${result.seconds} 秒`}${result.size === "" ? "" : `\n分辨率: ${result.size}`}\nURL: ${result.url}\n请直接输出 Markdown 链接: [视频](${result.url})` : `视频任务已完成，但响应里没有可直接访问的 URL（video_id=${videoId}，模型 ${model}）。请用 video_id 查询任务详情。`;
			return {
				source: "agnes",
				model,
				videoId,
				status: result.status,
				url: result.url,
				seconds: result.seconds,
				prompt,
				hint
			};
		}
	});
}

//#endregion
//#region src/host/lifecycle.ts
/**
* The plugin's side effects — the parts of mounting that are not route
* handlers.
*
* `apply()` is the single mount seam: it assembles the `wiring` object, calls
* {@link registerRoutes} (routes.ts), then {@link startSideEffects} for:
*
*   - the mount seed (`seedPublisherFromCatalog`): offer models before the
*     first poll, fire-and-forget;
*   - the two generation tools (opt-in `drawEnabled` / `videoEnabled`,
*     doubly degraded through the shared {@link mountAgentTool} ladder);
*   - vision step two: the settings-row writer filled for the snapshot route.
*
* and {@link teardown} for the unmount order that PITFALLS §18 pins
* (`dispose → release → off×5` — it must NOT be simplified).
*
* Peer-free discipline: no Host peer is imported here. The only lazy peer
* loads (the adapter / tools modules) are injected from `apply` via `deps`.
*
* @module dsh-connect-agnes-token-plan/lifecycle
*/
/** How many times a mount-time optional-service read is retried. */
const SERVICE_RETRY_ATTEMPTS = 3;
/** Base backoff between service-read attempts (× attempt index). */
const SERVICE_RETRY_DELAY_MS = 300;
/**
* Read an optional Host service with a bounded retry.
*
* A service may register AFTER this plugin mounts, and a mount-time read is
* the only window for a capability the Host cannot later remove: the tools
* registry has no unregister call. A one-shot read therefore misses a service
* that arrives a moment late for the WHOLE session, silently — the draw tool
* would be absent with the switch visibly on, and no line on any panel naming
* the reason. The AgnesCode mount seed uses the same retry for its publish.
*
* This retries the READ ONLY. Whatever it returns is used exactly once by the
* caller: retrying a call that mutates (a tool registration) would register the
* same tool twice, and the tools registry cannot tell.
* @param {object} ctx - the host root context.
* @param {string} service - the service name for `ctx.get`.
* @param {object} [options]
* @param {() => boolean} [options.isDisposed] - stop early when the plugin is
*   withdrawing; a late registration into a withdrawing Host is worse than
*   absence.
* @param {number} [options.attempts] - test seam for the attempt count.
* @param {number} [options.delayMs] - test seam for the backoff base.
* @returns {Promise<unknown|null>} the service, or `null` when it never
*   appeared inside the window.
*/
async function resolveServiceWithRetry(ctx, service, options = {}) {
	const { isDisposed = () => false, attempts = SERVICE_RETRY_ATTEMPTS, delayMs = SERVICE_RETRY_DELAY_MS } = options;
	let found = null;
	await retryBounded({
		attempts,
		delayMs,
		run: () => {
			if (isDisposed()) return true;
			try {
				const value = ctx.get?.(service) ?? ctx[service] ?? null;
				if (value !== null && value !== void 0) {
					found = value;
					return true;
				}
			} catch {}
			return false;
		}
	});
	return found;
}
/**
* Mount one opt-in agent tool, through the shared degradation ladder.
*
* `registerDrawTool` and `registerVideoTool` differ only in which switch, which
* model preference, which fetch and which factory they name — everything else
* (the config-error gate, the panel-beats-config precedence, the tools-service
* probe, the lazy peer load, the refusing-registry catch, the catalog read at
* call time) is the same ladder. It is written ONCE so the two tools cannot
* degrade differently: a tool that vanished on a Host where the other survived
* would be a bug with no visible cause.
*
* Every rung returns silently rather than throwing. A Host without a tools
* service, or a peer that fails to load, must leave the panel and the provider
* untouched — the tool is simply absent.
* @param {object} options - wiring.
* @param {object} options.ctx - the host root context.
* @param {object} options.wiring - see {@link startSideEffects}.
* @param {object} options.side - the test seams from `apply`'s `deps`.
* @param {object} [options.store] - the panel switch store (`draw-store` / `video-store`).
* @param {string} options.enabledKey - the settings key holding the config default.
* @param {string} options.modelKey - the settings key holding the configured model id.
* @param {Function} options.fetchImpl - the request fetch (stubbed in tests).
* @param {Function} options.factory - `defineDrawTool` / `defineVideoTool`.
* @returns {Promise<void>}
*/
async function mountAgentTool({ ctx, wiring, side, store, enabledKey, modelKey, fetchImpl, factory }) {
	const { settings, configError, providerState, catalogStore, resolveApiKey, publisher } = wiring;
	if (configError !== null) return;
	const { enabled: toolEnabled } = resolveSwitchEnabled(await readPanelValue(async () => await store?.enabled() ?? null), settings[enabledKey]);
	if (toolEnabled !== true) return;
	const panelModelId = await readPanelValue(async () => await store?.modelId() ?? null);
	const effectiveSettings = panelModelId !== null ? {
		...settings,
		[modelKey]: panelModelId
	} : settings;
	const tools = await resolveServiceWithRetry(ctx, "tools", { isDisposed: () => publisher.isDisposed() });
	if (tools === null || typeof tools.register !== "function") return;
	let defineTool;
	try {
		const mod = await Promise.resolve(side.loadToolsModule?.());
		defineTool = mod?.defineTool ?? mod?.default?.defineTool ?? null;
	} catch {
		return;
	}
	if (typeof defineTool !== "function") return;
	try {
		tools.register(factory({
			defineTool,
			resolveApiKey,
			getEntries: async () => {
				const live = Array.isArray(providerState.entries) && providerState.entries.length > 0 ? providerState.entries : await catalogStore.list().catch(() => []);
				return Array.isArray(live) ? live : [];
			},
			settings: effectiveSettings,
			fetchImpl,
			isDisposed: () => publisher.isDisposed()
		}));
	} catch {}
}
/**
* Register the `agnes_draw_image` agent tool (ARCHITECTURE.md §5.4, route B).
* Opt-in (`drawEnabled`, default off) and doubly degraded. Named as a separate
* export so a test can inject its own `ctx`/`wiring`; `startSideEffects` calls
* it when enabled.
* @param ctx - the host root context (reads `ctx.get("tools")` / `ctx.tools`).
* @param {object} wiring - see {@link startSideEffects}.
* @param {object} side - test seams from `apply`'s `deps`.
* @returns {Promise<void>}
*/
async function registerDrawTool(ctx, wiring, side) {
	await mountAgentTool({
		ctx,
		wiring,
		side,
		store: wiring.drawStore,
		enabledKey: "drawEnabled",
		modelKey: "drawModelId",
		fetchImpl: side.drawFetch,
		factory: defineDrawTool
	});
}
/**
* Register the `agnes_video_generate` agent tool (`video.ts`).
*
* A SEPARATE opt-in from the draw tool (`videoEnabled`), sharing only the
* mounting ladder — see {@link mountAgentTool}. The protocol is the reason the
* two are not one module: video is an asynchronous task, so this tool creates a
* task and then polls it for minutes rather than issuing one request.
* @param ctx - the host root context.
* @param {object} wiring - see {@link startSideEffects}.
* @param {object} side - test seams from `apply`'s `deps`.
* @returns {Promise<void>}
*/
async function registerVideoTool(ctx, wiring, side) {
	await mountAgentTool({
		ctx,
		wiring,
		side,
		store: wiring.videoStore,
		enabledKey: "videoEnabled",
		modelKey: "videoModelId",
		fetchImpl: side.videoFetch,
		factory: defineVideoTool
	});
}
/**
* Run the mount-time side effects: the persisted-catalog seed, the draw tool
* (when opted in), and vision step two's settings-row writer.
* @param ctx - the host root context.
* @param {object} wiring - assembled by `apply()`.
* @param {object} wiring.settings - the resolved settings row.
* @param {string|null} wiring.configError - a settings/auth misconfiguration.
* @param {object} wiring.publisher - the `createProviderPublisher` instance.
* @param {object} wiring.providerState - `publisher.state` (shared reference).
* @param {object} wiring.catalogStore - the `createFileCatalogStore` instance.
* @param {Function} wiring.resolveApiKey - resolves the live `sk-` key.
* @param {{current: Function|null}} wiring.visionPublish - filled here.
* @param {object} [wiring.logger] - `ctx.logger` (Host logging).
* @param {object} side - test seams from `apply`'s `deps`
*   (`loadToolsModule`, `drawFetch`).
* @returns {void} — seed and draw are fire-and-forget.
*/
function startSideEffects(ctx, wiring, side) {
	const { publisher, catalogStore, settings, visionPublish } = wiring;
	seedPublisherFromCatalog(publisher, () => catalogStore.list(), () => catalogStore.listEnabledIds(), catalogSignature);
	registerDrawTool(ctx, wiring, side);
	registerVideoTool(ctx, wiring, side);
	{
		const settingsService = ctx.get("settings") ?? null;
		if (settingsService !== null && typeof settingsService.update === "function") {
			const descriptorOf = () => {
				try {
					const view = settingsService.describe?.({ redactSecrets: true });
					return (Array.isArray(view) ? view : view?.entries ?? []).find((candidate) => candidate?.ns === "dsh-connect-agnes-token-plan") ?? null;
				} catch {
					return null;
				}
			};
			let publishing = false;
			let lastPublishedIds = settings.imageModelIds.slice();
			visionPublish.current = async (visionEntries, ids) => {
				if (settings.writeImageModelIds !== true) return;
				if (publishing) return;
				if (JSON.stringify(lastPublishedIds) === JSON.stringify(ids)) return;
				const descriptor = descriptorOf();
				if (descriptor === null) return;
				publishing = true;
				try {
					await settingsService.update(name, {
						imageModelIds: ids,
						visionModels: visionEntries
					}, descriptor.revision);
					lastPublishedIds = ids.slice();
				} catch (error) {
					wiring.logger?.warn?.(`${name}: vision publish refused: ${error instanceof Error ? error.message : String(error)}`);
				} finally {
					publishing = false;
				}
			};
		}
	}
}
/**
* Unmount, in the order PITFALLS §18 pins:
*
*   1. `dispose` — a publish still in flight (the mount seed's, or a poll's)
*      must not register into a Host that is letting this plugin go;
*   2. `release` — stop offering the provider first, so a request cannot be
*      routed to an adapter whose Host services are already half gone;
*   3. the route `off()` callbacks, each guarded (the web server may already
*      be gone during shutdown).
*
* This order is a concurrency fix and must NOT be simplified.
* @param {object} wiring - assembled by `apply()`.
* @param {Function} wiring.releaseProvider - `publisher.release()`.
* @param {object} wiring.publisher - the `createProviderPublisher` instance.
* @param {Function[]} offs - the unregister callbacks from {@link registerRoutes}.
* @returns {void}
*/
function teardown(wiring, offs) {
	const { publisher, releaseProvider, agnescodePublisher } = wiring;
	publisher.dispose();
	agnescodePublisher?.dispose();
	agnescodePublisher?.release?.();
	releaseProvider();
	for (const off of offs) try {
		off();
	} catch {}
}

//#endregion
//#region src/host/index.ts
/**
* dsh-connect-agnes-token-plan — Host half (thin router).
*
* Reads the Agnes Token Plan quota through the platform's own console API
* (the same endpoints the web console calls) and serves the result to the
* Client panel over one read-only `/api` route.
*
* The heavy lifting lives in focused sibling modules so this file stays a
* readable orchestrator:
*
*   - `host-config.ts`    config contract + the `isAdmitted` trust fence
*   - `routes.ts`         the HTTP route handlers (peer-free, wiring-injected)
*   - `lifecycle.ts`      mount seed / draw tool / vision step two / teardown
*   - `console-client.ts` console/catalog fetch with cache + single-flight
*   - `parsers.ts`        response normalization + shape-drift detection
*   - `snapshot-aggregate.ts` the snapshot body's data aggregation
*   - `provider-publish.ts`  the provider registration state machine
*   - `state-store.ts`    atomic state-file primitives for the three stores
*   - `trace.ts`          login-trace persistence (already sanitized upstream)
*   - `util.ts`           the small `str`/`num`/`obj` readers
*
* This file keeps the Cordis entry (`name`/`inject`/`apply`), the wiring
* assembly, and the unmount effect — the parts that are about *this* plugin's
* surface rather than reusable logic.
*
* @module dsh-connect-agnes-token-plan
*/
/**
* The record address format, matching `@deepseek-ai/dsh-credentials`.
*
* The service exports `credentialKey` for this, but a plugin that imports it
* statically cannot be exercised without that peer package present — which is
* what kept the test suite from running on a clean checkout. The Host's
* credentials service treats the plain `"scope/id"` string identically. Exported
* so `test/config.test.mjs` can pin its LITERAL shape on every machine (a clean
* checkout included), and `test/store.test.mjs` can assert it EQUALS the real
* peer function where that peer resolves — together they close the gap the old
* comment claimed was already closed but never actually tested.
* @param {string} scope - the plugin's namespace.
* @param {string} id - the record's name.
* @returns {string} the record key.
*/
const credentialKey = (scope, id) => `${scope}/${id}`;
/**
* Host body: assemble the wiring, register the routes, run the mount
* side effects, and hang the unmount effect. The route handlers live in
* `routes.ts`, the side effects in `lifecycle.ts` — this function only
* decides what they may touch.
* @param ctx - host root context.
* @param config - the row's raw patch config. There is no DSH Config schema, so
*   values arrive unvalidated; the endpoint overrides are checked where they
*   are consumed (`createAuth` throws on a malformed origin) and the failure
*   is surfaced through the snapshot instead of crashing the route.
* @param deps - test-only seams (the peer adapter / tools modules, a draw
*   fetch replacement). The real Loader passes nothing.
*/
function apply(ctx, config = {}, deps = {}) {
	const { settings, configError: rowError } = resolveSettings(config);
	let configError = rowError;
	let auth = null;
	if (configError === null) try {
		auth = createAuth(settings.auth);
	} catch (error) {
		configError = error instanceof Error ? error.message : String(error);
	}
	const apiKeyStore = createApiKeyStore({ credentials: () => ctx.get("credentials") ?? null });
	const resolveApiKey = async () => (await apiKeyStore.resolve()).value;
	/** @type {Map<string, import("./console-client.ts").CacheEntry>} */
	const cache = /* @__PURE__ */ new Map();
	/** One in-flight console fetch per URL, so concurrent polls share a call. */
	const inflight = /* @__PURE__ */ new Map();
	const profile = profileSegment(ctx);
	const catalogStore = deps.catalogStore ?? createFileCatalogStore({ profile });
	const providerStore = createFileProviderStore({ profile });
	const drawStore = createFileDrawStore({ profile });
	const videoStore = createFileVideoStore({ profile });
	/** Read an optional service without throwing on a Host that lacks it. */
	const getService = (service) => {
		try {
			return ctx.get?.(service) ?? null;
		} catch {
			return null;
		}
	};
	const loadAdapterModule = deps.loadAdapterModule ?? (() => import("./llm-adapter-CpOfMoAY.js"));
	const publisher = createProviderPublisher({
		settings,
		panelSwitch: () => providerStore.enabled().catch(() => null),
		loadAdapterModule,
		getLlm: (service) => getService(service),
		resolveApiKey,
		emit: () => emitAdaptersUpdated((name) => ctx.emit?.(name)),
		logger: ctx.logger
	});
	const providerState = publisher.state;
	const publishProvider = (entries, enabledIds, unavailableModelIds = []) => publisher.publish(entries, enabledIds, unavailableModelIds);
	const releaseProvider = () => publisher.release();
	const agnescodeStore = createAgnescodeStore({ credentials: () => ctx.get("credentials") ?? null });
	const agnescodeSwitch = createFileAgnescodeStore({ profile });
	const agnescodeModels = createFileAgnescodeModelsStore({ profile });
	const { publisher: agnescodePublisher, seed: agnescodeSeed } = wireAgnescodePublisher({
		store: agnescodeStore,
		panelSwitch: () => agnescodeSwitch.enabled().catch(() => null),
		enabledIds: () => agnescodeModels.listEnabledIds().catch(() => []),
		getLlm: (service) => getService(service),
		loadAdapterModule: deps.loadAgnescodeAdapterModule,
		emit: () => emitAdaptersUpdated((name) => ctx.emit?.(name)),
		logger: ctx.logger
	});
	agnescodeSeed();
	const tokenStore = createTokenStore({
		auth: auth ?? createAuth(),
		credentials: () => ctx.get("credentials") ?? null,
		credentialKey,
		skewMs: settings.tokenSkewSeconds * 1e3,
		throttleStore: createFileThrottleStore(),
		onTrace: (hops, error) => {
			writeLoginTrace(hops, error === null ? "ok" : str(error?.code, CODE.AUTH_ERROR));
		}
	});
	const wiring = {
		settings,
		configError,
		cache,
		inflight,
		tokenStore,
		apiKeyStore,
		catalogStore,
		providerStore,
		drawStore,
		videoStore,
		publisher,
		providerState,
		publishProvider,
		releaseProvider,
		resolveApiKey,
		visionPublish: { current: null },
		logger: ctx.logger,
		agnescodeStore,
		agnescodeSwitch,
		agnescodeModels,
		agnescodePublisher
	};
	const offs = registerRoutes(ctx, wiring);
	startSideEffects(ctx, wiring, {
		loadToolsModule: deps.loadToolsModule ?? (() => import("@deepseek-ai/dsh-tools")),
		drawFetch: deps.drawFetch ?? ((url, options) => fetch(url, options)),
		videoFetch: deps.videoFetch ?? ((url, options) => fetch(url, options))
	});
	ctx.effect(() => {
		return () => {
			teardown(wiring, offs);
		};
	}, `${name}: routes`);
}

//#endregion
export { CONFIG_DEFAULTS, apply, catalogSignature, credentialKey, hostName, inject, isAdmitted, name, resolveAuthOverrides, resolveSettings };