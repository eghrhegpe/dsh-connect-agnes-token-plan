/**
 * The ONE shape every panel opt-in switch shares.
 *
 * This plugin has four opt-in switches — provider registration, the draw tool,
 * the video tool and the AgnesCode provider — and they answer the same two
 * questions with the same integrity discipline:
 *
 *   - did THE PANEL ever decide this? (a saved value beats the config default);
 *   - if it did, which model did it prefer? (draw / video only);
 *   - persisted as a versioned payload, temp file plus atomic rename, owner-
 *     only modes, "anything unrecognised reads as not set", a short-TTL read
 *     cache, and the §23 one-shot adoption of the pre-profile shared file.
 *
 * They used to be four copies of each other. Copies drift, and the drift here
 * was not hypothetical: the draw and video copies adopted their legacy value
 * by writing the whole `{enabled, modelId}` object into the `enabled` FIELD, so
 * an inherited switch read back as unset after the next Host start — silently,
 * which is the failure shape `doctor.ts` exists to end. The two boolean-only
 * copies (provider / AgnesCode) never had it. One factory, four callers: the
 * bug class is gone by construction rather than by review.
 *
 * What is deliberately NOT unified: the on-disk file name, the shape version,
 * the model-preference wire key (`drawModelId` vs `videoModelId`), and the
 * error wording. Those are the facts that differ between the four, and they
 * are passed IN rather than copied — a shared reader that guessed the wrong
 * key would answer "no preference" for a file that plainly has one.
 *
 * Peer-free, like every state module here: no Host peer, pure `node:fs`.
 *
 * @module dsh-connect-agnes-token-plan/switch-store
 */
import { join } from "node:path";
import { obj } from "./util.ts";
import { name } from "./host-config.ts";
import {
  ensureStateDir,
  temporaryOf,
  writeStateFile,
  readStateJson,
  createStateReadCache,
  STATE_READ_TTL_MS,
  profileStateDir,
  stateDir as sharedStateDir
} from "./state-store.ts";
import type { StoreOptions } from "./types.ts";

/**
 * One parsed switch file: two answers, each independently "not set".
 *
 * `null` as a WHOLE value (rather than two nulls) means "no usable record" —
 * a missing file, unreadable bytes, or a foreign shape version. The two nulls
 * inside a present record mean "the file is ours but this answer is empty",
 * which is what `forget()` writes on purpose.
 */
export interface SwitchValue {
  /** The saved on/off decision, or `null` when never decided. */
  enabled: boolean | null;
  /** The saved model preference, or `null` when never chosen. */
  modelId: string | null;
}

/** Normalize an on/off switch: only booleans are real answers. */
export function normalizeSwitchEnabled(raw: unknown) {
  return typeof raw === "boolean" ? raw : null;
}

/** Normalize a model preference: a non-empty string id, else `null`. */
export function normalizeSwitchModelId(raw: unknown) {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

/**
 * Build the parser for one switch file's payload.
 *
 * A matching shape version is what makes a file OURS; every field inside it is
 * then normalized separately, so "our file, empty answer" is distinguishable
 * from "not our file" — which is exactly the distinction `doctor.ts` draws
 * when it names an unreadable state file instead of silently skipping it.
 * @param {number} version - this switch's shape version.
 * @param {string|null} modelKey - the persisted preference key, or `null`.
 * @returns {(raw: unknown) => SwitchValue|null} the parser.
 */
export function createSwitchParser(version: number, modelKey: string | null) {
  return (raw: unknown): SwitchValue | null => {
    const source = obj(raw);
    if (source.version !== version) return null;
    return {
      enabled: normalizeSwitchEnabled(source.enabled),
      modelId: modelKey === null ? null : normalizeSwitchModelId(source[modelKey])
    };
  };
}

/**
 * The file-backed switch every opt-in shares.
 *
 * @param {object} spec - what makes this switch different.
 * @param {string} spec.file - the state file name, e.g. `"draw.json"`.
 * @param {number} spec.version - the payload's shape version.
 * @param {string|null} [spec.modelKey] - the model-preference key; `null` for a
 *   plain on/off switch (its `modelId()` then always answers `null`).
 * @param {{enabled: string, model: string}} spec.messages - the rejection
 *   wording, so a bad write names the switch it came from.
 * @param {string} [spec.dir] - override the state directory (tests).
 * @param {string|null} [spec.profile] - the profile segment; `null` = shared.
 * @param {number} [spec.ttlMs] - reuse window for a parsed value.
 * @returns {object} the store.
 */
export function createSwitchStore(spec: {
  file: string;
  version: number;
  modelKey?: string | null;
  messages: { enabled: string; model?: string };
} & StoreOptions) {
  const {
    file,
    version,
    modelKey = null,
    messages,
    dir,
    profile = null,
    ttlMs = STATE_READ_TTL_MS
  } = spec;
  const stateDir = dir ?? profileStateDir(name, profile);
  const filePath = join(stateDir, file);
  const parse = createSwitchParser(version, modelKey);

  /**
   * Write one payload atomically — the single writer for save / forget / the
   * model preference / the §23 adoption, so no caller can invent a fourth
   * spelling of "what this file looks like".
   * @param {SwitchValue|null} body - the two answers to persist.
   * @returns {Promise<void>}
   */
  const writePayload = async (body: SwitchValue) => {
    const payload = {
      version,
      // "Not set" is the ABSENCE of a key, not a null: a consumer reading an
      // older payload must not see `enabled: null` and take it as an answer.
      ...(body.enabled === null ? {} : { enabled: body.enabled }),
      ...(modelKey !== null && body.modelId !== null ? { [modelKey]: body.modelId } : {}),
      updatedAt: new Date().toISOString()
    };
    const temporary = temporaryOf(stateDir, file);
    await ensureStateDir(stateDir);
    await writeStateFile(filePath, JSON.stringify(payload, null, 2), { temporary });
  };

  // Pre-§23 machines kept this switch in the SHARED directory. A profile-scoped
  // store inherits it once, when its own file is missing — see the note on
  // `createStateReadCache` (`state-store.ts`). An explicit `dir` (the tests)
  // never inherits: it was never part of the shared layout.
  const legacyFile = dir === undefined && profile ? join(sharedStateDir(name), file) : null;

  const cache = createStateReadCache(async () => parse(await readStateJson(filePath)), {
    ttlMs,
    inheritFrom: legacyFile === null ? null : {
      read: async () => parse(await readStateJson(legacyFile)),
      // Adoption is a COPY, so an older Host of this plugin keeps reading the
      // shared path. The adopted value is written back in this switch's OWN
      // shape — enabled and preference in their own fields — which is the whole
      // point of this factory (see the module header).
      write: async (value) => {
        await writePayload(value);
      }
    }
  });

  /** The stored record, or two empty answers when there is none. */
  const saved = async (): Promise<SwitchValue> => (await cache.read()) ?? { enabled: null, modelId: null };

  const store = {
    /**
     * The saved switch value.
     * @returns {Promise<boolean|null>} `null` = not set, fall back to config.
     */
    async enabled(): Promise<boolean | null> {
      return (await saved()).enabled;
    },
    /**
     * The saved model preference.
     * @returns {Promise<string|null>} `null` = not set, fall back to config.
     */
    async modelId(): Promise<string | null> {
      return (await saved()).modelId;
    },
    /**
     * Whether the panel has ever saved an answer here. A file that exists but
     * carries no answers (post-forget) still reads as "not set".
     * @returns {Promise<boolean>}
     */
    async isSet(): Promise<boolean> {
      const value = await cache.read();
      return value !== null && (value.enabled !== null || value.modelId !== null);
    },
    /**
     * Persist a switch value. The write is atomic (temp file + rename) so a
     * concurrent reader never sees a partial payload.
     * @param {unknown} value - the new switch state.
     * @returns {Promise<void>}
     */
    async save(value: unknown): Promise<void> {
      const enabled = normalizeSwitchEnabled(value);
      if (enabled === null) throw new TypeError(messages.enabled);
      // The preference is NOT touched by a switch write: they are two answers
      // in one file, and "I turned drawing off" is not "forget which model".
      const current = await saved();
      const next = { enabled, modelId: current.modelId };
      // Write failures PROPAGATE on purpose: a switch the panel ordered must
      // not silently stay off because the state file could not be written.
      await writePayload(next);
      cache.remember(next);
    },
    /**
     * Forget the panel-saved switch: the config default rules again.
     * @returns {Promise<void>}
     */
    async forget(): Promise<void> {
      const current = await saved();
      const next = { enabled: null, modelId: current.modelId };
      await writePayload(next);
      cache.remember(next);
    },
    /**
     * Persist a model preference (the panel's picker). `null` clears it.
     * @param {string|null} value - the preferred catalog id, or null for auto.
     * @returns {Promise<void>}
     */
    async saveModel(value: string | null): Promise<void> {
      if (modelKey === null) throw new Error(`this switch has no model preference (${file})`);
      const modelId = normalizeSwitchModelId(value);
      // `null` is a real instruction (clear it); a blank or wrong-typed value
      // is a caller bug and must not be silently coerced into "cleared".
      if (modelId === null && value != null) throw new TypeError(messages.model ?? "a model id is required");
      const current = await saved();
      const next = { enabled: current.enabled, modelId };
      await writePayload(next);
      cache.remember(next);
    },
    /**
     * Forget the model preference: the config default (usually auto) rules
     * again. The switch itself is left alone.
     * @returns {Promise<void>}
     */
    async forgetModel(): Promise<void> {
      if (modelKey === null) throw new Error(`this switch has no model preference (${file})`);
      const current = await saved();
      const next = { enabled: current.enabled, modelId: null };
      await writePayload(next);
      cache.remember(next);
    },
    /** The path this switch persists to (diagnostics / doctor). */
    filePath,
    /** The parser `doctor.ts` reuses, so it can never disagree with the store. */
    parse
  };
  return store;
}
