/**
 * The provider-registration switch — this plugin's OWN state file, never the
 * Host's configuration.
 *
 * Why a file at all: `registerProvider` in `cordis.patch.yml` is a DEPLOYMENT
 * default the operator edits with a reload, but the panel needs a live switch
 * that takes effect on the next request. The switch state therefore lives in
 * `$DSH_HOME/state/<plugin>/provider.json`, exactly like the catalog
 * (`catalog-store.js`) and the throttle (`throttle-store.js`): operational
 * state, not an operator decision baked into the patch layer.
 *
 * Precedence at read time:
 *
 *   1. a value SAVED FROM THE PANEL (enabled: true|false) always wins;
 *   2. no saved value (never touched, or the file was unreadable) falls back
 *      to the patch's `registerProvider` — so an operator who enabled the
 *      provider through configuration keeps it enabled across this change.
 *
 * Integrity follows `throttle-store.js` / `catalog-store.js`: a versioned
 * payload, a temp file plus an atomic rename (two Host processes can share
 * the directory), owner-only modes, and "anything unrecognised reads as not
 * set" — a corrupted or downgraded file costs one re-toggle, never a crash.
 *
 * @module dsh-connect-sensenova-token-plan/provider-store
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { str, obj } from "./util.js";
import { name } from "./host-config.js";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const PROVIDER_VERSION = 1;

/**
 * The directory this plugin's state lives in — the same one the catalog and
 * the throttle use.
 * @returns {string} the directory.
 */
export function providerDir() {
  const home = str(process.env.DSH_HOME, join(homedir(), ".dsh"));
  return join(home, "state", name);
}

/**
 * Normalize an on/off switch: only booleans are real answers.
 * @param {unknown} raw - the persisted or posted value.
 * @returns {boolean|null} `true`/`false`, or `null` when nothing usable.
 */
export function normalizeEnabled(raw) {
  return typeof raw === "boolean" ? raw : null;
}

/**
 * The file-backed provider switch.
 * @param {object} [options]
 * @param {string} [options.dir] - override the state directory (tests).
 * @returns {object} the store.
 */
export function createFileProviderStore({ dir } = {}) {
  const stateDir = dir ?? providerDir();
  const filePath = join(stateDir, "provider.json");

  /** Cache of the last good read; `undefined` = never read from disk. */
  let cached;
  let cachedAt = 0;

  /**
   * Read the persisted switch.
   * @returns {Promise<boolean|null>} the saved value, `null` when unset.
   */
  const read = async () => {
    if (cached !== undefined && Date.now() - cachedAt < 1000) return cached;
    let payload;
    try {
      payload = JSON.parse(await readFile(filePath, "utf8"));
    } catch {
      cached = null;
      cachedAt = Date.now();
      return null;
    }
    // Shape check, not trust: anything unexpected reads as "not set" so a
    // corrupted or downgraded file can never silently flip the switch.
    const source = obj(payload);
    const value = source.version === PROVIDER_VERSION ? normalizeEnabled(source.enabled) : null;
    cached = value;
    cachedAt = Date.now();
    return value;
  };

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
      const enabled = normalizeEnabled(value);
      if (enabled === null) throw new TypeError("provider switch expects a boolean");
      await mkdir(stateDir, { recursive: true });
      const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, `${JSON.stringify({ version: PROVIDER_VERSION, enabled, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, filePath);
      cached = enabled;
      cachedAt = Date.now();
    },
    /**
     * Forget the panel-saved value: the config default rules again.
     * @returns {Promise<void>}
     */
    async forget() {
      cached = null;
      cachedAt = Date.now();
      await mkdir(stateDir, { recursive: true });
      const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, `${JSON.stringify({ version: PROVIDER_VERSION, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, filePath);
    }
  };
}
