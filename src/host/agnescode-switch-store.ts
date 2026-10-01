/**
 * The AgnesCode provider-registration switch — this plugin's OWN state file,
 * a separate opt-in switch (after `provider-store.ts`). Same integrity
 * discipline: a versioned payload, temp file plus atomic rename, and
 * "anything unrecognised reads as not set" (PITFALLS §23, per-profile
 * segment). Deliberately a SEPARATE file, not a shared
 * one: flipping one provider's switch must never touch another's publish
 * decision (§5.5 isolation).
 *
 * @module dsh-connect-agnes-token-plan/agnescode-switch-store
 */
import { obj } from "./util.ts";
import { join } from "node:path";
import { name } from "./host-config.ts";
import { ensureStateDir, temporaryOf, writeStateFile, readStateJson, createStateReadCache, STATE_READ_TTL_MS, profileStateDir, stateDir as sharedStateDir } from "./state-store.ts";
import type { StoreOptions } from "./types.ts";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const AGNESCODE_SWITCH_VERSION = 1;

/**
 * The directory this switch lives in — per-profile when the Host names one.
 * @param {string|null} [profile] - the profile name; `null` means shared.
 * @returns {string} the directory.
 */
export function agnescodeSwitchDir(profile) {
  return profileStateDir(name, profile);
}

/**
 * Normalize an on/off switch: only booleans are real answers.
 * @param {unknown} raw - the persisted or posted value.
 * @returns {boolean|null} `true`/`false`, or `null` when nothing usable.
 */
export function normalizeAgnescodeEnabled(raw) {
  return typeof raw === "boolean" ? raw : null;
}

/**
 * The file-backed AgnesCode provider switch.
 * @param {object} [options]
 * @param {string} [options.dir] - override the state directory (tests).
 * @param {string|null} [options.profile] - the profile name; see {@link agnescodeSwitchDir}.
 * @param {number} [options.ttlMs] - reuse window for a parsed value.
 * @returns {object} the store.
 */
export function createFileAgnescodeStore(options: StoreOptions = {}) {
  const { dir, profile = null, ttlMs = STATE_READ_TTL_MS } = options;
  const stateDir = dir ?? agnescodeSwitchDir(profile);
  const filePath = join(stateDir, "agnescode-provider.json");

  const writePayload = async (body) => {
    const temporary = temporaryOf(stateDir, "agnescode-provider.json");
    await ensureStateDir(stateDir);
    await writeStateFile(filePath, JSON.stringify(body, null, 2), { temporary });
  };

  const legacyFile = dir === undefined && profile ? join(sharedStateDir(name), "agnescode-provider.json") : null;
  const parseSwitch = (raw) => {
    const source = obj(raw);
    return source.version === AGNESCODE_SWITCH_VERSION ? normalizeAgnescodeEnabled(source.enabled) : null;
  };

  const cache = createStateReadCache(async () => parseSwitch(await readStateJson(filePath)), {
    ttlMs,
    inheritFrom: legacyFile === null ? null : {
      read: async () => parseSwitch(await readStateJson(legacyFile)),
      write: async (enabled) => {
        await writePayload({ version: AGNESCODE_SWITCH_VERSION, enabled, updatedAt: new Date().toISOString() });
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
      const enabled = normalizeAgnescodeEnabled(value);
      if (enabled === null) throw new TypeError("the agnescode switch expects a boolean");
      await writePayload({ version: AGNESCODE_SWITCH_VERSION, enabled, updatedAt: new Date().toISOString() });
      cache.remember(enabled);
    },
    /** Forget the panel-saved value. */
    async forget() {
      cache.remember(null);
      await writePayload({ version: AGNESCODE_SWITCH_VERSION, updatedAt: new Date().toISOString() });
    }
  };
}
