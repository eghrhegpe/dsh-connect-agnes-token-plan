/**
 * dsh-connect-agnes-token-plan — Client half (entry).
 *
 * Registers a config card inside the Plugins page (`plugins.bundle.config`
 * slot). The card renders the Agnes Token Plan quota — the current plan's four
 * rate-limit windows (requests per 5 h / per week, images per day, video per
 * day), the account's cumulative usage, and the per-bucket usage chart — plus
 * the three-tab layout (quota / api / agnescode). The data comes from
 * the Host's read-only snapshot route, polled only while the card is mounted —
 * the Client folds no session events of its own.
 *
 * The sources live in `src/client/*.ts` and are bundled into the root
 * `client.js` artifact by tsdown (IIFE, see `tsdown.config.mjs`); the tests
 * load the ARTIFACT, so what they exercise is what the browser runs.
 * @module dsh-connect-agnes-token-plan/client
 */

/**
 * The factory body, shared by the browser and by Node.
 *
 * It is deliberately dependency-free apart from `react` (which the loader
 * hands in): the browser module table resolves package names only. The
 * parameter is `loaderRequire`, not `require`, so no bundler mistakes the
 * call for module-system syntax — see `runtime.ts`.
 *
 * The Node-side test suites run this exact factory with a stand-in React
 * (`client-surface.js`), so the definitions it sees — the decision, the
 * tables, the style tokens, the components — are the ones the browser runs,
 * not a copy.
 *
 * @param loaderRequire - the loader's require; hands out `react`.
 * @returns {{inject: string[], apply: Function, panel: object}}
 */
import { inject, apply } from "./apply.ts";
import { PANEL_ID } from "./const.ts";
import {
  CLIENT_CODE,
  COOLDOWN_TEXT,
  errorOfStatus,
  FORM_EXCLUDED_CODES,
  GUIDANCE_BY_CODE,
  interpretSnapshot,
  REFUSAL_TEXT,
  viewOf
} from "./snapshot.ts";
import {
  allowListFor,
  bulkModelsIn,
  HIDE_ALL_MODELS,
  modelIsOn,
  rosterMatches,
  setAllModelsIn,
  toggleModelIn
} from "./models.ts";
import { clock, clockLong, count, format, tokenSize } from "./format.ts";
import { provideClientReact } from "./runtime.ts";
import { en, zh } from "./i18n.ts";
import { S } from "./styles.ts";
import {
  AccountForm
} from "./account-form.ts";
import {
  PlanCard,
  CatalogueCard,
  QuotaWindowCard,
  SectionCard,
  UsageChart,
  UsageTotals
} from "./cards.ts";
import { ProviderStatus, ProviderRegStatus, ProviderSwitch, DrawSwitch, VideoSwitch, RpmNote } from "./provider-controls.ts";
import { ApiKeyForm, ProviderForm } from "./api-key-form.ts";
import { ModelPicker, ModelRoster } from "./model-picker.ts";
import { PanelPage, barPlan } from "./panel-page.ts";
import { AgnescodeModelPicker, AgnescodeRoster, AgnescodeTab } from "./agnescode-tab.ts";

function clientFactory(loaderRequire: (specifier: string) => unknown): {
  inject: string[];
  apply: typeof apply;
  panel: object;
} {
  provideClientReact(loaderRequire("react"));

  /**
   * The module's test surface.
   *
   * The Host only ever reads `inject`/`apply`; this object exists so the
   * Node-side suites can load the shipped bundle as a module and exercise
   * these REAL definitions — the decision, the dictionaries, the style
   * tokens, the components — instead of scraping the source text for them.
   * Everything here is what the browser itself uses; nothing is defined for
   * the tests' benefit.
   */
  const panel = Object.freeze({
    interpretSnapshot,
    viewOf,
    errorOfStatus,
    // What the pinned bar may say about the visible tab: the shell decision,
    // exposed for the same reason as the others — the suite drives the real
    // function instead of scraping the layout for it.
    barPlan,
    dictionaries: Object.freeze({ zh, en }),
    tables: Object.freeze({ GUIDANCE_BY_CODE, FORM_EXCLUDED_CODES, REFUSAL_TEXT, CLIENT_CODE, COOLDOWN_TEXT }),
    styles: S,
    helpers: Object.freeze({
      clock,
      clockLong,
      count,
      format,
      tokenSize,
      HIDE_ALL_MODELS,
      modelIsOn,
      rosterMatches,
      allowListFor,
      toggleModelIn,
      setAllModelsIn,
      bulkModelsIn
    }),
    components: Object.freeze({
      PlanCard,
      CatalogueCard,
      QuotaWindowCard,
      UsageTotals,
      UsageChart,
      SectionCard,
      AccountForm,
      ApiKeyForm,
      ProviderForm,
      ProviderStatus,
      ProviderRegStatus,
      ProviderSwitch,
      DrawSwitch,
      VideoSwitch,
      // The API tab's closing RPM note: the one number the panel states but
      // cannot measure, so the render suite reads it back against the official
      // FAQ rather than trusting the transcription.
      RpmNote,
      ModelRoster,
      ModelPicker,
      PanelPage,
      AgnescodeTab,
      AgnescodeRoster,
      // The AgnesCode roster's edit affordances. Exported so the render suite
      // can mount them: both pickers now share `roster-draft.ts`, and that
      // sharing is only safe while both halves are actually drawn somewhere.
      AgnescodeModelPicker
    })
  });

  return { inject, apply, panel };
}

/** The registration the Host loads: id plus the factory the Host materializes. */
const REGISTRATION = { id: PANEL_ID, factory: clientFactory };

// The bundle must load in three module worlds (the IIFE wrapper keeps the
// top level free of import/export, so all three see the same statements):
//
// - BROWSER: the DSH client loader calls `window.__ModuleLoader__.load(...)`
//   with this file's text; the registry it gets back is the one the Host
//   materializes with the browser's own module table (real React).
// - NODE CJS: a `require("./client.ts")` gets the same registration object on
//   `module.exports`, so the suite can hand a stand-in React to `factory`.
// - NODE ESM: `import("./client.ts")` — the artifact carries no `import`/
//   `export` statements, so it is legal ESM; `module` is undefined there, and
//   `client-surface.js` installs a capturing `window.__ModuleLoader__` BEFORE
//   the import, which is what runs this branch.
//
// In every world the SAME `clientFactory` is what the panel runs, so the Node
// suites exercise the browser's own decision, tables, and components — never a
// copy and never a scrape of this source text.
if (typeof window !== "undefined") {
  // The module table is shell-attached, so the DOM lib does not declare it.
  // Asserted once here — the same face `client-surface.js` installs before it
  // imports this bundle in Node.
  const loader = (window as Window & typeof globalThis & { __ModuleLoader__?: { load: (registration: object) => void } }).__ModuleLoader__;
  if (loader !== undefined) loader.load(REGISTRATION);
}
if (typeof module !== "undefined" && module !== null && module.exports !== undefined) {
  module.exports = REGISTRATION;
}
