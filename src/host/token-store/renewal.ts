/**
 * Block 3 of the token-store split: renewal through the stored refresh token.
 *
 * **Agnes reality: this block is a dormant predecessor path.** Agnes issues no
 * refresh token — `loginWith` returns `refreshToken: ""` by contract, so the
 * grant the store persists never carries one, and `acquire()` skips this
 * branch entirely (its `stored?.refreshToken !== ""` gate). The block keeps
 * the shape the store was forked from (the predecessor's refresh-token flow),
 * because the behavior baseline (`test/store-baseline.test.mjs`) exercises it
 * on predecessor-shaped grants, and the name + wiring type are part of that
 * frozen face. If it ever does fire (a predecessor-era grant that still held
 * a refresh token), `refresh()` throws `NO_REFRESH_TOKEN` — Agnes's auth
 * object has no refresh endpoint — and the acquire seam routes that code to
 * the password re-login. It is kept alive by design, not by accident.
 *
 * `renewWithRefresh` calls the grant block's `store` (compare-and-set write),
 * so it receives `store` as an injected callback — keeping this module free of
 * any `grant.ts` import (no circular dependency). The function body is
 * **verbatim**; the behavior baseline stays green.
 *
 * @module dsh-connect-agnes-token-plan/token-store/renewal
 */

import { CODE } from "../codes.ts";
import { pluginError } from "../util.ts";

/**
 * Renew with the stored refresh token.
 *
 * Goes through the grant block's `store`, which names the superseded access
 * token so a concurrent rotation is detected instead of silently overwritten.
 *
 * On Agnes this never runs: the stored grant's `refreshToken` is always the
 * empty string, so `acquire()`'s gate skips the call. The `NO_REFRESH_TOKEN`
 * throw below is the defensive half — it fires only if a predecessor-era
 * grant that actually held a refresh token lands in the store.
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresAt: number|null}>}
 */
export async function renewWithRefresh(
  wiring: { auth: { refresh: (token: string) => Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> } },
  _state: unknown,
  stored: { refreshToken?: string; accessToken: string } | undefined,
  store: (accessToken: string, refreshToken: string, expiresIn: number, replaced: string) => Promise<unknown>
) {
  const { auth } = wiring;
  if (stored?.refreshToken === undefined || stored.refreshToken === "") {
    throw pluginError(CODE.NO_REFRESH_TOKEN, "stored grant has no refresh token");
  }
  const result = await auth.refresh(stored.refreshToken);
  // Name the token this renewal supersedes, so a concurrent rotation is
  // detected instead of silently overwritten.
  return store(result.accessToken, result.refreshToken, result.expiresIn, stored.accessToken);
}
