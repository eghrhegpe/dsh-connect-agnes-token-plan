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

import { obj, str } from "./util.ts";
import { decodeAgnescodeJwtExpMs, trustAgnescodeBffBase } from "./agnescode.ts";

/** The reference name the credential is stored under. */
export const AGNESCODE_CREDENTIAL_REF = "AGNESCODE_CREDENTIAL";

/**
 * Parse the stored credential JSON; a malformed or absent value reads as no
 * credential rather than an error — the safe direction (one re-harvest, never
 * a crash).
 * @param {unknown} value - the reference value.
 * @returns {object|null} `{ accessToken, bffBase, userId, nickname, expiresAtMs? }` or `null`.
 */
export function parseAgnescodeCredential(value) {
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
  const expiresAtMs = decodeAgnescodeJwtExpMs(accessToken)
    ?? (typeof source.expires_at_ms === "number" ? source.expires_at_ms : undefined);
  return {
    accessToken,
    bffBase,
    userId: str(source.user_id, ""),
    nickname: str(source.nickname, ""),
    ...(expiresAtMs !== undefined ? { expiresAtMs } : {})
  };
}

/**
 * Serialize one credential for storage.
 * @param {object} credential - `{ accessToken, bffBase, userId?, nickname?, expiresAtMs? }`.
 * @returns {string} the JSON document.
 */
export function serializeAgnescodeCredential(credential) {
  const source = obj(credential);
  return JSON.stringify({
    version: 1,
    access_token: str(source.accessToken, ""),
    bff_public_base_url: str(source.bffBase, ""),
    ...(str(source.userId, "") !== "" ? { user_id: source.userId } : {}),
    ...(str(source.nickname, "") !== "" ? { nickname: source.nickname } : {}),
    ...(typeof source.expiresAtMs === "number" ? { expires_at_ms: source.expiresAtMs } : {})
  });
}

/**
 * Build the credential store.
 * @param {object} [options] - wiring.
 * @param {object|Function|null} [options.credentials] - the `ctx.credentials`
 *   service, a resolver, or `null` (resolved on EVERY use, like `api-key-store`).
 * @returns {{save, forget, resolve, isExpired, state}}
 */
export function createAgnescodeStore({ credentials = null } = {}) {
  /** Fallback vault for a Host that has no credentials service. */
  const memory = new Map();

  const resolveService = () => {
    const value = typeof credentials === "function" ? credentials() : credentials;
    return value ?? null;
  };

  const storeNow = async (credential) => {
    const serialized = serializeAgnescodeCredential(credential);
    const service = resolveService();
    if (service !== null && typeof service.set === "function") {
      await service.set(AGNESCODE_CREDENTIAL_REF, serialized);
    }
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
      await storeNow({ ...credential, bffBase });
    },

    /** Forget the stored credential (the panel's「解除关联」). */
    async forget() {
      memory.delete(AGNESCODE_CREDENTIAL_REF);
      try {
        const service = resolveService();
        if (service !== null && typeof service.unset === "function") {
          await service.unset(AGNESCODE_CREDENTIAL_REF);
        }
      } catch {
        // The in-memory copy is already gone; nothing else to do.
      }
    },

    /**
     * Resolve the live credential and where it came from.
     * @returns {Promise<{credential: object|null, source: ("credentials"|"memory"|null)}>}
     */
    async resolve() {
      try {
        const service = resolveService();
        if (service !== null && typeof service.resolve === "function") {
          const resolved = await service.resolve(AGNESCODE_CREDENTIAL_REF).catch(() => undefined);
          const credential = parseAgnescodeCredential(resolved?.value);
          if (credential !== null) return { credential, source: "credentials" };
        }
      } catch {
        // No usable answer from the service: fall through to memory.
      }
      const held = parseAgnescodeCredential(memory.get(AGNESCODE_CREDENTIAL_REF));
      if (held !== null) return { credential: held, source: "memory" };
      return { credential: null, source: null };
    },

    /**
     * Whether the stored credential is within its expiry window. A credential
     * without a decodable `exp` reads as unexpired (it may still be dead
     * server-side; the request path surfaces that) — the same direction
     * the sibling upstream store takes.
     * @param {number} [leadMs] - renew this long before expiry; defaults to 5 min.
     */
    async isExpired(leadMs = 5 * 60 * 1000) {
      const { credential } = await this.resolve();
      if (credential === null) return true;
      if (credential.expiresAtMs === undefined) return false;
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
