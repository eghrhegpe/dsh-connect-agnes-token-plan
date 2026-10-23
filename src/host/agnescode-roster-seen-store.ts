/**
 * dsh-connect-agnes-token-plan — when each AgnesCode roster id was FIRST seen.
 *
 * WHY this exists (and why it is a separate file, not `agnescode-store.ts`): the
 * gateway's catalogue rows carry no "listed since" fact — the model list is the
 * only signal that "a model is new to this user", and it is knowable only by
 * diffing today's roster against a roster THIS plugin wrote down. In memory
 * would do for one process, but the composer pill has to survive a restart to
 * be worth rendering, so the history lives in a state file of its own (the same
 * discipline as `agnescode-stats-store.ts`: one concern, one file, one reader).
 *
 * Semantics, stated once because two consumers read them:
 *  - the FIRST ever write SEEDS: it stamps the whole roster one window back and
 *    announces nothing new — an upgrade must not tell every existing user the
 *    entire roster is brand new;
 *  - an id that LEAVES the roster is dropped, so a model the gateway re-lists
 *    later counts as new again (a re-listing IS a change the reader may want);
 *  - "new" is a WINDOW, not a tick: an id first seen less than
 *    {@link AGNESCODE_ROSTER_NEW_WINDOW_MS} ago stays new across polls, so the
 *    marker does not vanish between two catalogue reads;
 *  - a roster larger than {@link AGNESCODE_ROSTER_SEEN_MAX_IDS} is a shape
 *    drift: nothing is written or announced for its duration (evicting a live
 *    id would re-announce it next poll and the count would oscillate);
 *  - an unrecognised or foreign-version file reads as "no history" (PITFALLS
 *    §23), but the FIRST write over it is REFUSED, not stomped — the ADR-006
 *    discipline. A caller that cannot write degrades to "no marker", never to a
 *    wrong one.
 *
 * The marker is only fed from a LIVE roster: the static fallback table is this
 * plugin's own text, and diffing it would announce our rows as gateway news.
 *
 * @module dsh-connect-agnes-token-plan/agnescode-roster-seen-store
 */
import { join } from "node:path";
import { ensureStateDir, temporaryOf, writeStateFile, readStateJson, stateDir as pluginStateDir } from "./state-store.ts";
import { name } from "./host-config.ts";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const AGNESCODE_ROSTER_SEEN_VERSION = 1;

/** Every persisted shape THIS build can read (the write-side whitelist). */
export const KNOWN_AGNESCODE_ROSTER_SEEN_VERSIONS: readonly number[] = [AGNESCODE_ROSTER_SEEN_VERSION];

/**
 * How long a first sighting keeps reading as "new". Seven days: long enough that
 * a user who opens the panel twice a week still catches it, short enough that a
 * stale marker cannot outlive the model it announces.
 */
export const AGNESCODE_ROSTER_NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The largest roster one file will track — a SHAPE-DRIFT guard, not a queue.
 * A roster past the cap is read as a broken/looping producer: NOTHING is
 * written or announced for its duration, and the previous map is kept as-is.
 */
export const AGNESCODE_ROSTER_SEEN_MAX_IDS = 200;

/** id → first-seen epoch ms. */
export type AgnescodeRosterSeen = Readonly<Record<string, number>>;

/** Where the record lives: the SHARED directory, `$DSH_HOME/state/<plugin>`. */
export function agnescodeRosterSeenDir() {
  return pluginStateDir(name);
}

/**
 * Read one persisted map, keeping only well-formed entries. A non-numeric stamp
 * is dropped rather than coerced (a coerced `0` would read as "seen since 1970"
 * and mark nothing new forever). Never throws.
 * @param {unknown} raw - the persisted or posted value.
 * @returns {Record<string, number>} the usable entries (possibly empty).
 */
export function normalizeRosterSeen(raw: unknown): Record<string, number> {
  const source = raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const seen: Record<string, number> = {};
  for (const [id, stamp] of Object.entries(source)) {
    if (id === "" || typeof stamp !== "number" || !Number.isFinite(stamp) || stamp <= 0) continue;
    seen[id] = stamp;
  }
  return seen;
}

/**
 * Keep the map ONLY while the roster is a sane size: a roster past the cap is a
 * shape drift, so NOTHING is written or announced and the previous map survives.
 * @param {Record<string, number>} next - this round's map.
 * @returns {Record<string, number>|null} the map to persist, or `null` to skip.
 */
function bounded(next: Record<string, number>): Record<string, number> | null {
  return Object.keys(next).length <= AGNESCODE_ROSTER_SEEN_MAX_IDS ? next : null;
}

/** Is the parsed payload a shape THIS build recognises (a known version)? */
function parse(raw: unknown): { seen: Record<string, number> } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as { version?: unknown; seen?: unknown };
  if (body.version !== AGNESCODE_ROSTER_SEEN_VERSION) return null;
  return { seen: normalizeRosterSeen(body.seen) };
}

/**
 * The file-backed first-sighting history.
 * @param {object} [options] - `{ dir, now }` (a clock source for the tests).
 * @returns {object} the store.
 */
export function createFileAgnescodeRosterSeenStore({ dir = agnescodeRosterSeenDir(), now = Date.now } = {}) {
  const file = join(dir, "agnescode-roster-seen.json");
  const readThrough = async () => {
    const raw = await readStateJson(file);
    return { raw: raw === null ? null : (raw as unknown), parsed: parse(raw) };
  };

  /** Persist one map (atomic). Refuses to stomp a foreign-version file (ADR-006). */
  const persist = async (seen: Record<string, number>): Promise<void> => {
    const { raw } = await readThrough();
    // A file that IS present but not in a known version is a newer build's
    // record: refuse to overwrite it rather than destroy data we do not own.
    if (raw !== null && parse(raw) === null) return;
    const body = JSON.stringify({ version: AGNESCODE_ROSTER_SEEN_VERSION, seen, updatedAt: new Date().toISOString() });
    const temporary = temporaryOf(dir, "agnescode-roster-seen.json");
    await ensureStateDir(dir);
    await writeStateFile(file, body, { temporary });
  };

  return {
    /** The whole first-sighting map. */
    async seen(): Promise<AgnescodeRosterSeen> {
      const { parsed } = await readThrough();
      return parsed?.seen ?? {};
    },
    /** Whether this store has ever written a recognisable history. */
    async isSet() {
      const { parsed } = await readThrough();
      return parsed !== null;
    },
    /**
     * Record today's roster and answer which ids still read as new.
     * @param {string[]} ids - the FULL live roster as the gateway just listed it.
     * @param {number} [nowMs] - the clock (tests inject it).
     * @returns {Promise<{newIds: string[]}>} ids first seen inside the window,
     *   oldest first; empty on the seeding write and on a roster with nothing fresh.
     */
    async note(ids: readonly string[], nowMs: number = now()): Promise<{ newIds: string[] }> {
      const list = Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id !== "") : [];
      const unique = [...new Set(list)];
      if (unique.length === 0) return { newIds: [] };
      const nowT = Number.isFinite(nowMs) ? nowMs : now();
      const { raw, parsed } = await readThrough();
      // A foreign-version file: read as no-history and REFUSE to write (ADR-006)
      // — the safe direction is "no marker", never a marker written over a newer
      // build's record.
      if (raw !== null && parsed === null) return { newIds: [] };
      const previous = parsed?.seen ?? {};
      const next: Record<string, number> = {};
      const seeded = parsed === null && raw === null;
      for (const id of unique) {
        const first = previous[id];
        next[id] = typeof first === "number" && first > 0
          ? Math.min(first, nowT)
          : seeded ? nowT - AGNESCODE_ROSTER_NEW_WINDOW_MS : nowT;
      }
      const trimmed = bounded(next);
      if (trimmed === null) return { newIds: [] }; // shape drift: keep the old map
      const changed = seeded
        || Object.keys(previous).length !== Object.keys(trimmed).length
        || Object.keys(trimmed).some((id) => previous[id] !== trimmed[id]);
      if (changed) await persist(trimmed);
      const newIds = seeded
        ? []
        : Object.entries(trimmed)
          .filter(([, first]) => nowT - first < AGNESCODE_ROSTER_NEW_WINDOW_MS)
          .sort((left, right) => left[1] - right[1])
          .map(([id]) => id);
      return { newIds };
    },
    /** Forget the history (the next `note` reseeds). */
    async forget() {
      const { raw } = await readThrough();
      if (raw !== null && parse(raw) === null) return; // refuse over a foreign file
      const body = JSON.stringify({ version: AGNESCODE_ROSTER_SEEN_VERSION, seen: {}, updatedAt: new Date().toISOString() });
      const temporary = temporaryOf(dir, "agnescode-roster-seen.json");
      await ensureStateDir(dir);
      await writeStateFile(file, body, { temporary });
    }
  };
}

export type AgnescodeRosterSeenStore = ReturnType<typeof createFileAgnescodeRosterSeenStore>;

/**
 * A seen-store that forgets everything when the process ends. Used by the tests
 * and by a Host that can be given nothing writable. Deliberately NOT the default
 * (the marker must survive a restart to be worth rendering).
 * @param {() => number} [now] - clock source.
 * @returns {object} the in-memory store.
 */
export function createMemoryAgnescodeRosterSeenStore(now = Date.now) {
  let seen: Record<string, number> = {};
  let hasHistory = false;
  const note = async (ids: readonly string[], nowMs: number = now()): Promise<{ newIds: string[] }> => {
    const list = Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id !== "") : [];
    const unique = [...new Set(list)];
    if (unique.length === 0) return { newIds: [] };
    const nowT = Number.isFinite(nowMs) ? nowMs : now();
    const previous = hasHistory ? seen : {};
    const next: Record<string, number> = {};
    const seeded = !hasHistory;
    for (const id of unique) {
      const first = previous[id];
      next[id] = typeof first === "number" && first > 0
        ? Math.min(first, nowT)
        : seeded ? nowT - AGNESCODE_ROSTER_NEW_WINDOW_MS : nowT;
    }
    if (bounded(next) === null) return { newIds: [] };
    const changed = seeded
      || Object.keys(previous).length !== Object.keys(next).length
      || Object.keys(next).some((id) => previous[id] !== next[id]);
    if (changed) { seen = next; hasHistory = true; }
    const newIds = seeded
      ? []
      : Object.entries(next)
        .filter(([, first]) => nowT - first < AGNESCODE_ROSTER_NEW_WINDOW_MS)
        .sort((left, right) => left[1] - right[1])
        .map(([id]) => id);
    return { newIds };
  };
  return {
    async seen() { return hasHistory ? { ...seen } : {}; },
    async isSet() { return hasHistory; },
    note,
    async forget() { seen = {}; hasHistory = false; }
  };
}
