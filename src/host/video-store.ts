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
 * the next request. So the switch lives in `$DSH_HOME/state/<plugin>/video.json`
 * — operational state, not an operator decision baked into the patch layer.
 *
 * **Precedence is not stated here on purpose** (see `draw-store.ts`): it is one
 * rule for all four opt-in switches, owned by `switch-precedence.ts`. What
 * belongs here is the WIRE KEY, the one that matters: this file spells the
 * preference `videoModelId`, the draw file spells it `drawModelId`, and a
 * parser that guessed would answer "no preference" for a file that plainly has
 * one — silently. The rest of the machinery is `switch-store.ts`'s.
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
