/**
 * The AgnesCode switch files — this plugin's OWN state, separate opt-in
 * switches (after `provider-store.ts`): the provider-registration switch and
 * the desktop-source switch (ADR-020). Same integrity discipline: a versioned
 * payload, temp file plus atomic rename, and "anything unrecognised reads as
 * not set" (PITFALLS §23, per-profile segment). Deliberately SEPARATE files,
 * not a shared one: flipping one AgnesCode decision must never touch the
 * other's publish / source answer (§5.5 isolation).
 *
 * The switch machinery is shared with the other opt-in switches in
 * `switch-store.ts`; this module declares only what makes each file its own:
 * the name, the shape version, the absence of a model preference, and the
 * rejection wording.
 *
 * @module dsh-connect-agnes-token-plan/agnescode-switch-store
 */
import { createSwitchStore, createSwitchParser, normalizeSwitchEnabled } from "./switch-store.ts";
import type { StoreOptions } from "./types.ts";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const AGNESCODE_SWITCH_VERSION = 1;

/** Shape version of the desktop-source switch (its own file, its own counter). */
export const AGNESCODE_DESKTOP_SOURCE_SWITCH_VERSION = 1;


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

/** The desktop-source parser `doctor.ts` reuses (its own version counter). */
export const parseAgnescodeDesktopSourcePayload = createSwitchParser(AGNESCODE_DESKTOP_SOURCE_SWITCH_VERSION, null);

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

/**
 * The file-backed desktop-SOURCE switch (ADR-020): does the store consult the
 * desktop App's session file as a read-only view before its stored slot?
 * Opt-in default OFF, panel-only (dialect B in `switch-precedence.ts`) — it
 * has no patch config default, so an unset panel value resolves to OFF, never
 * to a value nobody declared. Its own state file, for the same isolation
 * reason as the provider switch above.
 * @param {object} [options] - see `switch-store.ts`.
 * @returns {object} the store.
 */
export function createFileAgnescodeDesktopSourceStore(options: StoreOptions = {}) {
  const base = createSwitchStore({
    ...options,
    file: "agnescode-desktop-source.json",
    version: AGNESCODE_DESKTOP_SOURCE_SWITCH_VERSION,
    modelKey: null,
    messages: { enabled: "the agnescode desktop-source switch expects a boolean" }
  });
  return {
    enabled: base.enabled,
    isSet: base.isSet,
    save: base.save,
    forget: base.forget
  };
}
