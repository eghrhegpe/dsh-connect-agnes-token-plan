/**
 * The draw-tool switch — this plugin's OWN state file, never the Host's
 * configuration.
 *
 * `drawEnabled` in `cordis.patch.yml` is a DEPLOYMENT default the operator
 * edits with a reload, but the panel needs a live switch that takes effect on
 * the next request. The state lives in `$DSH_HOME/state/<plugin>/draw.json`,
 * exactly like the video switch, the provider switch and the catalog:
 * operational state, not an operator decision baked into the patch layer.
 *
 * Precedence at read time:
 *
 *   1. a value SAVED FROM THE PANEL (enabled: true|false) always wins;
 *   2. no saved value (never touched, or the file was unreadable) falls back
 *      to the patch's `drawEnabled` — so an operator who enabled drawing
 *      through configuration keeps it enabled across this change.
 *
 * The switch and the model preference share one file because they are one
 * operator decision ("how this profile draws"), and a single read keeps them
 * from drifting apart.
 *
 * The write / read / adoption machinery is shared with the other three opt-in
 * switches in `switch-store.ts`; what is declared here is only the file name,
 * the shape version, the preference's WIRE KEY (which the video switch spells
 * differently, and which a shared parser must never guess at), and the
 * rejection wording.
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
