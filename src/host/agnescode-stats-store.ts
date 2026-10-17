/**
 * dsh-connect-agnes-token-plan — where the AgnesCode rate-limit record lives.
 *
 * WHY this exists, and why it is NOT in `agnescode-store.ts`: that store is a
 * credential store — a harvested JWT and nothing else, and the two halves must
 * not be coupled, because a stats file nobody can parse must never take a
 * credential with it. A rate-limit record is STATE, not a credential: a tally
 * of how often the platform's invisible rate cap actually bit. It belongs in
 * this plugin's own state file, where a malformed value costs the plugin one
 * counter and nothing else.
 *
 * WHAT it records, and what it does NOT:
 *   - It records the plugin's OWN requests only — the finish chunks the
 *     AgnesCode route classified as `RATE_LIMIT`. It cannot see the desktop
 *     App's requests. That is a feature, not a gap: the user's question was
 *     "will MY plugin requests get rate-limited", and an aggregate that mixed
 *     in the desktop App's traffic would be a number nobody could read.
 *   - It records the SYMPTOM, not the threshold. AgnesCode's RPM ceiling is
 *     unpublished and untested (ROADMAP §6.3 — deliberately not probed as a
 *     by-request-volume availability test). The panel therefore never prints a
 *     specific "N requests/minute", only "you hit the cap N times today". A
 *     counter is an observation; a number the plugin invented would be a claim.
 *   - It deliberately does NOT store token counts or request rounds. Those
 *     would only cover the plugin's own calls, understate the real account
 *     spend by omitting the desktop App, and read as a healthy-looking number
 *     the user might act on. The account's actual spend is the credit pool.
 *
 * @module dsh-connect-agnes-token-plan/agnescode-stats-store
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ensureStateDir, temporaryOf, writeStateFile, readStateJson, stateDir as pluginStateDir } from "./state-store.ts";
import { name } from "./host-config.ts";

/** Shape version, bumped when the persisted form changes. */
const STATS_VERSION = 1;

/**
 * How many trailing days the store keeps — the "近 30 天" window the panel
 * prints. Pruning happens on read and on write, so the file never grows past
 * the window even when nothing reads it for a long time.
 */
const WINDOW_DAYS = 30;

/** A day key is a LOCAL date, `YYYY-MM-DD`. */
function dayKeyOf(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Local midnight of a date, as epoch ms — the bucket boundary a "day" means. */
function epochDayMsOf(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * What the panel may read out of the store: two windowed counts and the time
 * of the last hit. Flat scalars only — the daily breakdown stays Host-side, so
 * the wire never carries anything shaped like per-day history.
 * @typedef {object} AgnescodeStatsSnapshot
 * @property {number} today - rate-limit hits on the local day of `now`.
 * @property {number} last30d - hits across the trailing {@link WINDOW_DAYS} window.
 * @property {number|null} lastAt - epoch ms of the most recent hit, `null` when never.
 */

/**
 * Bring a persisted payload to {@link STATS_VERSION}, or `null` when the shape
 * is foreign (unrecognised version). Pruning is done separately by `prune`,
 * which needs the clock.
 * @param {unknown} raw - the parsed file contents.
 * @returns {{byDay: Record<string, number>, lastAt: number|null}|null}
 */
function parse(raw: unknown) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as { version?: unknown; rateLimit?: unknown };
  const version = Number(body.version);
  if (!Number.isFinite(version) || version !== STATS_VERSION) return null;
  const section = (body.rateLimit ?? null) as { byDay?: unknown; lastAt?: unknown } | null;
  if (section === null || typeof section !== "object" || Array.isArray(section)) {
    return { byDay: {}, lastAt: null };
  }
  const byDay: Record<string, number> = {};
  if (section.byDay !== null && typeof section.byDay === "object" && !Array.isArray(section.byDay)) {
    for (const [key, value] of Object.entries(section.byDay as Record<string, unknown>)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
      if (typeof key !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      byDay[key] = Math.floor(value);
    }
  }
  const lastAtRaw = section.lastAt;
  const lastAt = typeof lastAtRaw === "number" && Number.isFinite(lastAtRaw) ? Math.floor(lastAtRaw) : null;
  return { byDay, lastAt };
}

/**
 * Drop daily buckets older than {@link WINDOW_DAYS}. Mutates a copy and returns
 * it, so a parsed map that outlived its window never reports stale hits.
 * @param {Record<string, number>} byDay - keyed by local `YYYY-MM-DD`.
 * @param {() => number} now - clock source.
 * @returns {Record<string, number>} the pruned map.
 */
function prune(byDay: Record<string, number>, now: () => number) {
  const floor = epochDayMsOf(new Date(now())) - WINDOW_DAYS * 86_400_000;
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(byDay)) {
    const at = new Date(`${key}T00:00:00`).getTime();
    if (Number.isFinite(at) && at >= floor) out[key] = count;
  }
  return out;
}

/**
 * Where the record lives: the SHARED directory, `$DSH_HOME/state/<plugin>`.
 *
 * Deliberately NOT per-profile. A rate-limit record is a fact about this
 * machine's traffic against the account, not a per-profile preference — and a
 * profile that just got its Host restarted should still see the hits the other
 * profile logged minutes ago. Same reasoning as `throttle-store.ts`, applied to
 * an observation instead of a deadline.
 * @returns {string} the directory.
 */
export function agnescodeStatsDir() {
  return pluginStateDir(name);
}

/**
 * A stats store backed by one file.
 *
 * Writes are atomic — a temporary file, then a rename — because two Host
 * processes share this path and a half-written file must not read as "no hits"
 * (that would quietly lose the very evidence the panel exists to show).
 * @param {object} [options] - wiring.
 * @param {string} [options.dir] - directory; defaults to {@link agnescodeStatsDir}.
 * @param {() => number} [options.now] - clock source; injected by the tests.
 * @returns {{recordRateLimit: Function, read: Function, clear: Function}} the store.
 */
export function createFileAgnescodeStatsStore({ dir = agnescodeStatsDir(), now = Date.now } = {}) {
  const file = join(dir, "agnescode-stats.json");

  return {
    /**
     * Record one rate-limit hit at `at` (a Date; defaults to `now`).
     * @param {Date} [at] - when the hit happened.
     * @returns {Promise<boolean>} whether the record reached the disk.
     */
    async recordRateLimit(at: Date = new Date(now())) {
      const key = dayKeyOf(at);
      try {
        const parsed = parse(await readStateJson(file)) ?? { byDay: {}, lastAt: null };
        const byDay = prune(parsed.byDay, now);
        byDay[key] = (byDay[key] ?? 0) + 1;
        const body = JSON.stringify({
          version: STATS_VERSION,
          rateLimit: { byDay, lastAt: at.getTime() }
        });
        const temporary = temporaryOf(dir, "agnescode-stats.json");
        await ensureStateDir(dir);
        await writeStateFile(file, body, { temporary });
        return true;
      } catch {
        // A read-only Home must not break the panel: the miss is one hit the
        // counter will not show, never a failure of the tab itself.
        return false;
      }
    },

    /**
     * Read the windowed snapshot, pruning anything the window has outlived.
     * @returns {Promise<AgnescodeStatsSnapshot>} counts and the last-hit time.
     */
    async read() {
      const parsed = parse(await readStateJson(file));
      if (parsed === null) return { today: 0, last30d: 0, lastAt: null };
      const byDay = prune(parsed.byDay, now);
      const today = byDay[dayKeyOf(new Date(now()))] ?? 0;
      let last30d = 0;
      for (const count of Object.values(byDay)) last30d += count;
      return { today, last30d, lastAt: parsed.lastAt };
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
 * A stats store that forgets everything when the process ends.
 *
 * Used by the tests, and by a Host that can be given nothing writable. It is
 * deliberately NOT the default: the record is a fact about the machine, and an
 * in-memory tally would vanish with the process that gathered it.
 * @param {() => number} [now] - clock source.
 * @returns {{recordRateLimit: Function, read: Function, clear: Function}} the store.
 */
export function createMemoryAgnescodeStatsStore(now = Date.now) {
  let byDay: Record<string, number> = {};
  let lastAt: number | null = null;

  return {
    async recordRateLimit(at: Date = new Date(now())) {
      byDay = prune(byDay, now);
      const key = dayKeyOf(at);
      byDay[key] = (byDay[key] ?? 0) + 1;
      lastAt = at.getTime();
      return true;
    },
    async read() {
      byDay = prune(byDay, now);
      const today = byDay[dayKeyOf(new Date(now()))] ?? 0;
      let last30d = 0;
      for (const count of Object.values(byDay)) last30d += count;
      return { today, last30d, lastAt };
    },
    async clear() {
      byDay = {};
      lastAt = null;
      return true;
    }
  };
}