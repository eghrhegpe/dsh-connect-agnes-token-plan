/**
 * The AgnesCode provider-registration switch — this plugin's OWN state file,
 * a separate opt-in switch (after `provider-store.ts`). Same integrity
 * discipline: a versioned payload, temp file plus atomic rename, and
 * "anything unrecognised reads as not set" (PITFALLS §23, per-profile
 * segment). Deliberately a SEPARATE file, not a shared
 * one: flipping one provider's switch must never touch another's publish
 * decision (§5.5 isolation).
 *
 * The switch machinery is shared with the other three opt-in switches in
 * `switch-store.ts`; this module declares only what makes this file its own:
 * the name, the shape version, the absence of a model preference, and the
 * rejection wording.
 *
 * @module dsh-connect-agnes-token-plan/agnescode-switch-store
 */
import { createSwitchStore, createSwitchParser, normalizeSwitchEnabled } from "./switch-store.ts";
import { name } from "./host-config.ts";
import { profileStateDir } from "./state-store.ts";
import type { StoreOptions } from "./types.ts";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const AGNESCODE_SWITCH_VERSION = 1;

/**
 * The directory this switch lives in — per-profile when the Host names one.
 * @param {string|null} [profile] - the profile name; `null` means shared.
 * @returns {string} the directory.
 */
export function agnescodeSwitchDir(profile: string | null) {
  return profileStateDir(name, profile);
}

/**
 * Normalize an on/off switch: only booleans are real answers.
 * @param {unknown} raw - the persisted or posted value.
 * @returns {boolean|null} `true`/`false`, or `null` when nothing usable.
 */
export const normalizeAgnescodeEnabled = normalizeSwitchEnabled;

/**
 * The parser `doctor.ts` reuses, so its read-only survey can never disagree
 * with what this store accepts.
 */
export const parseAgnescodePayload = createSwitchParser(AGNESCODE_SWITCH_VERSION, null);

/**
 * The file-backed AgnesCode provider switch.
 * @param {object} [options] - see `switch-store.ts`.
 * @returns {object} the store.
 */
export function createFileAgnescodeStore(options: StoreOptions = {}) {
  const base = createSwitchStore({
    ...options,
    file: "agnescode-provider.json",
    version: AGNESCODE_SWITCH_VERSION,
    modelKey: null,
    messages: { enabled: "the agnescode switch expects a boolean" }
  });
  // A plain on/off switch, like the Token Plan provider's: no model preference.
  return {
    enabled: base.enabled,
    isSet: base.isSet,
    save: base.save,
    forget: base.forget
  };
}
