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

import { isCredentialRefusal, CODE } from "../codes.ts";
import { str, num, numOrNull } from "../util.ts";

/**
 * The first wait imposed on a refusal the platform gave no window for.
 *
 * Doubles from here; `MAX_LOGIN_BACKOFF_MS` caps it.
 */
export const DEFAULT_LOGIN_BACKOFF_MS = 60_000;

/**
 * Cap on a self-imposed wait.
 *
 * Applies ONLY to a wait this store invented. A window the platform stated
 * itself ("try again in 2 hours") is never truncated by it: capping that is
 * exactly what walks back into a lock that is still in force.
 */
export const MAX_LOGIN_BACKOFF_MS = 30 * 60_000;

/**
 * How many self-imposed waits one refusal may spend before it is parked.
 *
 * This is the ceiling on the guesses. A wait this store invented is a guess
 * about a failure it did not fully understand, and every guess is spent by
 * retrying — against an endpoint that locks the account after a few bad
 * attempts. So the guessing is finite: three invented waits, then the refusal
 * is parked and only the user can lift it.
 *
 * What it does NOT bound: a window the PLATFORM stated. Those are honoured
 * verbatim and uncapped (`MAX_LOGIN_BACKOFF_MS` deliberately does not apply
 * to them), because truncating a real window walks straight back into a lock
 * that is still in force. Counting them here would invent a cap on a number
 * somebody else actually told us.
 *
 * @see {@link exhaustsInventedWaits} for which refusals this applies to.
 */
export const MAX_INVENTED_WAITS = 3;

/**
 * Refusals that waiting cannot fix, and so must not be waited on forever.
 *
 * The companion set to `CREDENTIAL_REFUSALS`, which parks on the FIRST
 * refusal. These two get a finite number of invented waits first — a single
 * unrecognised 500 from a console that is having a bad day should not ask the
 * user to retype a password — but they are not retried indefinitely, because
 * no amount of waiting changes what they are:
 *
 * - `login_failed` is the classifier's own fallback: the platform refused in
 *   words this plugin does not have a rule for. It may well be permanent
 *   ("password expired", "reset required"). Retrying it forever is the one
 *   behaviour the throttle exists to prevent, and it is exactly what the
 *   fallback used to do — an unrecognised wording was translated into
 *   "temporary, back off, try again", indefinitely.
 * - `account_locked` with no stated window: the platform named a lock and did
 *   not say how long it lasts. Inventing a countdown and retrying when it
 *   expires is knocking on a locked door on a timer.
 *
 * A stated window overrides this entirely — see {@link MAX_INVENTED_WAITS}.
 * @type {ReadonlySet<string>}
 */
const FINITE_RETRY_REFUSALS: ReadonlySet<string> = Object.freeze(new Set([
  CODE.LOGIN_FAILED,
  CODE.ACCOUNT_LOCKED
]));

/**
 * Whether this refusal has spent its budget of self-imposed waits.
 *
 * True only when the three conditions hold together: the platform stated no
 * window of its own, the refusal is one waiting cannot fix, and the invented
 * waits are used up. A single missing condition means the wait is still
 * governing and nothing is parked.
 * @param {string} code - the classified refusal code.
 * @param {number|null} statedMs - the window the platform stated, if any.
 * @param {number} attempt - how many waits have now been served.
 * @returns {boolean} true when the refusal must be parked instead of timed.
 */
export function exhaustsInventedWaits(code: string, statedMs: number | null, attempt: number) {
  if (statedMs !== null) return false;
  if (typeof code !== "string" || !FINITE_RETRY_REFUSALS.has(code)) return false;
  return attempt >= MAX_INVENTED_WAITS;
}

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
export function throttleError(held: { code: string; parked: boolean; until: number | null; attempt: number }, cause?: Error) {
  if (cause !== undefined) return cause;
  const error = new Error(
    held.parked
      ? "sign-in is not being retried automatically: the account needs to be entered again"
      : `sign-in is not being retried automatically: waiting out a ${held.code} refusal`
  ) as Error & { code?: string };
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
export function localBackoffMs(attempt: number) {
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
export async function readThrottle(wiring: { throttleStore: { read: () => Promise<any> } }, _state: unknown) {
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
export async function writeThrottle(
  wiring: { throttleStore: { write: (t: any) => Promise<unknown> }; now: () => number },
  state: { consecutiveRefusals: number; throttle: { code: string; parked: boolean; until: number | null; attempt: number } | null },
  error: { code?: unknown; retryAfterMs?: unknown } | undefined,
  previousAttempt?: number
) {
  const { throttleStore, now } = wiring;
  const code = str(error?.code, CODE.LOGIN_FAILED);
  // A window the platform stated is taken at its word; only a window we
  // invented is capped.
  const stated = numOrNull(error?.retryAfterMs);
  state.consecutiveRefusals = num(previousAttempt, state.consecutiveRefusals) + 1;
  const attempt = state.consecutiveRefusals;
  // Two ways to stop retrying: the refusal is credential-shaped (parked at
  // once — waiting cannot fix a wrong password), or it is one waiting cannot
  // fix and the invented waits are used up (see `exhaustsInventedWaits`).
  // The second is what stops an UNRECOGNISED refusal from being retried
  // forever: the classifier's fallback used to translate "I do not know this
  // wording" into "temporary, back off, try again", which is the one thing
  // this store exists to prevent.
  const parked = isCredentialRefusal(code) || exhaustsInventedWaits(code, stated, attempt);
  const until = parked
    ? null
    : now() + (stated === null ? localBackoffMs(attempt) : Math.max(stated, 0));
  state.throttle = { code, parked, until, attempt };
  // This plugin's own file, not the credentials service: a throttle is not a
  // credential, and the only two record kinds that service admits are.
  //
  // `write` REPORTS rather than rejects (a read-only Home must not break the
  // panel), so the check is on the returned flag. It used to be a `.catch()` on
  // a promise that could never reject — the warning was unreachable code, and
  // losing cross-process lock protection was silent (PITFALLS §42).
  const persisted = await throttleStore.write(state.throttle).catch(() => false);
  if (persisted === false) {
    // A store that cannot be written must not break the panel: this process
    // still honours the wait in memory. Log a redacted warning for observability:
    // cross-process "防撞锁" protection may have failed; next Host will retry
    // based on in-memory state only.
    try {
      const msg = `throttle write failed: ${JSON.stringify(state.throttle, null, 2)}`;
      console.warn(`[dsh-connect-agnes-token-plan] ${msg}`); // 简单输出，避免引入 logger；message 不含凭据形状
    } catch {}
  }
  return state.throttle;
}

/**
 * Drop the throttle, so the next sign-in is allowed to try.
 * @returns {Promise<void>}
 */
export async function clearThrottle(
  wiring: { throttleStore: { clear: () => Promise<unknown> }; backend: () => { deleteRecord: (key: string) => Promise<unknown> }; THROTTLE_KEY: string },
  state: { throttle: { code: string; parked: boolean; until: number | null; attempt: number } | null }
) {
  const { throttleStore, backend, THROTTLE_KEY } = wiring;
  state.throttle = null;
  // Reported, not rejected — and the report is not optional. A throttle file
  // that survives "I signed in again" parks the NEXT Host start on a lock the
  // user believes they cleared, which reads as the plugin ignoring them. The
  // in-memory clear above already took effect, so this is a log line and
  // nothing more (PITFALLS §42).
  const cleared = await throttleStore.clear().catch(() => false);
  if (cleared === false) {
    try {
      console.warn(
        "[dsh-connect-agnes-token-plan] throttle clear failed: the file may survive and re-park the next sign-in"
      );
    } catch {}
  }
  // A record left at the credentials-service address by an earlier version of
  // THIS plugin is swept here. The equivalent sweep of the SenseNova plugin's
  // own legacy address is deliberately NOT performed: that record belongs to a
  // different plugin, and clearing an account lock it is waiting out would be
  // this plugin reaching into state it does not own.
  await backend().deleteRecord(THROTTLE_KEY).catch(() => {});
}

/**
 * How much longer a throttle is in force, or `null` when it is not.
 *
 * A parked refusal has no deadline and so no countdown.
 * @param {{parked: boolean, until: number|null}|null} held - the throttle.
 * @returns {number|null} milliseconds remaining.
 */
export function inForceWaitMs(wiring: { now: () => number }, held: { parked: boolean; until: number | null } | null) {
  const { now } = wiring;
  if (held === null || held.parked) return null;
  return Math.max(0, held.until! - now());
}
