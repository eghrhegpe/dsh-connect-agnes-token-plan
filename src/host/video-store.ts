/**
 * The video-tool switch — this plugin's OWN state file, never the Host's
 * configuration.
 *
 * A deliberate sibling of `draw-store.ts`, and separate from it on purpose: the
 * two tools are independent opt-ins. Wanting image generation without video (or
 * the reverse) is an ordinary preference, and one shared switch would force
 * both on together.
 *
 * `videoEnabled` in `cordis.patch.yml` is a DEPLOYMENT default the operator
 * edits with a reload, but the panel needs a live switch that takes effect on
 * the next request. The state lives in `$DSH_HOME/state/<plugin>/video.json`,
 * exactly like the draw switch, the provider switch and the catalog:
 * operational state, not an operator decision baked into the patch layer.
 *
 * Precedence at read time:
 *
 *   1. a value SAVED FROM THE PANEL (enabled: true|false) always wins;
 *   2. no saved value (never touched, or the file was unreadable) falls back
 *      to the patch's `videoEnabled`.
 *
 * Everything but the facts below is shared with the other three opt-in switches
 * in `switch-store.ts`. The WIRE KEY is the one that matters: this file spells
 * the preference `videoModelId`, the draw file spells it `drawModelId`, and a
 * parser that guessed would answer "no preference" for a file that plainly has
 * one — silently.
 *
 * @module dsh-connect-agnes-token-plan/video-store
 */
import {
  createSwitchStore,
  createSwitchParser
} from "./switch-store.ts";
import type { StoreOptions } from "./types.ts";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const VIDEO_STORE_VERSION = 1;




/**
 * The parser `doctor.ts` reuses, so its read-only survey can never disagree
 * with what this store accepts.
 */
export const parseVideoPayload = createSwitchParser(VIDEO_STORE_VERSION, "videoModelId");

/**
 * The file-backed video switch.
 * @param {object} [options] - see `switch-store.ts`.
 * @returns {object} the store.
 */
export function createFileVideoStore(options: StoreOptions = {}) {
  return createSwitchStore({
    ...options,
    file: "video.json",
    version: VIDEO_STORE_VERSION,
    modelKey: "videoModelId",
    messages: {
      enabled: "video switch expects a boolean",
      model: "video model expects a non-empty string or null"
    }
  });
}
