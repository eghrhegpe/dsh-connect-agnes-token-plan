/**
 * The INTL provider-registration switch — the sixth opt-in switch (ADR-021),
 * the INTERNATIONAL row's twin of `provider-store.ts`.
 *
 * Same shape as its CN sibling, one site apart: a plain on/off switch with no
 * model preference, its own state file (`intl-provider.json`) so flipping one
 * site's switch can never write the other site's publish decision, and the
 * same "panel-saved value beats the patch default" arbitration — the patch
 * default is `registerProviderIntl` (off by default), which makes this a
 * dialect-A switch (`switch-precedence.ts`): an untouched file falls back to
 * the patch key, so a panel-saved ON can be retired by deleting the row and a
 * panel-saved OFF can override a patch row that says on.
 *
 * @module dsh-connect-agnes-token-plan/intl-provider-store
 */
import { createSwitchStore, createSwitchParser } from "./switch-store.ts";
import type { StoreOptions } from "./types.ts";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const INTL_PROVIDER_VERSION = 1;

/**
 * The parser `doctor.ts` reuses, so its read-only survey can never disagree
 * with what this store accepts.
 */
export const parseIntlProviderPayload = createSwitchParser(INTL_PROVIDER_VERSION, null);

/**
 * The file-backed INTL provider switch.
 * @param {object} [options] - see `switch-store.ts`.
 * @returns {object} the store.
 */
export function createFileIntlProviderStore(options: StoreOptions = {}) {
  const base = createSwitchStore({
    ...options,
    file: "intl-provider.json",
    version: INTL_PROVIDER_VERSION,
    modelKey: null,
    messages: { enabled: "intl provider switch expects a boolean" }
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
