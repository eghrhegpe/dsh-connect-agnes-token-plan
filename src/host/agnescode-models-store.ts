/**
 * The AgnesCode model allow-list — this plugin's OWN state file, per-profile
 * (PITFALLS §23 segment), separate from the Token Plan catalogue's
 * `enabledModelIds` so the two providers' curation can never cross-talk.
 *
 * Same integrity discipline as `switch-store.ts`: a versioned payload, temp
 * file plus atomic rename, owner-only modes, a short-TTL read cache, and
 * "anything unrecognised reads as no curation".
 *
 * The EMPTY list is the load-bearing default: no file (or an empty list) means
 * "no filter — push every AgnesCode model", the WorkBuddy convention the
 * Token Plan side already uses. Only a NON-empty list curates. That keeps a
 * fresh install (and any user who never opened this roster) on the old
 * behaviour — nothing is silently taken away.
 *
 * @module dsh-connect-agnes-token-plan/agnescode-models-store
 */
import { join } from "node:path";
import { obj } from "./util.ts";
import { name } from "./host-config.ts";
import { normalizeEnabledIds } from "./catalog-store.ts";
import {
  ensureStateDir,
  temporaryOf,
  writeStateFile,
  readStateJson,
  createStateReadCache,
  STATE_READ_TTL_MS,
  profileStateDir
} from "./state-store.ts";
import type { StoreOptions } from "./types.ts";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const AGNESCODE_MODELS_VERSION = 1;

/** Ceiling on a curated AgnesCode list (the Token Plan side caps at 500). */
export const MAX_AGNESCODE_ENABLED_MODELS = 200;

/**
 * The directory this store lives in — per-profile when the Host names one.
 * @param {string|null} [profile] - the profile name; `null` means shared.
 * @returns {string} the directory.
 */
export function agnescodeModelsDir(profile: string | null) {
  return profileStateDir(name, profile);
}

/**
 * Parse a persisted AgnesCode allow-list payload.
 *
 * A matching shape version is what makes a file OURS; the ids are then
 * normalized, so a junk entry is dropped rather than stored. `null` as a WHOLE
 * value means "not our file / unreadable" — which reads as no curation.
 * @param {unknown} raw - the persisted payload.
 * @returns {{enabledModelIds: string[]}|null} the parsed allow-list.
 */
export function parseAgnescodeModelsPayload(raw: unknown) {
  const source = obj(raw);
  if (source.version !== AGNESCODE_MODELS_VERSION) return null;
  return { enabledModelIds: normalizeEnabledIds(source.enabledModelIds) };
}

/**
 * The file-backed AgnesCode model allow-list.
 * @param {object} [options] - `StoreOptions`.
 * @returns {object} the store.
 */
export function createFileAgnescodeModelsStore(options: StoreOptions = {}) {
  const { dir, profile = null, ttlMs = STATE_READ_TTL_MS } = options;
  const stateDir = dir ?? profileStateDir(name, profile);
  const fileName = "agnescode-models.json";
  const filePath = join(stateDir, fileName);
  const parse = parseAgnescodeModelsPayload;

  /**
   * Write one payload atomically — the single writer for save, so no caller can
   * invent a second spelling of what this file looks like.
   * @param {{enabledModelIds: string[]}} body - the allow-list to persist.
   * @returns {Promise<void>}
   */
  const writePayload = async (body: { enabledModelIds: string[] }) => {
    const payload = {
      version: AGNESCODE_MODELS_VERSION,
      enabledModelIds: body.enabledModelIds,
      updatedAt: new Date().toISOString()
    };
    const temporary = temporaryOf(stateDir, fileName);
    await ensureStateDir(stateDir);
    await writeStateFile(filePath, JSON.stringify(payload, null, 2), { temporary });
  };

  const cache = createStateReadCache(async () => parse(await readStateJson(filePath)), { ttlMs });

  return {
    /**
     * The curated ids. EMPTY means "no filter" — the roster is pushed whole.
     * @returns {Promise<string[]>} unique ids in first-seen order.
     */
    async listEnabledIds(): Promise<string[]> {
      return (await cache.read())?.enabledModelIds ?? [];
    },
    /**
     * Persist the allow-list. Empty clears curation (push everything again).
     * @param {unknown} raw - the posted id list.
     * @returns {Promise<void>}
     */
    async save(raw: unknown): Promise<void> {
      const ids = normalizeEnabledIds(raw);
      if (ids.length > MAX_AGNESCODE_ENABLED_MODELS) {
        throw new TypeError(`enabledModelIds is too long (max ${MAX_AGNESCODE_ENABLED_MODELS})`);
      }
      await writePayload({ enabledModelIds: ids });
      cache.remember({ enabledModelIds: ids });
    },
    /** The path this store persists to (diagnostics / doctor). */
    filePath,
    /** The parser `doctor.ts` reuses, so it can never disagree with the store. */
    parse
  };
}