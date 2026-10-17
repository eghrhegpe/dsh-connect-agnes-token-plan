/**
 * The draw-tool switch — this plugin's OWN state file, never the Host's
 * configuration.
 *
 * `drawEnabled` in `cordis.patch.yml` is a DEPLOYMENT default the operator
 * edits with a reload, but the panel needs a live switch that takes effect on
 * the next request. So the switch lives in `$DSH_HOME/state/<plugin>/draw.json`
 * — operational state, not an operator decision baked into the patch layer.
 *
 * **Precedence is not stated here on purpose.** "A value saved from the panel
 * wins, an untouched file falls back to the patch's `drawEnabled`" is one rule
 * shared by all four opt-in switches and owned by `switch-precedence.ts`; this
 * header used to restate it, which made three copies that could drift from the
 * arbiter without any gate noticing. What belongs here is only what makes this
 * file its own: the file name, the shape version, the preference's WIRE KEY
 * (which the video switch spells differently, and which a shared parser must
 * never guess at), and the rejection wording. The machinery is
 * `switch-store.ts`'s.
 *
 * The switch and the model preference share one file because they are one
 * operator decision ("how this profile draws"), and a single read keeps them
 * from drifting apart.
 *
 * @module dsh-connect-agnes-token-plan/draw-store
 */
import {
  createSwitchStore,
  createSwitchParser,
  normalizeSwitchEnabled
} from "./switch-store.ts";
import type { StoreOptions } from "./types.ts";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const DRAW_STORE_VERSION = 1;


/**
 * Normalize an on/off switch: only booleans are real answers.
 * @param {unknown} raw - the persisted or posted value.
 * @returns {boolean|null} `true`/`false`, or `null` when nothing usable.
 */
export const normalizeDrawEnabled = normalizeSwitchEnabled;


/**
 * The parser `doctor.ts` reuses, so its read-only survey can never disagree
 * with what this store accepts.
 */
export const parseDrawPayload = createSwitchParser(DRAW_STORE_VERSION, "drawModelId");

/**
 * The file-backed draw switch.
 * @param {object} [options] - see `switch-store.ts`.
 * @returns {object} the store.
 */
export function createFileDrawStore(options: StoreOptions = {}) {
  return createSwitchStore({
    ...options,
    file: "draw.json",
    version: DRAW_STORE_VERSION,
    modelKey: "drawModelId",
    messages: {
      enabled: "draw switch expects a boolean",
      model: "draw model expects a non-empty string or null"
    }
  });
}
