/**
 * The provider-registration switch — this plugin's OWN state file, never the
 * Host's configuration.
 *
 * Why a file at all: `registerProvider` in `cordis.patch.yml` is a DEPLOYMENT
 * default the operator edits with a reload, but the panel needs a live switch
 * that takes effect on the next request. So the switch lives in
 * `$DSH_HOME/state/<plugin>/provider.json` — operational state, not an
 * operator decision baked into the patch layer.
 *
 * **Precedence is not stated here on purpose.** "A value saved from the panel
 * wins, an untouched file falls back to the patch's `registerProvider`" is one
 * rule shared by all four opt-in switches and owned by `switch-precedence.ts`;
 * restating it here (and in the two sibling stores) made three copies that
 * could drift from the arbiter with no gate to notice. Everything that makes
 * this file a switch — the versioned payload, the temp file plus atomic rename,
 * owner-only modes, "anything unrecognised reads as not set", the short-TTL
 * read cache and the §23 one-shot legacy adoption — is `switch-store.ts`'s.
 * Only the facts that differ are declared here: the file name, the shape
 * version, the absence of a model preference, and the rejection wording.
 *
 * @module dsh-connect-agnes-token-plan/provider-store
 */
import { createSwitchStore, createSwitchParser } from "./switch-store.ts";
import type { StoreOptions } from "./types.ts";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const PROVIDER_VERSION = 1;


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
