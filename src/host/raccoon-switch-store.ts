/**
 * The Raccoon provider-registration switch — this plugin's OWN state file,
 * kept separate from the Token Plan `provider-store.ts` because the two
 * providers are opt-in independently (ROADMAP §6.1 "second upstream provider").
 *
 * Same integrity discipline as `provider-store.ts`: a versioned payload, a
 * temp file plus an atomic rename, owner-only modes, and "anything
 * unrecognised reads as not set" (PITFALLS §23, per-profile segment).
 *
 * @module dsh-connect-sensenova-token-plan/raccoon-switch-store
 */
import { obj } from "./util.ts";
import { join } from "node:path";
import { name } from "./host-config.ts";
import { ensureStateDir, temporaryOf, writeStateFile, readStateJson, createStateReadCache, STATE_READ_TTL_MS, profileStateDir, stateDir as sharedStateDir } from "./state-store.ts";
import type { StoreOptions } from "./types.ts";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const RACCOON_SWITCH_VERSION = 1;

/**
 * The directory this switch lives in — per-profile when the Host names one.
 * @param {string|null} [profile] - the profile name; `null` means shared.
 * @returns {string} the directory.
 */
export function raccoonSwitchDir(profile) {
  return profileStateDir(name, profile);
}

/**
 * Normalize an on/off switch: only booleans are real answers.
 * @param {unknown} raw - the persisted or posted value.
 * @returns {boolean|null} `true`/`false`, or `null` when nothing usable.
 */
export function normalizeRaccoonEnabled(raw) {
  return typeof raw === "boolean" ? raw : null;
}

/**
 * The file-backed Raccoon provider switch.
 * @param {object} [options]
 * @param {string} [options.dir] - override the state directory (tests).
 * @param {string|null} [options.profile] - the profile name; see {@link raccoonSwitchDir}.
 * @param {number} [options.ttlMs] - reuse window for a parsed value.
 * @returns {object} the store.
 */
export function createFileRaccoonStore(options: StoreOptions = {}) {
  const { dir, profile = null, ttlMs = STATE_READ_TTL_MS } = options;
  const stateDir = dir ?? raccoonSwitchDir(profile);
  const filePath = join(stateDir, "raccoon-provider.json");

  const writePayload = async (body) => {
    const temporary = temporaryOf(stateDir, "raccoon-provider.json");
    await ensureStateDir(stateDir);
    await writeStateFile(filePath, JSON.stringify(body, null, 2), { temporary });
  };

  const legacyFile = dir === undefined && profile ? join(sharedStateDir(name), "raccoon-provider.json") : null;
  const parseSwitch = (raw) => {
    const source = obj(raw);
    return source.version === RACCOON_SWITCH_VERSION ? normalizeRaccoonEnabled(source.enabled) : null;
  };

  const cache = createStateReadCache(async () => parseSwitch(await readStateJson(filePath)), {
    ttlMs,
    inheritFrom: legacyFile === null ? null : {
      read: async () => parseSwitch(await readStateJson(legacyFile)),
      write: async (enabled) => {
        await writePayload({ version: RACCOON_SWITCH_VERSION, enabled, updatedAt: new Date().toISOString() });
      }
    }
  });
  const read = () => cache.read();

  return {
    /** The saved switch value. */
    async enabled() {
      return read();
    },
    /** Whether the panel has ever saved a value here. */
    async isSet() {
      return (await read()) !== null;
    },
    /** Persist a switch value (atomic). */
    async save(value) {
      const enabled = normalizeRaccoonEnabled(value);
      if (enabled === null) throw new TypeError("the raccoon switch expects a boolean");
      await writePayload({ version: RACCOON_SWITCH_VERSION, enabled, updatedAt: new Date().toISOString() });
      cache.remember(enabled);
    },
    /** Forget the panel-saved value. */
    async forget() {
      cache.remember(null);
      await writePayload({ version: RACCOON_SWITCH_VERSION, updatedAt: new Date().toISOString() });
    }
  };
}
