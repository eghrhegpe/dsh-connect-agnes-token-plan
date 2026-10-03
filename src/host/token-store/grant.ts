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

import { readJwtExpiry } from "../agnes-auth.ts";
import { str, obj, num, numOrNull } from "../util.ts";

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
export function parseGrant(record) {
  if (record === undefined || record === null || obj(record).kind !== "grant") return undefined;
  const payload = obj(obj(record).payload);
  if (num(payload.version) !== GRANT_VERSION) return undefined;
  const accessToken = str(payload.accessToken, "");
  if (accessToken === "") return undefined;
  return {
    accessToken,
    refreshToken: str(payload.refreshToken, ""),
    // Prefer the claim we can read off the token itself; fall back to what the
    // token endpoint reported when the claim is unreadable.
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
export async function readStored(wiring, _state) {
  const { backend, key } = wiring;
  try {
    return parseGrant(await backend().readRecord(key));
  } catch {
    return undefined;
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
 *   Agnes issues none, so this is always `""` on the current platform; the
 *   parameter and the stored field stay because the record shape is the
 *   frozen behavior baseline's face (and `acquire()` reads it to decide the
 *   dormant renewal path).
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
export async function storeGrant(wiring, state, accessToken, refreshToken, expiresIn, replacing) {
  const { backend, key, now } = wiring;
  const issuedAt = now();
  const payload = {
    version: GRANT_VERSION,
    accessToken,
    refreshToken,
    expiresAt: issuedAt + num(expiresIn, 10800) * 1000
  };
  try {
    const record = await backend().modifyRecord(key, (current) => {
      const existing = parseGrant(current);
      if (replacing !== undefined) {
        // A named predecessor: compare-and-set used by every refresh AND by a
        // password login that read an existing grant. If the record moved to
        // some other token while this write was in flight, that other write
        // won and this one defers — two processes racing a login/refresh
        // cannot invalidate each other's rotated refresh token, while an
        // intentional account switch replaces the grant it read.
        if (existing !== undefined && existing.accessToken !== replacing) {
          return undefined;
        }
      } else if (existing !== undefined
        && existing.expiresAt !== null && existing.expiresAt > issuedAt + 60_000) {
        // No named predecessor — a first-ever login that read no grant. Two
        // processes bootstrapping at once both land here; the one whose write
        // lands second keeps the already-healthy grant instead of rotating
        // the refresh token under the first. A login over an EXISTING grant
        // always names it, so an account switch is never swallowed by this.
        return undefined;
      }
      return Promise.resolve({ kind: "grant", payload });
    });
    const stored = parseGrant(record) ?? payload;
    state.cached = stored;
    return stored;
  } catch (error) {
    // A read-only store must not break the panel: keep the token in memory
    // for this process and let the next start re-login.
    state.cached = { accessToken, refreshToken, expiresAt: payload.expiresAt };
    throw new Error(
      `could not persist the console token (${error instanceof Error ? error.message : String(error)}); ` +
        "it stays valid until dsh restarts"
    );
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
 *
 * The `refresh_rejected` half can only occur on a predecessor-shaped grant:
 * Agnes has no refresh endpoint, so its stored grants never carry the token
 * a platform could reject — the live trigger today is the "no account to
 * re-login with" half (after "forget account", once the live token expires).
 * Best-effort: a read-only store keeps serving from memory until restart.
 * @param {string} [accessToken] - the dead token, also dropped from the
 *   in-memory cache and rejection set.
 */
export async function purgeGrant(wiring, state, accessToken) {
  const { backend, key } = wiring;
  state.cached = null;
  if (accessToken !== undefined) state.rejected.delete(accessToken);
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
export function isFresh(wiring, state, token, at) {
  const { now, skewMs } = wiring;
  if (at === undefined) at = now();
  if (token === undefined || token === null) return false;
  // A token the console refused is never fresh, however long its `exp` says.
  if (state.rejected.has(token.accessToken)) return false;
  if (token.expiresAt === null) return true; // unknown expiry: let the console decide
  return token.expiresAt - at > skewMs;
}
