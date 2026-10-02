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
 * Integrity follows `throttle-store.ts`: a versioned payload, a temp file plus
 * an atomic rename (two Host processes can share the directory), owner-only
 * modes, and "anything unrecognised reads as no catalog" — a corrupted or
 * downgraded file costs one re-fetch, never a crash.
 *
 * @module dsh-connect-agnes-token-plan/catalog-store
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { str, obj, num } from "./util.ts";
import { name } from "./host-config.ts";
import { ensureStateDir, temporaryOf, writeStateFile, readStateJson, createStateReadCache, STATE_READ_TTL_MS, profileStateDir, stateDir as sharedStateDir } from "./state-store.ts";
import type { StoreOptions } from "./types.ts";

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
export function normalizeEnabledIds(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out: string[] = [];
  for (const item of raw) {
    const id = str(item, "");
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * The directory this plugin's state lives in — per-profile when the Host names
 * one, shared otherwise (PITFALLS §23).
 * @param {string|null} [profile] - the profile name; `null` means shared.
 * @returns {string} the directory.
 */
export function catalogDir(profile: string | null) {
  return profileStateDir(name, profile);
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
export function normalizeEntries(raw: unknown) {
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
 * @returns {{version: number, fetchedAt: number, entries: object[], enabledModelIds: string[]}|null}
 */
function parse(raw: Record<string, unknown> | null) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = /** @type {{ version?: unknown, fetchedAt?: unknown, entries?: unknown, enabledModelIds?: unknown }} */ (raw);
  if (num(body.version, 0) !== CATALOG_VERSION) return null;
  const fetchedAt = num(body.fetchedAt, 0);
  if (fetchedAt <= 0) return null;
  const entries = normalizeEntries(body.entries);
  const enabledModelIds = normalizeEnabledIds(body.enabledModelIds);
  // `version` travels with the record so the in-memory view and the written
  // payload are the same shape: what `parse` accepted is exactly what `persist`
  // will write back.
  return { version: CATALOG_VERSION, fetchedAt, entries, enabledModelIds };
}

/**
 * The store contract both the file-backed and in-memory factories satisfy:
 * one cached catalog of model entries plus a curated id allow-list.
 * @typedef {object} CatalogStore
 * @property {() => Promise<object[]>} list - stored entries, `[]` when none usable.
 * @property {() => Promise<string[]>} listEnabledIds - allow-list; `[]` means "no filter".
 * @property {(entries: object[], enabledModelIds?: string[]) => Promise<boolean>} replace - swap the catalog, preserving the allow-list unless given a new one; returns whether the record actually reached disk.
 * @property {(ids: string[]) => Promise<boolean>} setEnabledIds - swap ONLY the allow-list; same return contract.
 * @property {() => Promise<void>} clear - remove the stored catalog.
 */

/**
 * A catalog store backed by one atomically-written file.
 * @param {object} [options] - wiring.
 * @param {string} [options.dir] - directory; overrides {@link options.profile}.
 * @param {string|null} [options.profile] - the profile name, so two profiles
 *   each get their own catalog instead of overwriting one shared allow-list;
 *   defaults to `null` (the shared directory, i.e. today's behaviour).
 * @param {() => number} [options.now] - clock source; injected by the tests.
 * @param {number} [options.ttlMs] - how long a parsed record may be reused
 *   before disk is consulted again; defaults to {@link STATE_READ_TTL_MS}.
 * @returns {CatalogStore} the store.
 */
export function createFileCatalogStore(options: StoreOptions = {}) {
  const { dir, profile = null, now = Date.now, ttlMs = STATE_READ_TTL_MS } = options;
  const stateDir = dir ?? catalogDir(profile);
  const file = join(stateDir, "catalog.json");
  /**
   * Last known record, mirrored from {@link cache} so the writers can reuse the
   * allow-list without a second read. `undefined` means "never synced from
   * disk", `null` means "synced, nothing usable stored".
   * @type {{version: number, fetchedAt: number, entries: object[], enabledModelIds: string[]}|null|undefined}
   */
  let held: { version: number; fetchedAt: number; entries: any[]; enabledModelIds: string[] } | null;
  // Read-through with a short TTL, NOT a once-per-process cache: this state
  // directory is shared with every other Host process (another profile included,
  // see PITFALLS §22), so a cache that never expires means another process's
  // allow-list edit stays invisible here until a restart. Same bound the
  // provider and draw switches already use.
  // A profile-scoped store starts empty even on a machine whose values still
  // live in the pre-§23 SHARED directory. The cache inherits that record ONCE,
  // when its own file is found missing, then writes it back. An explicit `dir`
  // (the tests) never inherits: it was never part of the shared layout.
  const legacyFile = dir === undefined && profile ? join(sharedStateDir(name), "catalog.json") : null;

  const cache = createStateReadCache(async () => parse(await readStateJson(file)), {
    ttlMs,
    now,
    inheritFrom: legacyFile === null ? null : {
      /** The pre-§23 record, if this machine ever wrote one. */
      read: async () => parse(await readStateJson(legacyFile)),
      /** Re-persist an inherited record under this profile's own directory. */
      write: async (record) => {
        held = record;
        await persist();
      }
    }
  });
  /** Sync `held` with disk (through the TTL cache) and return it. */
  const seen = async () => {
    held = await cache.read();
    return held;
  };

  /**
   * Persist the held record atomically; a write failure only loses the cache.
   *
   * The temp path is process-plus-clock unique (`state-store.ts`'s
   * `temporaryOf`), so two Host processes sharing this directory never write
   * the same temp name and `rename` each other's half-written file away.
   *
   * Returns whether the record actually reached disk. The failure is still
   * swallowed — a read-only Home must not break the panel — but the caller has
   * to know it happened: an in-memory record the disk does not hold must not
   * be treated as settled (PITFALLS §40).
   * @returns {Promise<boolean>} `true` when disk now holds `held`, `false` when the write failed.
   */
  const persist = async () => {
    if (held === null) return true;
    const temporary = temporaryOf(stateDir, "catalog.json", now);
    try {
      await ensureStateDir(stateDir);
      await writeStateFile(file, JSON.stringify(held), { temporary });
      return true;
    } catch {
      // The in-memory record still serves this process.
      await rm(temporary, { force: true }).catch(() => {});
      return false;
    }
  };

  return {
    /**
     * The stored entries, or `[]` when nothing usable is stored.
     * @returns {Promise<object[]>}
     */
    async list() {
      const record = await seen();
      return record === null ? [] : record.entries;
    },

    /**
     * The curated model-id allow-list; an EMPTY array means "no filter".
     * @returns {Promise<string[]>}
     */
    async listEnabledIds() {
      const record = await seen();
      return record === null ? [] : record.enabledModelIds;
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
     * @returns {Promise<boolean>} whether the record reached disk.
     */
    async replace(entries: any[], enabledModelIds: string[] | undefined) {
      // Sync first, so the allow-list being preserved is the one ACTUALLY
      // stored — including a list another process wrote since this one last
      // looked. Reading it lazily used to silently reset it to `[]` whenever a
      // replace happened before the first `list()`.
      const current = await seen();
      const kept = current === null ? [] : current.enabledModelIds;
      held = {
        version: CATALOG_VERSION,
        fetchedAt: now(),
        entries: normalizeEntries(entries),
        enabledModelIds: enabledModelIds === undefined ? kept : normalizeEnabledIds(enabledModelIds)
      };
      cache.remember(held);
      return persist();
    },

    /**
     * Replace ONLY the curated allow-list, keeping the cached catalog.
     * @returns {Promise<boolean>} whether the record reached disk.
     */
    async setEnabledIds(ids: string[] | undefined) {
      const current = await seen();
      const entries = current === null ? [] : current.entries;
      const fetchedAt = current === null ? now() : current.fetchedAt;
      held = { version: CATALOG_VERSION, fetchedAt, entries, enabledModelIds: normalizeEnabledIds(ids) };
      cache.remember(held);
      return persist();
    },

    /** Remove the stored catalog (used when the API key is forgotten). */
    // Returns whether the file is gone, like `replace()` and
    // `setEnabledIds()` do. The swallow stays — a failure here must not fail
    // the api-key forget the user asked for — but it used to be invisible:
    // the caller's `.catch()` sat on a promise that could never reject, so
    // "forgot the key but the old models are still offered" had no log line
    // at all (PITFALLS §42).
    async clear() {
      held = null;
      cache.remember(null);
      try {
        await rm(file, { force: true });
        return true;
      } catch {
        // An absent file is already a cleared catalog.
        return false;
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
 * @returns {CatalogStore}
 */
export function createMemoryCatalogStore(now = Date.now) {
  let held: { version: number; fetchedAt: number; entries: object[]; enabledModelIds: string[] } | null = null;
  return {
    async list() {
      return held === null ? [] : held.entries;
    },
    async listEnabledIds() {
      return held === null ? [] : held.enabledModelIds;
    },
    async replace(entries: any[], enabledModelIds: string[] | undefined) {
      const kept = held === null ? [] : held.enabledModelIds;
      held = {
        version: CATALOG_VERSION,
        fetchedAt: now(),
        entries: normalizeEntries(entries),
        enabledModelIds: enabledModelIds === undefined ? kept : normalizeEnabledIds(enabledModelIds)
      };
      // Memory IS the authority here: a record that never left the process
      // cannot have failed to persist, so it always reports success.
      return true;
    },
    async setEnabledIds(ids: string[] | undefined) {
      const entries = held === null ? [] : held.entries;
      const fetchedAt = held === null ? now() : held.fetchedAt;
      held = { version: CATALOG_VERSION, fetchedAt, entries, enabledModelIds: normalizeEnabledIds(ids) };
      return true;
    },
    async clear() {
      held = null;
    }
  };
}
