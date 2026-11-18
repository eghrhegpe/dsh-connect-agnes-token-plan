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
 * TWO SOURCES, ONE SLOT (ADR-020, the raccoon §6.1.11 mirror). `resolve()`
 * answers the same question from two origins, and the distinction is
 * load-bearing:
 *
 *   - `desktop-file` — a READ-ONLY VIEW of the desktop App's own session file
 *     (`agnescode-desktop-view.ts`, behind the opt-in desktop-source switch,
 *     default OFF). The App owns that file; this store never refreshes it,
 *     never `save()`s it, and never copies it into the credentials service —
 *     a switched-on, fresh view serves straight through `resolve()`, and
 *     anything else (switch off, file missing, expired) falls through to the
 *     stored slot untouched, so turning the source off never costs a login
 *     and a working stored credential is never destroyed;
 *   - `credentials` / `memory` — the slot this store OWNS: what the panel's
 *     harvest and scan-to-sign-in paths `save()`d. Refreshable only by
 *     re-harvest (there is no refresh endpoint), per the paragraph above.
 *
 * Precedence is PER READ, not a mode the user switches between: the switch
 * decides whether the desktop source PARTICIPATES in the read; it does not
 * own the slot.
 *
 * Within OUR OWN slot, precedence per read is the credentials service, then
 * this process's memory (a Host with no credentials service). A `null`
 * credentials service leaves the credential in-memory only, so it is
 * `ephemeral` (mirrors token-store).
 *
 * @module dsh-connect-agnes-token-plan/agnescode-store
 */

import { obj, str, verbatim } from "./util.ts";
import { decodeAgnescodeJwtExpMs, trustAgnescodeBffBase } from "./agnescode.ts";
import { AGNESCODE_DESKTOP_REASON, type AgnescodeDesktopViewRead } from "./agnescode-desktop-view.ts";
import { readPanelValue, resolveSwitchEnabled } from "./switch-precedence.ts";

/** The reference name the credential is stored under. */
export const AGNESCODE_CREDENTIAL_REF = "AGNESCODE_CREDENTIAL";

/**
 * Parse the stored credential JSON; a malformed or absent value reads as no
 * credential rather than an error — the safe direction (one re-harvest, never
 * a crash).
 * @param {unknown} value - the reference value.
 * @returns {object|null} `{ accessToken, bffBase, userId, nickname, expiresAtMs? }` or `null`.
 */
export function parseAgnescodeCredential(value: unknown) {
  if (typeof value !== "string" || value.trim() === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const source = obj(parsed);
  // Verbatim end to end: the token was captured from the desktop app's own
  // session file and is replayed to the upstream unchanged, so a trim here
  // would alter a credential between two places that never see each other.
  const accessToken = verbatim(source.access_token, "");
  const bffBase = trustAgnescodeBffBase(source.bff_public_base_url);
  if (accessToken.trim() === "" || bffBase === null) return null;
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
export function serializeAgnescodeCredential(credential: Record<string, unknown>) {
  const source = obj(credential);
  return JSON.stringify({
    version: 1,
    access_token: verbatim(source.accessToken, ""),
    bff_public_base_url: str(source.bffBase, ""),
    ...(str(source.userId, "") !== "" ? { user_id: source.userId } : {}),
    ...(str(source.nickname, "") !== "" ? { nickname: source.nickname } : {}),
    ...(typeof source.expiresAtMs === "number" ? { expires_at_ms: source.expiresAtMs } : {})
  });
}

/**
 * The panel-facing source facts of the desktop source (ADR-020): is the
 * switch ON, is the view SERVING the read, and when on-but-idle WHY (the
 * view's closed reason set, never a path or a shape excerpt). The route
 * prints these as three FLAT keys (`desktopSourceEnabled` /
 * `desktopSourceServing` / `desktopSourceReason` — the §11b fence walks the
 * GET literal by brace depth, so no nested block).
 */
export interface AgnescodeDesktopSourceState {
  enabled: boolean;
  serving: boolean;
  reason: string | null;
}

/**
 * Build the credential store.
 * @param {object} [options] - wiring.
 * @param {object|Function|null} [options.credentials] - the `ctx.credentials`
 *   service, a resolver, or `null` (resolved on EVERY use, like `api-key-store`).
 * @param {object|null} [options.desktopSource] - the read-only desktop-source
 *   view (ADR-020): `enabled()` is the panel switch's saved value (`null` =
 *   unset) and `read()` one read of the App's session file. Absent or `null`
 *   keeps the pre-ADR-020 behaviour byte for byte (the slot only answers
 *   `resolve()`), which is what a Host that predates the switch ships.
 * @returns {{save, forget, resolve, isExpired, state}}
 */
export function createAgnescodeStore({
  credentials = null,
  desktopSource = null
}: {
  credentials?: (() => any) | null;
  desktopSource?: {
    enabled: () => Promise<boolean | null>;
    read: () => Promise<AgnescodeDesktopViewRead>;
  } | null;
} = {}) {
  /** Fallback vault for a Host that has no credentials service. */
  const memory = new Map();
  /**
   * The desktop source's last answer when the switch is ON but the view is
   * idle (ADR-020): `state()` prints it, the slot never does. Set inside
   * `resolve()` — the only place both sources are consulted — and read by
   * `state()` on the same tick.
   */
  let desktopIdleReason: string | null = null;

  const resolveService = () => {
    const value = typeof credentials === "function" ? credentials() : credentials;
    return value ?? null;
  };

  const storeNow = async (credential: Record<string, unknown>) => {
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
    async save(credential: Record<string, unknown>) {
      const accessToken = verbatim(credential?.accessToken, "");
      const bffBase = trustAgnescodeBffBase(credential?.bffBase);
      if (accessToken.trim() === "") throw new Error("an AgnesCode access token is required");
      if (bffBase === null) throw new Error("an AgnesCode BFF base is required");
      await storeNow({ ...credential, bffBase });
    },

    /** Forget the stored credential. A store-level primitive (the shared
     * `CredentialStore` contract), not a panel action — the「解除关联」button
     * that used to call it was removed, but the primitive stays because it is
     * part of the interface every store implements and the tests call it. */
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
     * Resolve the live credential and where it came from — the TWO-SOURCES-
     * ONE-SLOT arbitration (ADR-020, module header): a switched-on, fresh
     * desktop view wins the read; EVERYTHING else falls through to the slot
     * untouched. The view's credential is answered as a VIEW: nothing in this
     * method writes it into the credentials service, and the slot's own
     * contents are what the `credentials` / `memory` answers describe.
     * @returns {Promise<{credential: object|null, source: ("desktop-file"|"credentials"|"memory"|null), desktopIdleReason?: string|null}>}
     */
    async resolve() {
      // The desktop source consults FIRST, and only when its switch resolves
      // ON (dialect B: a panel-unset value is OFF, never a declared default).
      // An idle view leaves `desktopIdleReason` set for `state()` and falls
      // through — the slot still answers, so the source switch can never
      // empty the credential slot.
      if (desktopSource !== null) {
        const on = resolveSwitchEnabled(await readPanelValue(desktopSource.enabled)).enabled;
        if (on) {
          const view = await desktopSource.read().catch(
            () => ({ ok: false, credential: null, reason: AGNESCODE_DESKTOP_REASON.READ_FAILED } as const)
          );
          if (view.ok === true) {
            desktopIdleReason = null;
            return {
              credential: {
                accessToken: view.credential.accessToken,
                userId: view.credential.userId,
                nickname: view.credential.nickname,
                bffBase: view.credential.bffBase,
                expiresAtMs: view.credential.expiresAtMs
              },
              source: "desktop-file",
              desktopIdleReason: null
            };
          }
          desktopIdleReason = view.reason;
        } else {
          desktopIdleReason = null;
        }
      } else {
        desktopIdleReason = null;
      }
      try {
        const service = resolveService();
        if (service !== null && typeof service.resolve === "function") {
          const resolved = await service.resolve(AGNESCODE_CREDENTIAL_REF).catch(() => undefined);
          const credential = parseAgnescodeCredential(resolved?.value);
          if (credential !== null) return { credential, source: "credentials", desktopIdleReason };
        }
      } catch {
        // No usable answer from the service: fall through to memory.
      }
      const held = parseAgnescodeCredential(memory.get(AGNESCODE_CREDENTIAL_REF));
      if (held !== null) return { credential: held, source: "memory", desktopIdleReason };
      return { credential: null, source: null, desktopIdleReason };
    },

    /**
     * Whether the STORED credential is within its expiry window. A credential
     * without a decodable `exp` reads as unexpired (it may still be dead
     * server-side; the request path surfaces that) — the same direction
     * the sibling upstream store takes.
     *
     * ADR-020: `resolve()` now answers from whichever source is in charge,
     * so this follows the VIEW when it serves — the intended coupling: the
     * view's lead window is the same 5-minute boundary as this default,
     * which is what keeps "the view says serve" and "the store says renew"
     * from disagreeing in their overlap.
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
     *
     * `expired` is computed HERE rather than in the panel: the Host owns the
     * credential and its clock, and the one thing this tab must never do is
     * print a date in the past as if it were a valid-until. It is a separate
     * field from `expiresAtMs` because they answer different questions — "when
     * does it die" vs "is it dead" — and a client that had to derive the second
     * from the first would be re-implementing the expiry rule (lead window
     * included) in a second place.
     *
     * The `desktopSource` block (ADR-020) answers the source switch's three
     * questions the panel prints: is the switch ON, is the view SERVING,
     * and when on-but-idle WHY (the view's closed reason set, never a path
     * or a shape excerpt). `null` when the reader was never wired — an older
     * Host of this store — so the panel hides the row rather than guesses.
     * @returns {Promise<{hasCredential: boolean, source: ("desktop-file"|"credentials"|"memory"|null), ephemeral: boolean, nickname: string, bffBase: string, expiresAtMs: number|null, expired: boolean, desktopSource: object|null}>}
     */
    async state() {
      const { credential, source, desktopIdleReason: idleReason } = await this.resolve();
      let desktopSourceState: AgnescodeDesktopSourceState | null = null;
      if (desktopSource !== null) {
        const enabled = resolveSwitchEnabled(await readPanelValue(desktopSource.enabled)).enabled;
        desktopSourceState = {
          enabled,
          serving: source === "desktop-file",
          reason: source === "desktop-file" || enabled === false
            ? null
            : (idleReason ?? AGNESCODE_DESKTOP_REASON.READ_FAILED)
        };
      }
      return {
        hasCredential: credential !== null,
        source,
        ephemeral: resolveService() === null,
        nickname: credential?.nickname ?? "",
        bffBase: credential?.bffBase ?? "",
        expiresAtMs: credential?.expiresAtMs ?? null,
        // No lead window: "expired" here is a fact to display, not the
        // re-harvest trigger (`isExpired` keeps its 5-minute lead for that).
        expired:
          credential !== null &&
          credential.expiresAtMs !== undefined &&
          Date.now() >= credential.expiresAtMs,
        desktopSource: desktopSourceState
      };
    }
  };
}
