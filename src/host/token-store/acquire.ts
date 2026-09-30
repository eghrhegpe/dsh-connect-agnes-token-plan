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

import { obj } from "../util.ts";
import { CODE } from "../codes.ts";

/**
 * Acquire a usable token, logging in or refreshing as needed.
 *
 * @param {object} wiring - the store context wiring.
 * @param {object} state - the store context state.
 * @param {object} blocks - the four block functions, injected by the caller.
 * @returns {Promise<string>} the access token now in effect.
 */
export async function acquire(wiring, state, blocks) {
  const { now } = wiring;
  const {
    readThrottle, clearThrottle,
    readStored, isFresh,
    renewWithRefresh,
    readAccount, loginFromAccount,
    writeThrottle, throttleError, purgeGrant
  } = blocks;

  // A refused sign-in is not repeated on a timer: the platform locks an
  // account after a few bad attempts, so a poll loop that keeps trying
  // turns one mistake into a lockout. Fail fast and say why instead.
  const held = state.throttle ?? await readThrottle();
  state.throttle = held;
  if (held !== null && (held.parked || held.until > now())) {
    throw throttleError(held);
  }
  if (held !== null) {
    // Its window closed, so the refusal may be probed again — but the attempt
    // count is kept, so the next wait is longer than this one. Clearing the
    // throttle here and forgetting the count is what made every backoff
    // silently restart at one minute.
    state.consecutiveRefusals = held.attempt;
    await clearThrottle();
  }

  const stored = (await readStored()) ?? state.cached ?? undefined;
  if (isFresh(stored)) {
    state.cached = stored;
    return stored.accessToken;
  }
  // Prefer renewal: it needs no password, and the password may have been
  // removed from the environment long after the first login.
  if (stored?.refreshToken !== undefined && stored.refreshToken !== "") {
    try {
      const renewed = await renewWithRefresh(stored);
      return renewed.accessToken;
    } catch (error) {
      // A rejected refresh token (or a grant that never had one) is
      // unrecoverable without a password. When an account is still stored we
      // fall through and re-login; when there is none — typically right after
      // "forget account", once the live token expires — the grant is dead for
      // good, so reap it instead of leaving an ownerless pair on disk and
      // re-hitting the dead refresh on every poll.
      if (obj(error).code !== CODE.REFRESH_REJECTED && obj(error).code !== CODE.NO_REFRESH_TOKEN) throw error;
      if ((await readAccount()) === undefined) {
        await purgeGrant(stored?.accessToken);
        throw error;
      }
    }
  }
  try {
    const fresh = await loginFromAccount();
    // A sign-in that worked clears any earlier refusal: the wait is over by
    // the only evidence that matters, and the backoff starts over.
    state.consecutiveRefusals = 0;
    if (state.throttle !== null) await clearThrottle();
    return fresh.accessToken;
  } catch (error) {
    // No account is not a refusal and no request was made, so there is
    // nothing to throttle: recording one would claim the user did something
    // wrong and would keep a fresh install looking "needs user action".
    if (obj(error).code === CODE.NOT_CONFIGURED) throw error;
    // Otherwise record the refusal so the next poll does not walk into the
    // lock again. The platform's own error is what the panel shows, since it
    // carries the reason and any stated window; the throttle only governs
    // when the next attempt may happen.
    const held = await writeThrottle(error, state.throttle?.attempt);
    throw held.parked ? error : throttleError(held, error);
  }
}
