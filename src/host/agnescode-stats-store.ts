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
 *   - It records the plugin's OWN traffic only — the finish chunks the AgnesCode
 *     route classified as `RATE_LIMIT`, and the `usage` chunks its streams
 *     emitted. It cannot see the desktop App's traffic. That boundary is a
 *     feature, not a gap, and it is WHY every figure here is labelled
 *     "经本插件 / via this plugin" at the point of display: an aggregate that
 *     silently mixed in the desktop App would be a number nobody could read,
 *     while one that says whose traffic it is can be read honestly.
 *   - The rate-limit tally records the SYMPTOM, not the threshold. AgnesCode's
 *     RPM ceiling is unpublished and untested (ROADMAP §6.3 — deliberately not
 *     probed as a by-request-volume availability test). The panel therefore
 *     never prints a specific "N requests/minute", only "you hit the cap N
 *     times today". A counter is an observation; a number the plugin invented
 *     would be a claim.
 *   - The usage tally records request COUNT and token COUNTS (input / output /
 *     cache-read), aggregated per local day over the same 30-day window. The
 *     2026-10-18 revision added this: the old store refused to keep token
 *     counts on the grounds that a plugin-only figure would understate the
 *     account and "read as a healthy-looking number the user might act on".
 *     That reasoning conflated two different questions — "how much has my
 *     ACCOUNT spent" (the credit ledger's job, desktop included) and "how much
 *     have MY plugin calls spent" (what the reader actually asks, and what the
 *     sibling plugins surface). The fix is not to hide the figure but to
 *     qualify it: label it per-client, keep the ledger as the account truth.
 *     A number with the right scope on its label is honest; the same number
 *     without a label is the lie the old ruling was guarding against.
 *
 * @module dsh-connect-agnes-token-plan/agnescode-stats-store
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ensureStateDir, temporaryOf, writeStateFile, readStateJson, stateDir as pluginStateDir } from "./state-store.ts";
import { name } from "./host-config.ts";

/**
 * Shape version, bumped when the persisted form changes in a way an older
 * reader cannot tolerate.
 *
 * The 2026-10-18 usage tally was added WITHOUT a bump, on purpose: it is a new
 * sibling section (`usage`) beside `rateLimit`, and both readers ignore a
 * section they do not understand. So a v1 file written before the upgrade still
 * parses (usage reads back as empty), and a v1 file written after the upgrade
 * still has its `rateLimit` read correctly by a downgraded plugin. Bumping here
 * would throw away the rate-limit history on the first read for no benefit —
 * the version is a compatibility gate, and this change needs no gate.
 */
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
 * of the last hit, plus the per-client usage tally. Flat scalars only — the
 * daily breakdown stays Host-side, so the wire never carries anything shaped
 * like per-day history.
 * @typedef {object} AgnescodeStatsSnapshot
 * @property {number} today - rate-limit hits on the local day of `now`.
 * @property {number} last30d - hits across the trailing {@link WINDOW_DAYS} window.
 * @property {number|null} lastAt - epoch ms of the most recent hit, `null` when never.
 * @property {AgnescodeUsageSnapshot} usage - this plugin's own request/token
 *   tally over the same window (see {@link AgnescodeUsageSnapshot}).
 */

/**
 * The per-client usage roll the panel reads. `today*` are the local-day
 * figures; `last30d*` the trailing window. `total` is input + output tokens
 * (pi-ai already folds reasoning into output). `lastAt` is the most recent
 * usage-bearing turn, `null` when none recorded.
 * @typedef {object} AgnescodeUsageSnapshot
 * @property {number} todayRequests
 * @property {number} todayInput
 * @property {number} todayOutput
 * @property {number} todayCacheRead
 * @property {number} todayTotal
 * @property {number} last30dRequests
 * @property {number} last30dTotal
 * @property {number|null} lastAt
 */

/** A day's usage bucket: the four tallies the panel can sum. */
function emptyUsageDay() {
  return { requests: 0, input: 0, output: 0, cacheRead: 0 };
}

/**
 * Coerce one persisted day bucket to numbers, dropping anything malformed or
 * non-positive (a zero tally is a placeholder we never write, so it is no
 * different from absent).
 * @param {unknown} raw
 * @returns {{requests:number,input:number,output:number,cacheRead:number}}
 */
function parseUsageDay(raw: unknown) {
  const out = emptyUsageDay();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  const day = raw as Record<string, unknown>;
  for (const field of ["requests", "input", "output", "cacheRead"] as const) {
    const value = day[field];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) out[field] = Math.floor(value);
  }
  return out;
}

/**
 * Bring a persisted payload to {@link STATS_VERSION}, or `null` when the shape
 * is foreign (unrecognised version). Pruning is done separately by `prune` and
 * `pruneUsage`, which need the clock.
 * @param {unknown} raw - the parsed file contents.
 * @returns {{byDay: Record<string, number>, lastAt: number|null, usageByDay: Record<string, {requests:number,input:number,output:number,cacheRead:number}>, usageLastAt: number|null}|null}
 */
function parse(raw: unknown) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as { version?: unknown; rateLimit?: unknown; usage?: unknown };
  const version = Number(body.version);
  if (!Number.isFinite(version) || version !== STATS_VERSION) return null;
  const section = (body.rateLimit ?? null) as { byDay?: unknown; lastAt?: unknown } | null;
  const byDay: Record<string, number> = {};
  if (section !== null && typeof section === "object" && !Array.isArray(section)) {
    if (section.byDay !== null && typeof section.byDay === "object" && !Array.isArray(section.byDay)) {
      for (const [key, value] of Object.entries(section.byDay as Record<string, unknown>)) {
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
        if (typeof key !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
        byDay[key] = Math.floor(value);
      }
    }
  }
  const lastAtRaw = section?.lastAt;
  const lastAt = typeof lastAtRaw === "number" && Number.isFinite(lastAtRaw) ? Math.floor(lastAtRaw) : null;

  // The usage section is optional and forward/backward compatible: an old file
  // has none (reads back empty), a file written by a newer reader carries one
  // this reader ignores on the wire but keeps on disk.
  const usageSection = (body.usage ?? null) as { byDay?: unknown; lastAt?: unknown } | null;
  const usageByDay: Record<string, { requests: number; input: number; output: number; cacheRead: number }> = {};
  if (usageSection !== null && typeof usageSection === "object" && !Array.isArray(usageSection)
    && usageSection.byDay !== null && typeof usageSection.byDay === "object" && !Array.isArray(usageSection.byDay)) {
    for (const [key, value] of Object.entries(usageSection.byDay as Record<string, unknown>)) {
      if (typeof key !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      const day = parseUsageDay(value);
      if (day.requests === 0 && day.input === 0 && day.output === 0 && day.cacheRead === 0) continue;
      usageByDay[key] = day;
    }
  }
  const usageLastAtRaw = usageSection?.lastAt;
  const usageLastAt = typeof usageLastAtRaw === "number" && Number.isFinite(usageLastAtRaw) ? Math.floor(usageLastAtRaw) : null;
  return { byDay, lastAt, usageByDay, usageLastAt };
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
 * The usage-window twin of {@link prune}: drop day buckets the 30-day window
 * has outlived. Same floor, same copy-not-mutate contract.
 * @param {Record<string, {requests:number,input:number,output:number,cacheRead:number}>} byDay
 * @param {() => number} now
 * @returns {Record<string, {requests:number,input:number,output:number,cacheRead:number}>}
 */
function pruneUsage(byDay: Record<string, { requests: number; input: number; output: number; cacheRead: number }>, now: () => number) {
  const floor = epochDayMsOf(new Date(now())) - WINDOW_DAYS * 86_400_000;
  const out: Record<string, { requests: number; input: number; output: number; cacheRead: number }> = {};
  for (const [key, day] of Object.entries(byDay)) {
    const at = new Date(`${key}T00:00:00`).getTime();
    if (Number.isFinite(at) && at >= floor) out[key] = day;
  }
  return out;
}

/**
 * The empty usage roll: what a fresh (or foreign-shaped) file reads back.
 * @returns {AgnescodeUsageSnapshot}
 */
function emptyUsageSnapshot() {
  return {
    todayRequests: 0, todayInput: 0, todayOutput: 0, todayCacheRead: 0, todayTotal: 0,
    last30dRequests: 0, last30dTotal: 0, lastAt: null
  };
}

/**
 * Roll a pruned usage map into the flat snapshot the panel reads. `today*` sum
 * the local-day bucket; `last30d*` sum the whole window. `total` is input +
 * output (pi-ai already folded reasoning into output; cacheRead is a SUBSET of
 * input — the platform's cache hit — so it never adds to the total, only to
 * the "of which cached" qualifier).
 * @param {Record<string, {requests:number,input:number,output:number,cacheRead:number}>} usageByDay
 * @param {number|null} usageLastAt
 * @param {() => number} now
 * @returns {AgnescodeUsageSnapshot}
 */
function readUsage(usageByDay: Record<string, { requests: number; input: number; output: number; cacheRead: number }>, usageLastAt: number | null, now: () => number) {
  const pruned = pruneUsage(usageByDay, now);
  const today = pruned[dayKeyOf(new Date(now()))] ?? emptyUsageDay();
  let last30dRequests = 0;
  let last30dTotal = 0;
  for (const day of Object.values(pruned)) {
    last30dRequests += day.requests;
    last30dTotal += day.input + day.output;
  }
  return {
    todayRequests: today.requests,
    todayInput: today.input,
    todayOutput: today.output,
    todayCacheRead: today.cacheRead,
    todayTotal: today.input + today.output,
    last30dRequests,
    last30dTotal,
    lastAt: usageLastAt
  };
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
 * @returns {{recordRateLimit: Function, recordUsage: Function, read: Function, clear: Function}} the store.
 */
export function createFileAgnescodeStatsStore({ dir = agnescodeStatsDir(), now = Date.now } = {}) {
  const file = join(dir, "agnescode-stats.json");

  return {
    /**
     * Record one rate-limit hit at `at` (a Date; defaults to `now`). The usage
     * section is read back and re-written verbatim so a hit never clobbers the
     * token tally (and vice versa) — the two observers fire on the same stream
     * and must not race each other's file write.
     * @param {Date} [at] - when the hit happened.
     * @returns {Promise<boolean>} whether the record reached the disk.
     */
    async recordRateLimit(at: Date = new Date(now())) {
      const key = dayKeyOf(at);
      try {
        const parsed = parse(await readStateJson(file)) ?? { byDay: {}, lastAt: null, usageByDay: {}, usageLastAt: null };
        const byDay = prune(parsed.byDay, now);
        byDay[key] = (byDay[key] ?? 0) + 1;
        const body = JSON.stringify({
          version: STATS_VERSION,
          rateLimit: { byDay, lastAt: at.getTime() },
          usage: { byDay: pruneUsage(parsed.usageByDay ?? {}, now), lastAt: parsed.usageLastAt ?? null }
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
     * Fold one usage turn into the day bucket at `at`. `usage` is the harness
     * `TokenUsage` the pi-ai adapter mapped (input/output/cacheRead; reasoning
     * already folded into output by `mapUsage`). A turn with nothing to add
     * (all-zero) is skipped, so a stream that reports no usage never inflates
     * the request count. Fire-and-forget like {@link recordRateLimit}.
     * @param {{inputTokens?: number, outputTokens?: number, cacheReadTokens?: number}} usage
     * @param {Date} [at] - when the turn finished.
     * @returns {Promise<boolean>} whether the record reached the disk.
     */
    async recordUsage(usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }, at: Date = new Date(now())) {
      const input = typeof usage?.inputTokens === "number" && usage.inputTokens > 0 ? Math.floor(usage.inputTokens) : 0;
      const output = typeof usage?.outputTokens === "number" && usage.outputTokens > 0 ? Math.floor(usage.outputTokens) : 0;
      const cacheRead = typeof usage?.cacheReadTokens === "number" && usage.cacheReadTokens > 0 ? Math.floor(usage.cacheReadTokens) : 0;
      if (input === 0 && output === 0 && cacheRead === 0) return true;
      const key = dayKeyOf(at);
      try {
        const parsed = parse(await readStateJson(file)) ?? { byDay: {}, lastAt: null, usageByDay: {}, usageLastAt: null };
        const usageByDay = pruneUsage(parsed.usageByDay ?? {}, now);
        const day = usageByDay[key] ?? emptyUsageDay();
        day.requests += 1;
        day.input += input;
        day.output += output;
        day.cacheRead += cacheRead;
        usageByDay[key] = day;
        const body = JSON.stringify({
          version: STATS_VERSION,
          rateLimit: { byDay: prune(parsed.byDay, now), lastAt: parsed.lastAt ?? null },
          usage: { byDay: usageByDay, lastAt: at.getTime() }
        });
        const temporary = temporaryOf(dir, "agnescode-stats.json");
        await ensureStateDir(dir);
        await writeStateFile(file, body, { temporary });
        return true;
      } catch {
        return false;
      }
    },

    /**
     * Read the windowed snapshot, pruning anything the window has outlived.
     * @returns {Promise<AgnescodeStatsSnapshot>} counts, the last-hit time, and the usage roll.
     */
    async read() {
      const parsed = parse(await readStateJson(file));
      if (parsed === null) return { today: 0, last30d: 0, lastAt: null, usage: emptyUsageSnapshot() };
      const byDay = prune(parsed.byDay, now);
      const today = byDay[dayKeyOf(new Date(now()))] ?? 0;
      let last30d = 0;
      for (const count of Object.values(byDay)) last30d += count;
      return { today, last30d, lastAt: parsed.lastAt, usage: readUsage(parsed.usageByDay ?? {}, parsed.usageLastAt ?? null, now) };
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
 * @returns {{recordRateLimit: Function, recordUsage: Function, read: Function, clear: Function}} the store.
 */
export function createMemoryAgnescodeStatsStore(now = Date.now) {
  let byDay: Record<string, number> = {};
  let lastAt: number | null = null;
  let usageByDay: Record<string, { requests: number; input: number; output: number; cacheRead: number }> = {};
  let usageLastAt: number | null = null;

  return {
    async recordRateLimit(at: Date = new Date(now())) {
      byDay = prune(byDay, now);
      const key = dayKeyOf(at);
      byDay[key] = (byDay[key] ?? 0) + 1;
      lastAt = at.getTime();
      return true;
    },
    async recordUsage(usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }, at: Date = new Date(now())) {
      const input = typeof usage?.inputTokens === "number" && usage.inputTokens > 0 ? Math.floor(usage.inputTokens) : 0;
      const output = typeof usage?.outputTokens === "number" && usage.outputTokens > 0 ? Math.floor(usage.outputTokens) : 0;
      const cacheRead = typeof usage?.cacheReadTokens === "number" && usage.cacheReadTokens > 0 ? Math.floor(usage.cacheReadTokens) : 0;
      if (input === 0 && output === 0 && cacheRead === 0) return true;
      usageByDay = pruneUsage(usageByDay, now);
      const key = dayKeyOf(at);
      const day = usageByDay[key] ?? emptyUsageDay();
      day.requests += 1;
      day.input += input;
      day.output += output;
      day.cacheRead += cacheRead;
      usageByDay[key] = day;
      usageLastAt = at.getTime();
      return true;
    },
    async read() {
      byDay = prune(byDay, now);
      const today = byDay[dayKeyOf(new Date(now()))] ?? 0;
      let last30d = 0;
      for (const count of Object.values(byDay)) last30d += count;
      return { today, last30d, lastAt, usage: readUsage(usageByDay, usageLastAt, now) };
    },
    async clear() {
      byDay = {};
      lastAt = null;
      usageByDay = {};
      usageLastAt = null;
      return true;
    }
  };
}