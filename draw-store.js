// @ts-check
/**
 * The draw-tool switch — this plugin's OWN state file, never the Host's
 * configuration.
 *
 * Mirrors `provider-store.js`: `drawEnabled` in `cordis.patch.yml` is a
 * DEPLOYMENT default the operator edits with a reload, but the panel needs a
 * live switch that takes effect on the next request. The switch state lives in
 * `$DSH_HOME/state/<plugin>/draw.json`, exactly like the catalog and the
 * throttle: operational state, not an operator decision baked into the patch
 * layer.
 *
 * Precedence at read time:
 *
 *   1. a value SAVED FROM THE PANEL (enabled: true|false) always wins;
 *   2. no saved value (never touched, or the file was unreadable) falls back
 *      to the patch's `drawEnabled` — so an operator who enabled drawing
 *      through configuration keeps it enabled across this change.
 *
 * Integrity follows `provider-store.js`: a versioned payload, a temp file plus
 * an atomic rename, owner-only modes, and "anything unrecognised reads as not
 * set" — a corrupted or downgraded file costs one re-toggle, never a crash.
 *
 * @module dsh-connect-sensenova-token-plan/draw-store
 */
import { obj } from "./util.js";
import { join } from "node:path";
import { name } from "./host-config.js";
import { ensureStateDir, temporaryOf, writeStateFile, readStateJson, createStateReadCache, STATE_READ_TTL_MS, stateDir as pluginStateDir } from "./state-store.js";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const DRAW_STORE_VERSION = 1;

/**
 * The directory this plugin's state lives in — the same one the catalog,
 * throttle and provider switch use.
 * @returns {string} the directory.
 */
export function drawStoreDir() {
  return pluginStateDir(name);
}

/**
 * Normalize an on/off switch: only booleans are real answers.
 * @param {unknown} raw - the persisted or posted value.
 * @returns {boolean|null} `true`/`false`, or `null` when nothing usable.
 */
export function normalizeDrawEnabled(raw) {
  return typeof raw === "boolean" ? raw : null;
}

/**
 * The file-backed draw switch.
 * @param {object} [options]
 * @param {string} [options.dir] - override the state directory (tests).
 * @param {number} [options.ttlMs] - how long a parsed switch may be reused
 *   before disk is consulted again; defaults to {@link STATE_READ_TTL_MS}.
 * @returns {object} the store.
 */
export function createFileDrawStore({ dir, ttlMs = STATE_READ_TTL_MS } = {}) {
  const stateDir = dir ?? drawStoreDir();
  const filePath = join(stateDir, "draw.json");

  // Short-TTL read cache, shared with the provider switch and the catalog
  // (`state-store.js`): see the note in `provider-store.js` — one primitive,
  // three callers, so the three cannot drift apart again.
  const cache = createStateReadCache(async () => {
    // Shape check, not trust: anything unexpected reads as "not set" so a
    // corrupted or downgraded file can never silently flip the switch.
    // Absent/unreadable/non-JSON reads as `null` (`readStateJson`).
    const source = obj(await readStateJson(filePath));
    return source.version === DRAW_STORE_VERSION ? normalizeDrawEnabled(source.enabled) : null;
  }, { ttlMs });
  const read = () => cache.read();

  return {
    /**
     * The saved switch value.
     * @returns {Promise<boolean|null>} `null` = not set, fall back to config.
     */
    async enabled() {
      return read();
    },
    /**
     * Whether the panel has ever saved a value here.
     * @returns {Promise<boolean>}
     */
    async isSet() {
      return (await read()) !== null;
    },
    /**
     * Persist a switch value. The write is atomic (temp file + rename) so a
     * concurrent reader never sees a partial payload.
     * @param {boolean} value - the new switch state.
     * @returns {Promise<void>}
     */
    async save(value) {
      const enabled = normalizeDrawEnabled(value);
      if (enabled === null) throw new TypeError("draw switch expects a boolean");
      // Write failures PROPAGATE on purpose: a switch the panel ordered must
      // not silently stay off because the state file could not be written.
      const temporary = temporaryOf(stateDir, "draw.json");
      await ensureStateDir(stateDir);
      await writeStateFile(filePath, JSON.stringify({ version: DRAW_STORE_VERSION, enabled, updatedAt: new Date().toISOString() }, null, 2), { temporary });
      cache.remember(enabled);
    },
    /**
     * Forget the panel-saved value: the config default rules again.
     * @returns {Promise<void>}
     */
    async forget() {
      cache.remember(null);
      const temporary = temporaryOf(stateDir, "draw.json");
      await ensureStateDir(stateDir);
      await writeStateFile(filePath, JSON.stringify({ version: DRAW_STORE_VERSION, updatedAt: new Date().toISOString() }, null, 2), { temporary });
    }
  };
}
