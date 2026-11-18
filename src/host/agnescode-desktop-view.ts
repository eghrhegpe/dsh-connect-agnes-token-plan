/**
 * The desktop App's AgnesCode login state as a READ-ONLY VIEW (ADR-020, the
 * raccoon §6.1.11 mirror for this plugin's harvest line).
 *
 * What this is: a per-read answer to "is the desktop session file usable
 * RIGHT NOW" — a fresh walk of `harvestAgnescodeLocalSession` under a
 * stat-keyed success cache, a single-flight gate, and a failure backoff. The
 * answer is one of two shapes and nothing else:
 *
 *   - `{ ok: true, credential }`  — the file decrypted, the base is pinned to
 *     the Agnes origin family, the JWT still carries more life than the lead
 *     window. The credential is a VIEW: the caller (the store) serves it and
 *     never writes it into the credentials service;
 *   - `{ ok: false, reason }`     — a CLOSED-SET, secret-free fact (a harvest
 *     tier, `no_expiry`, `expired`, or `read_failed`). A reason names a
 *     CATEGORY, never a path, a size, a parse excerpt, or anything derived
 *     from a token — the strings reach the panel route and, through it, the
 *     browser.
 *
 * What this deliberately is NOT (the raccoon wording, restated for this file):
 *   - **not a refresh client.** This module imports no fetcher, so it
 *     structurally cannot rotate the App's token. The App owns its own
 *     session; reading it never spends a renewal.
 *   - **not a second credential store.** The App's file is the owner of
 *     record and stays the authority; a copy here would go stale the moment
 *     the App rotates, and a stale copy of somebody else's login is worse
 *     than a re-read. The view therefore caches ONLY its own parse of the
 *     file's current bytes, keyed on the file's stat — and the cache entry
 *     dies with the process, not with the App.
 *
 * WHY THE READS ARE BOUNDED (the cost that raccoon never had): raccoon's
 * source is a plain JSON file; this one is Chromium os_crypt, and a cache
 * MISS runs the whole harvest walk, whose happy path ends in a PowerShell
 * DPAPI child. A per-request storm of misses is the price of serving a view
 * on the adapter's hot path, so the three guards in this module are the
 * load-bearing part:
 *
 *   1. the stat-keyed cache — the walk's WINNER file plus its sibling
 *      `Local State`, by (mtime, size) each; while both are unchanged AND the
 *      walk's deterministic winner is unchanged (re-listed, re-classified,
 *      re-sorted through the walk's own `sortAgnescodeSessionFiles`), the
 *      cached parse is served WITHOUT re-decrypting and WITHOUT spawning;
 *   2. the single-flight — concurrent readers share one in-progress walk;
 *   3. the failure backoff — a walk that found nothing usable buys
 *      `AGNESCODE_DESKTOP_VIEW_BACKOFF_MS` of quiet, during which reads
 *      answer the last reason without touching the filesystem at all.
 *      (Same number as the lifecycle re-harvest backoff, a different owner:
 *      the lifecycle's walk saves into the slot, this one never does.)
 *
 * Failures are deliberately NOT cached: a rename in flight (the App rotating
 * its file) must not stick for a TTL; the next read after the backoff
 * window re-walks for real.
 *
 * The lead window is the STORE's renewal boundary (`isExpired`'s 5-minute
 * default), NOT raccoon's 60 s: a view token that the store still counts as
 * "renew now" must refuse to serve, or the re-harvest storm runs in the
 * overlap of two different windows. One boundary, one renewal trigger.
 *
 * Peer-free: imports only internal modules and node builtins.
 *
 * @module dsh-connect-agnes-token-plan/agnescode-desktop-view
 */

import { stat as fsStat } from "node:fs/promises";
import {
  harvestAgnescodeLocalSession,
  defaultDpapiUnprotect,
  decodeAgnescodeJwtExpMs,
  resolveAgnescodeAppDirs,
  classifyAgnescodeSessionFiles,
  sortAgnescodeSessionFiles,
  AGNESCODE_HARVEST_TIER
} from "./agnescode.ts";

/**
 * How much life a view token must still carry to be served. Set to the
 * store's `isExpired` default lead (5 minutes) on purpose — see the module
 * header for why the two windows must be one.
 */
export const AGNESCODE_DESKTOP_LEAD_MS = 5 * 60_000;

/** How long a failed view read (a walk that found nothing usable) stays quiet. */
export const AGNESCODE_DESKTOP_VIEW_BACKOFF_MS = 60_000;

/**
 * Why the desktop file is not a usable credential right now.
 *
 * Secret-free by construction (see the module header). The first nine are the
 * harvest tiers verbatim — a read that walked and found X reports the SAME
 * tier the panel's harvest diagnosis prints, so "the button says X and the
 * switch row says Y" is impossible by construction; the last three are
 * facts only the VIEW can answer (a walk that SUCCEEDED but cannot serve).
 */
export const AGNESCODE_DESKTOP_REASON = Object.freeze({
  /** No such file: the App was never installed, or never logged in. */
  FILE_MISSING: AGNESCODE_HARVEST_TIER.FILE_MISSING,
  /** Present but unreadable: permissions, or a rename in flight. */
  UNREADABLE: AGNESCODE_HARVEST_TIER.UNREADABLE,
  /** An unrecognized session-family file: the App changed its storage shape. */
  FORMAT_DRIFT: AGNESCODE_HARVEST_TIER.FORMAT_DRIFT,
  /** The sibling `Local State` is absent or carries no usable key. */
  NO_KEY: AGNESCODE_HARVEST_TIER.NO_KEY,
  /** The os_crypt blob will not decrypt with the key. */
  DECRYPT_FAILED: AGNESCODE_HARVEST_TIER.DECRYPT_FAILED,
  /** The decrypted bytes are not JSON. */
  MALFORMED: AGNESCODE_HARVEST_TIER.MALFORMED,
  /** JSON parsed, but it carries no usable `accessToken`. */
  NO_TOKEN: AGNESCODE_HARVEST_TIER.NO_TOKEN,
  /** The session's `bffPublicBaseUrl` is not a pinned Agnes base. */
  UNTRUSTED_BASE: AGNESCODE_HARVEST_TIER.UNTRUSTED_BASE,
  /** The platform has no verified harvest path (non-win32, or no app dir). */
  UNSUPPORTED_PLATFORM: AGNESCODE_HARVEST_TIER.UNSUPPORTED_PLATFORM,
  /** A walk that decrypted a session carrying no decodable JWT `exp`. */
  NO_EXPIRY: "no_expiry",
  /** Inside the lead window of (or past) its own `exp`. */
  EXPIRED: "expired",
  /** The walk itself threw (a production walk does not; an injected one can). */
  READ_FAILED: "read_failed"
});

/** The union of {@link AGNESCODE_DESKTOP_REASON} values. */
export type AgnescodeDesktopReasonValue = typeof AGNESCODE_DESKTOP_REASON[keyof typeof AGNESCODE_DESKTOP_REASON];

/** A secret-free reason, or `null` on the success shape. */
type AgnescodeDesktopReadOk = {
  ok: true;
  credential: { accessToken: string; userId: string; nickname: string; bffBase: string; expiresAtMs: number };
  reason: null;
};
type AgnescodeDesktopReadIdle = { ok: false; credential: null; reason: AgnescodeDesktopReasonValue };
/** The shape every view read answers, in both halves. */
export type AgnescodeDesktopViewRead = AgnescodeDesktopReadOk | AgnescodeDesktopReadIdle;

/** One parsed, trusted session document (the walk's `session`, plus its exp). */
type CachedSession = {
  accessToken: string;
  userId: string;
  nickname: string;
  bffBase: string;
  expiresAtMs: number | undefined;
};

/**
 * The options a view reader is built with. Every one of the walk's own
 * injection seams is re-exposed, plus the reader's own state knobs, so an
 * offline suite can sit the whole module on a fake clock and a fake disk.
 * The `walk` seam replaces the walk function ITSELF (the production default
 * is `harvestAgnescodeLocalSession`): a test that counts walks — or proves a
 * seam throws — must count the walk, not its internal reads (a walk that
 * fails at the directory listing never reads a file).
 * @param {object} [options]
 * @param {object} [options.env] - the process env (defaults to real).
 * @param {string} [options.platform] - `process.platform` (defaults to real).
 * @param {(path: string) => Promise<Buffer>} [options.readFile] - injected reader.
 * @param {(path: string) => Promise<string[]>} [options.readDir] - injected lister.
 * @param {(wrapped: Buffer) => Promise<Buffer>} [options.dpapiUnprotect] - injected DPAPI.
 * @param {(path: string) => Promise<{mtimeMs: number, size: number}>} [options.stat] - injected stat.
 * @param {Function} [options.walk] - the harvest walk (defaults to the real one).
 * @param {() => number} [options.now] - the clock.
 * @param {number} [options.leadMs] - the freshness margin.
 * @param {number} [options.backoffMs] - the failure quiet window.
 * @returns {object} the reader, with its one `read()` answer.
 */
export function createAgnescodeDesktopViewReader(options: {
  env?: Record<string, string | undefined>;
  platform?: string;
  readFile?: (path: string) => Promise<Buffer>;
  readDir?: (path: string) => Promise<string[]>;
  dpapiUnprotect?: (wrapped: Buffer) => Promise<Buffer>;
  stat?: (path: string) => Promise<{ mtimeMs: number; size: number }>;
  walk?: typeof harvestAgnescodeLocalSession;
  now?: () => number;
  leadMs?: number;
  backoffMs?: number;
} = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const readFile = options.readFile ?? (async (path: string) => (await import("node:fs/promises")).readFile(path));
  const readDir = options.readDir ?? (async (path: string) => (await import("node:fs/promises")).readdir(path));
  const dpapiUnprotect = options.dpapiUnprotect ?? defaultDpapiUnprotect;
  const statImpl = options.stat ?? fsStat;
  const walk = options.walk ?? harvestAgnescodeLocalSession;
  const now = options.now ?? Date.now;
  const leadMs = options.leadMs ?? AGNESCODE_DESKTOP_LEAD_MS;
  const backoffMs = options.backoffMs ?? AGNESCODE_DESKTOP_VIEW_BACKOFF_MS;

  /** The single-flight + backoff + cache state, for the reader's lifetime. */
  let inFlight: AgnescodeDesktopViewFlight | null = null;
  let blockedUntil = 0;
  let lastReason: AgnescodeDesktopReasonValue = AGNESCODE_DESKTOP_REASON.READ_FAILED;
  /** The stat-keyed success cache: ONE entry (a second would be a second answer). */
  let cached: { winnerFile: string; key: string; session: CachedSession } | null = null;

  /**
   * The walk's deterministic winner in one app directory, WITHOUT walking:
   * list, classify, sort through the walk's own sorter. `null` when the
   * directory cannot be listed (the walk will find that out for itself).
   * @returns {Promise<string|null>} the winning file path, or `null`.
   */
  const currentWinner = async (): Promise<string | null> => {
    const appDirs = resolveAgnescodeAppDirs(env, platform);
    if (appDirs.length === 0) return null;
    const appDir = appDirs[0];
    if (appDir === undefined || appDir === null) return null;
    let names: string[];
    try {
      names = await readDir(appDir);
    } catch {
      return null; // an absent directory is a walk fact, not a cache fact
    }
    const matched = sortAgnescodeSessionFiles(classifyAgnescodeSessionFiles(names).matched.slice());
    if (matched.length === 0) return null;
    return `${appDir}/${matched[0]}`;
  };

  /** The stat signature of one winner + its sibling `Local State`, or `null`. */
  const pairKey = async (winnerFile: string): Promise<string | null> => {
    const separator = winnerFile.lastIndexOf("/");
    const sibling = separator >= 0 ? `${winnerFile.slice(0, separator)}/Local State` : "Local State";
    let sessionInfo: { mtimeMs: number; size: number };
    let localInfo: { mtimeMs: number; size: number };
    try {
      sessionInfo = await statImpl(winnerFile);
    } catch {
      return null;
    }
    try {
      localInfo = await statImpl(sibling);
    } catch {
      return null; // the walk would report NO_KEY; a key-less cache is no cache
    }
    return `${winnerFile}|${String(sessionInfo.mtimeMs)}|${String(sessionInfo.size)}|${String(localInfo.mtimeMs)}|${String(localInfo.size)}`;
  };

  /**
   * The cached parse, still valid only if the walk's winner is unchanged AND
   * both stats are unchanged — everything the walk would re-read, read
   * differently. Anything else is a miss.
   * @returns {Promise<CachedSession|null>}
   */
  const cacheHit = async (): Promise<CachedSession | null> => {
    if (cached === null) return null;
    const winner = await currentWinner();
    if (winner === null || winner !== cached.winnerFile) return null;
    const key = await pairKey(winner);
    if (key === null || key !== cached.key) return null;
    return cached.session;
  };

  /**
   * The walk's failure rows onto the reason set: the FIRST row is the
   * dominant fact (the walk stops at the first usable file, so a walk that
   * failed everywhere is a walk whose first row failed everywhere).
   * @param {object} walk - a failed `harvestAgnescodeLocalSession` result.
   * @returns {AgnescodeDesktopReasonValue} the reason.
   */
  const reasonFromWalk = (walk: { attempts: Array<{ file: string | null; tier: string; detail: string }> }): AgnescodeDesktopReasonValue => {
    const tier = walk.attempts[0]?.tier;
    switch (tier) {
      case AGNESCODE_HARVEST_TIER.FILE_MISSING: return AGNESCODE_DESKTOP_REASON.FILE_MISSING;
      case AGNESCODE_HARVEST_TIER.UNREADABLE: return AGNESCODE_DESKTOP_REASON.UNREADABLE;
      case AGNESCODE_HARVEST_TIER.FORMAT_DRIFT: return AGNESCODE_DESKTOP_REASON.FORMAT_DRIFT;
      case AGNESCODE_HARVEST_TIER.NO_KEY: return AGNESCODE_DESKTOP_REASON.NO_KEY;
      case AGNESCODE_HARVEST_TIER.DECRYPT_FAILED: return AGNESCODE_DESKTOP_REASON.DECRYPT_FAILED;
      case AGNESCODE_HARVEST_TIER.MALFORMED: return AGNESCODE_DESKTOP_REASON.MALFORMED;
      case AGNESCODE_HARVEST_TIER.NO_TOKEN: return AGNESCODE_DESKTOP_REASON.NO_TOKEN;
      case AGNESCODE_HARVEST_TIER.UNTRUSTED_BASE: return AGNESCODE_DESKTOP_REASON.UNTRUSTED_BASE;
      case AGNESCODE_HARVEST_TIER.UNSUPPORTED_PLATFORM: return AGNESCODE_DESKTOP_REASON.UNSUPPORTED_PLATFORM;
      default: return AGNESCODE_DESKTOP_REASON.READ_FAILED;
    }
  };

  /**
   * Run one walk and settle it: success caches (stat-keyed) and checks the
   * lead window; failure buys the backoff and clears the cache. Never throws
   * into the caller — a walk that THROWS (an injected seam) is `read_failed`
   * through the same backoff.
   * @returns {Promise<AgnescodeDesktopViewRead>}
   */
  const runWalk = async (): Promise<AgnescodeDesktopViewRead> => {
    let result: Awaited<ReturnType<typeof harvestAgnescodeLocalSession>>;
    try {
      result = await walk({ env, platform, readFile, readDir, dpapiUnprotect });
    } catch {
      blockedUntil = now() + backoffMs;
      lastReason = AGNESCODE_DESKTOP_REASON.READ_FAILED;
      cached = null;
      return { ok: false, credential: null, reason: lastReason };
    }
    // Named `result`, not `walk`: a `const walk` here would shadow the
    // factory's walk binding across the WHOLE function body (the TDZ reaches
    // back into the try above), and the walk call itself would throw a
    // ReferenceError on its very first use.
    if (result.ok !== true) {
      blockedUntil = now() + backoffMs;
      lastReason = reasonFromWalk(result);
      cached = null; // a walk that failed everywhere cannot back a warm cache
      return { ok: false, credential: null, reason: lastReason };
    }
    const session = result.session;
    const expiresAtMs = decodeAgnescodeJwtExpMs(session.accessToken);
    // Cache the parse even when the lead window refuses it: the stat key is
    // what keeps the NEXT read from re-decrypting, and the expiry check
    // below runs on every read — an `expired` answer costs no walk.
    const winnerRow = result.attempts.find((row) => row.tier === AGNESCODE_HARVEST_TIER.OK);
    if (winnerRow !== undefined && winnerRow.file !== null) {
      const key = await pairKey(winnerRow.file);
      if (key !== null) cached = { winnerFile: winnerRow.file, key, session: { ...session, expiresAtMs } };
    }
    blockedUntil = 0;
    lastReason = AGNESCODE_DESKTOP_REASON.READ_FAILED;
    if (expiresAtMs === undefined) {
      return { ok: false, credential: null, reason: AGNESCODE_DESKTOP_REASON.NO_EXPIRY };
    }
    if (now() >= expiresAtMs - leadMs) {
      return { ok: false, credential: null, reason: AGNESCODE_DESKTOP_REASON.EXPIRED };
    }
    return {
      ok: true,
      credential: {
        accessToken: session.accessToken,
        userId: session.userId,
        nickname: session.nickname,
        bffBase: session.bffBase,
        expiresAtMs
      },
      reason: null
    };
  };

  return {
    /**
     * One read of the desktop source. See the module header for the guards;
     * the order is load-bearing — the single-flight joins BEFORE the backoff
     * gate (a walk in flight IS the answer), and the backoff gate sits
     * BEFORE the cache (a quiet window must not re-walk either).
     * @returns {Promise<AgnescodeDesktopViewRead>}
     */
    async read(): Promise<AgnescodeDesktopViewRead> {
      // The platform gate runs BEFORE every other fact: non-win32 has no
      // verified walk, and answering it from the backoff cache would print a
      // stale "file_missing" on a platform that cannot even ask.
      if (platform !== "win32") {
        return { ok: false, credential: null, reason: AGNESCODE_DESKTOP_REASON.UNSUPPORTED_PLATFORM };
      }
      if (inFlight !== null) return inFlight;
      if (now() < blockedUntil) {
        return { ok: false, credential: null, reason: lastReason };
      }
      // The assignment is load-bearing: it happens in the SYNCHRONOUS prefix
      // of this call (the IIFE runs to its first await before the line below
      // executes), so a reader arriving a microtask later joins THIS flight
      // instead of opening a second walk. The cache check lives INSIDE the
      // flight — a cache hit settles it in one listing + two stats, and the
      // `.finally` clears the slot for either outcome.
      inFlight = (async (): Promise<AgnescodeDesktopViewRead> => {
        const hit = await cacheHit();
        if (hit !== null) {
          // The cached parse's OWN expiry, checked live on every read: a
          // cache entry outlives its token's lead window, never the App.
          if (hit.expiresAtMs === undefined) {
            return { ok: false, credential: null, reason: AGNESCODE_DESKTOP_REASON.NO_EXPIRY };
          }
          if (now() >= hit.expiresAtMs - leadMs) {
            return { ok: false, credential: null, reason: AGNESCODE_DESKTOP_REASON.EXPIRED };
          }
          return {
            ok: true,
            credential: {
              accessToken: hit.accessToken,
              userId: hit.userId,
              nickname: hit.nickname,
              bffBase: hit.bffBase,
              expiresAtMs: hit.expiresAtMs
            },
            reason: null
          };
        }
        return runWalk();
      })().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    /**
     * Drop the cache and the backoff state (an out-of-band App edit, or a
     * test). The next read walks for real.
     */
    forget() {
      cached = null;
      blockedUntil = 0;
      inFlight = null;
    }
  };
}

/** One reader instance, as wired into the store's dependency bag. */
export type AgnescodeDesktopViewReader = ReturnType<typeof createAgnescodeDesktopViewReader>;

/**
 * The promise shape the in-flight slot holds: the read's answer, settled
 * through `.finally` (which reports its callback's void return but resolves
 * with the original value). Annotating the IIFE with this — instead of
 * letting it infer — is what keeps the `ok: true` literal from widening to
 * `boolean` across the flight's union of branches.
 */
export type AgnescodeDesktopViewFlight = Promise<AgnescodeDesktopViewRead>;
