/**
 * The international-site provider-registration switch — the AGNESCODE dual
 * provider's sixth+ option row (ADR-023), the per-domain twin of
 * `agnescode-switch-store.ts` and the INTL provider's `intl-provider-store.ts`.
 *
 * Same shape as both siblings: a plain on/off switch with no model
 * preference, its own state file (`agnescode-intl-provider.json`) so flipping
 * one site's switch can never write the other's publish decision, and the same
 * "panel-saved value beats the patch default" arbitration. The patch default is
 * the plugin-wide `registerProvider`? — no: the AgnesCode sites share ONE
 * registration switch on the panel (`agnescode-provider.json`); a SECOND
 * site row would need a patch-level per-site default, which the current
 * `cordis.patch.yml` does not carry. So this file mirrors the CN switch byte-for-
 * byte and is used ONLY by the `agnescode-intl` publisher's panel switch.
 *
 * To keep the two sites' decisions isolated without a second patch key, the
 * intl switch's file is its own state file and the `agnescode-switch-store.ts`
 * factory is reused with a different `file` name + version; the panel's
 * `/agnescode` tab and the publisher read the same file by site, so a flip
 * on the CN row never touches the intl row's answer.
 *
 * @module dsh-connect-agnes-token-plan/agnescode-intl-provider-store
 */
import { createSwitchStore, createSwitchParser } from "./switch-store.ts";
import type { StoreOptions } from "./types.ts";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const AGNESCODE_INTL_PROVIDER_VERSION = 1;

/**
 * The parser `doctor.ts` reuses, so its read-only survey can never disagree
 * with what this store accepts.
 */
export const parseAgnescodeIntlProviderPayload = createSwitchParser(AGNESCODE_INTL_PROVIDER_VERSION, null);

/**
 * The file-backed international-site provider switch (ADR-023).
 * @param {object} [options] - see `switch-store.ts`.
 * @returns {object} the store.
 */
export function createFileAgnescodeIntlProviderStore(options: StoreOptions = {}) {
  const base = createSwitchStore({
    ...options,
    file: "agnescode-intl-provider.json",
    version: AGNESCODE_INTL_PROVIDER_VERSION,
    modelKey: null,
    messages: { enabled: "the agnescode intl provider switch expects a boolean" }
  });
  // A plain on/off switch: no model preference is offered, so the two
  // preference calls are not part of this store's surface at all.
  return {
    enabled: base.enabled,
    isSet: base.isSet,
    save: base.save,
    forget: base.forget
  };
}
