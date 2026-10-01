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
export function throttleError(held, cause) {
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
export function localBackoffMs(attempt) {
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
export async function readThrottle(wiring, _state) {
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
export async function writeThrottle(wiring, state, error, previousAttempt) {
  const { throttleStore, now } = wiring;
  const code = str(error?.code, CODE.LOGIN_FAILED);
  const parked = isCredentialRefusal(code);
  // A window the platform stated is taken at its word; only a window we
  // invented is capped.
  const stated = numOrNull(error?.retryAfterMs);
  state.consecutiveRefusals = num(previousAttempt, state.consecutiveRefusals) + 1;
  const attempt = state.consecutiveRefusals;
  const until = parked
    ? null
    : now() + (stated === null ? localBackoffMs(attempt) : Math.max(stated, 0));
  state.throttle = { code, parked, until, attempt };
  // This plugin's own file, not the credentials service: a throttle is not a
  // credential, and the only two record kinds that service admits are.
  await throttleStore.write(state.throttle).catch(() => {
    // A store that cannot be written must not break the panel: this process
    // still honours the wait in memory.
  });
  return state.throttle;
}

/**
 * Drop the throttle, so the next sign-in is allowed to try.
 * @returns {Promise<void>}
 */
export async function clearThrottle(wiring, state) {
  const { throttleStore, backend, THROTTLE_KEY } = wiring;
  state.throttle = null;
  await throttleStore.clear().catch(() => {
    // Nothing to do: the in-memory clear above already took effect.
  });
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
export function inForceWaitMs(wiring, held) {
  const { now } = wiring;
  if (held === null || held.parked) return null;
  return Math.max(0, held.until - now());
}
