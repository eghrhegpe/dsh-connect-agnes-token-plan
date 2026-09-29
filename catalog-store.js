/**
 * The persisted model catalog — this plugin's OWN state file, never the Host's
 * configuration.
 *
 * Why a file at all: the directly-registered LLM provider needs a model list
 * before the first snapshot poll completes (and after a restart with no console
 * login), so the last catalog the API key fetched is cached under
 * `$DSH_HOME/state/<plugin>/catalog.json`. It is deliberately NOT written into
 * the settings row (`cordis.patch.yml`): a catalog is operational state, not an
 * operator decision, and writing volatile arrays into the patch layer is the
 * shape the WorkBuddy catalog drift warned about.
 *
 * Integrity follows `throttle-store.js`: a versioned payload, a temp file plus
 * an atomic rename (two Host processes can share the directory), owner-only
 * modes, and "anything unrecognised reads as no catalog" — a corrupted or
 * downgraded file costs one re-fetch, never a crash.
 *
 * @module dsh-connect-sensenova-token-plan/catalog-store
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { str, obj, num } from "./util.js";
import { name } from "./host-config.js";
import { ensureStateDir, temporaryOf, writeStateFile, readStateJson, stateDir as pluginStateDir } from "./state-store.js";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const CATALOG_VERSION = 1;

/**
 * Normalize a model-id allow-list.
 *
 * An EMPTY list means "no filter" (the WorkBuddy convention): a fresh install
 * has curated nothing and must still be offered every model. Once non-empty it
 * is an allow-list. Junk entries are dropped rather than stored.
 * @param {unknown} raw - the persisted or posted list.
 * @returns {string[]} unique string ids in first-seen order.
 */
export function normalizeEnabledIds(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const id = str(item, "");
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * The directory this plugin's state lives in — the same one the throttle uses.
 * @returns {string} the directory.
 */
export function catalogDir() {
  return pluginStateDir(name);
}

/**
 * Normalize a raw catalog into unique, whole entries.
 *
 * Mirrors `console-client.fetchModelCatalog`: keep every field the platform
 * sent (vision identification reads `input_modalities`), normalize `id`, and
 * drop entries without one. Duplicate ids keep the LAST occurrence — the
 * freshest read wins — and stay in first-seen order.
 * @param {unknown} raw - the raw `body.data` array or persisted entries.
 * @returns {object[]} normalized entries.
 */
export function normalizeEntries(raw) {
  if (!Array.isArray(raw)) return [];
  const byId = new Map();
  for (const item of raw) {
    const source = obj(item);
    const id = str(source.id, "");
    if (id === "") continue;
    byId.set(id, { ...source, id });
  }
  return [...byId.values()];
}

/**
 * Parse a persisted catalog, or `null` when it is absent, stale, or foreign.
 *
 * The safe direction for a cache is "absent": the next snapshot re-fetches.
 * @param {unknown} raw - the parsed file contents.
 * @returns {{fetchedAt: number, entries: object[], enabledModelIds: string[]}|null}
 */
function parse(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (num(raw.version, 0) !== CATALOG_VERSION) return null;
  const fetchedAt = num(raw.fetchedAt, 0);
  if (fetchedAt <= 0) return null;
  const entries = normalizeEntries(raw.entries);
  const enabledModelIds = normalizeEnabledIds(raw.enabledModelIds);
  return { fetchedAt, entries, enabledModelIds };
}

/**
 * A catalog store backed by one atomically-written file.
 * @param {object} [options] - wiring.
 * @param {string} [options.dir] - directory; defaults to {@link catalogDir}.
 * @param {() => number} [options.now] - clock source; injected by the tests.
 * @returns {{list: Function, replace: Function, clear: Function}} the store.
 */
export function createFileCatalogStore({ dir = catalogDir(), now = Date.now } = {}) {
  const file = join(dir, "catalog.json");
  /** Last read/written record, so `list()` costs no I/O after the first call. */
  let held;

  /**
   * Persist the held record atomically; a write failure only loses the cache.
   *
   * The temp path is process-plus-clock unique (`state-store.js`'s
   * `temporaryOf`), so two Host processes sharing this directory never write
   * the same temp name and `rename` each other's half-written file away.
   */
  const persist = async () => {
    if (held === null) return;
    const temporary = temporaryOf(dir, "catalog.json", now);
    try {
      await ensureStateDir(dir);
      await writeStateFile(file, JSON.stringify(held), { temporary });
    } catch {
      // The in-memory record still serves this process.
      await rm(temporary, { force: true }).catch(() => {});
    }
  };

  return {
    /**
     * The stored entries, or `[]` when nothing usable is stored.
     * @returns {Promise<object[]>}
     */
    async list() {
      if (held === undefined) {
        held = parse(await readStateJson(file));
      }
      return held === null ? [] : held.entries;
    },

    /**
     * The curated model-id allow-list; an EMPTY array means "no filter".
     * @returns {Promise<string[]>}
     */
    async listEnabledIds() {
      if (held === undefined) {
        held = parse(await readStateJson(file));
      }
      return held === null ? [] : held.enabledModelIds;
    },

    /**
     * Atomically replace the stored catalog.
     *
     * A read-only Home must not break the panel: the write failing only means
     * the catalog is re-fetched after the next restart, so the error is
     * swallowed after the in-memory copy is updated. The curated allow-list is
     * PRESERVED across a catalog refresh unless a new one is supplied.
     * @param {object[]} entries - the fresh catalog entries.
     * @param {string[]} [enabledModelIds] - an optional replacement allow-list.
     * @returns {Promise<void>}
     */
    async replace(entries, enabledModelIds) {
      const kept = held === null || held === undefined ? [] : held.enabledModelIds;
      held = {
        version: CATALOG_VERSION,
        fetchedAt: now(),
        entries: normalizeEntries(entries),
        enabledModelIds: enabledModelIds === undefined ? kept : normalizeEnabledIds(enabledModelIds)
      };
      await persist();
    },

    /** Replace ONLY the curated allow-list, keeping the cached catalog. */
    async setEnabledIds(ids) {
      const entries = held === null || held === undefined ? [] : held.entries;
      const fetchedAt = held === null || held === undefined ? now() : held.fetchedAt;
      held = { version: CATALOG_VERSION, fetchedAt, entries, enabledModelIds: normalizeEnabledIds(ids) };
      await persist();
    },

    /** Remove the stored catalog (used when the API key is forgotten). */
    async clear() {
      held = null;
      try {
        await rm(file, { force: true });
      } catch {
        // An absent file is already a cleared catalog.
      }
    }
  };
}

/**
 * A catalog store that forgets everything when the process ends.
 *
 * Used by the tests and by hosts given nothing writable; deliberately not the
 * default, like the memory throttle store.
 * @param {() => number} [now] - clock source.
 * @returns {{list: Function, replace: Function, clear: Function}}
 */
export function createMemoryCatalogStore(now = Date.now) {
  let held = null;
  return {
    async list() {
      return held === null ? [] : held.entries;
    },
    async listEnabledIds() {
      return held === null ? [] : held.enabledModelIds;
    },
    async replace(entries, enabledModelIds) {
      const kept = held === null ? [] : held.enabledModelIds;
      held = {
        version: CATALOG_VERSION,
        fetchedAt: now(),
        entries: normalizeEntries(entries),
        enabledModelIds: enabledModelIds === undefined ? kept : normalizeEnabledIds(enabledModelIds)
      };
    },
    async setEnabledIds(ids) {
      const entries = held === null ? [] : held.entries;
      const fetchedAt = held === null ? now() : held.fetchedAt;
      held = { version: CATALOG_VERSION, fetchedAt, entries, enabledModelIds: normalizeEnabledIds(ids) };
    },
    async clear() {
      held = null;
    }
  };
}
