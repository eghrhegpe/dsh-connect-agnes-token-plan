/**
 * The provider-registration switch — this plugin's OWN state file, never the
 * Host's configuration.
 *
 * Why a file at all: `registerProvider` in `cordis.patch.yml` is a DEPLOYMENT
 * default the operator edits with a reload, but the panel needs a live switch
 * that takes effect on the next request. The switch state therefore lives in
 * `$DSH_HOME/state/<plugin>/provider.json`, exactly like the draw / video
 * switches and the catalog: operational state, not an operator decision baked
 * into the patch layer.
 *
 * Precedence at read time:
 *
 *   1. a value SAVED FROM THE PANEL (enabled: true|false) always wins;
 *   2. no saved value (never touched, or the file was unreadable) falls back
 *      to the patch's `registerProvider` — so an operator who enabled the
 *      provider through configuration keeps it enabled across this change.
 *
 * Everything that makes this file a switch — the versioned payload, the temp
 * file plus atomic rename, owner-only modes, "anything unrecognised reads as
 * not set", the short-TTL read cache and the §23 one-shot legacy adoption —
 * lives in `switch-store.ts` now, shared by all four opt-in switches. Only the
 * facts that differ are declared here: the file name, the shape version, the
 * absence of a model preference, and the rejection wording.
 *
 * @module dsh-connect-agnes-token-plan/provider-store
 */
import { createSwitchStore, createSwitchParser, normalizeSwitchEnabled } from "./switch-store.ts";
import { name } from "./host-config.ts";
import { profileStateDir } from "./state-store.ts";
import type { StoreOptions } from "./types.ts";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const PROVIDER_VERSION = 1;

/**
 * The directory this plugin's state lives in — per-profile when the Host names
 * one, shared otherwise (PITFALLS §23). Unlike the THROTTLE, which is
 * deliberately shared across profiles, this answers "does THIS profile want the
 * provider registered" and must not be overwritten by the other profile's Host.
 * @param {string|null} [profile] - the profile name; `null` means shared.
 * @returns {string} the directory.
 */
export function providerDir(profile: string | null) {
  return profileStateDir(name, profile);
}

/**
 * Normalize an on/off switch: only booleans are real answers.
 * @param {unknown} raw - the persisted or posted value.
 * @returns {boolean|null} `true`/`false`, or `null` when nothing usable.
 */
export const normalizeEnabled = normalizeSwitchEnabled;

/**
 * The parser `doctor.ts` reuses, so its read-only survey can never disagree
 * with what this store accepts.
 */
export const parseProviderPayload = createSwitchParser(PROVIDER_VERSION, null);

/**
 * The file-backed provider switch.
 * @param {object} [options] - see `switch-store.ts`.
 * @returns {object} the store.
 */
export function createFileProviderStore(options: StoreOptions = {}) {
  const base = createSwitchStore({
    ...options,
    file: "provider.json",
    version: PROVIDER_VERSION,
    modelKey: null,
    messages: { enabled: "provider switch expects a boolean" }
  });
  // A plain on/off switch: no model preference is offered here, so the two
  // preference calls are not part of this store's surface at all.
  return {
    enabled: base.enabled,
    isSet: base.isSet,
    save: base.save,
    forget: base.forget
  };
}
