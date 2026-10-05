// @ts-check
/**
 * The panel's own reading and decision — the real module, not a copy.
 *
 * This logic used to be tested through a hand-written copy called
 * `panelDecision`, described in its own comment as "mirrored from PanelPage".
 * A mirror is a promise nobody keeps: the copy tests one thing and the panel
 * runs another, and the two drift silently the moment either side is edited.
 * That drift was not hypothetical here — the mirror had no notion of the
 * throttling fields (`retryAfterMs`, `needsUserAction`), so the greying-out
 * behaviour added to fix the account lockout was never actually covered.
 *
 * The second attempt cut the logic out of `client.js`'s source with
 * balanced-brace walks and evaluated the snippets with `new Function`. Better
 * than a mirror — but its anchors were the client's FORMATTING: a renamed
 * variable or a moved brace broke the checks for reasons unrelated to
 * behaviour, and the module was quietly a mini-compiler over text.
 *
 * This version loads `client.js` as a module (`client-surface.js`) and calls
 * the functions the browser itself calls. There is no anchor to maintain: if
 * the panel changes, these checks follow automatically — which is the entire
 * point. The exported names are unchanged, so the suites that consume them
 * did not have to change with the mechanism.
 * @module dsh-connect-agnes-token-plan/panel-decision
 */

import { surface } from "./client-surface.js";
// The rule itself, taken from the module the browser runs. `snapshot.ts` is a
// PURE module under ADR-006 (it imports only the `runtime.ts` TYPE, erased at
// compile time), so Node imports and calls it directly — no bundle scraping,
// no re-declaration. When `panel-page.ts` stops calling this function, the
// change is one edit in one place and the next check below says so.
import { shouldShowAccountManagement, servedWaitMs } from "../src/client/snapshot.ts";

/** What the panel can render in its empty state. */
export const RENDER = {
  /**
   * The account is the next action: the user can fix this themselves.
   *
   * With NO snapshot the quota tab IS the form. With a degraded snapshot — a
   * console nobody signed in to, which arrives as `ok:true` with
   * `quota.consoleConnected:false` — the tab renders whatever did arrive (the
   * public plan catalogue) and auto-expands the account card instead. Same
   * verdict, different layout; `data === null` is what tells them apart.
   */
  FORM: "AccountForm",
  /** Show the read-only panel body (pools and trend). */
  PANELS: "pools",
  /** Nothing but an explanation — a config error no login can fix. */
  TEXT: "text-only"
};

/**
 * The panel's own reading of a snapshot body, as the browser defines it.
 * The signature lives on `PanelSurface` so it stays in one place with the
 * surface it describes.
 */
export const interpretSnapshot = surface.interpretSnapshot;

/**
 * The panel's own decision function, as the browser defines it. Returns a
 * `PanelView` (see `client-surface.js`): the shape these checks assert on.
 */
export const viewOf = surface.viewOf;

/**
 * The AgnesCode tab's own rendering decision, as the browser defines it.
 *
 * That tab reads its own route on its own cadence, so it does not go through
 * `decidePanelView` — but its decision is the same kind of thing: a pure
 * function of (last body, last error) that says what the tab shows. Exposed
 * here rather than driven through a rendered tree because the three answers it
 * gives were each a real repair (see the function), and a repair that is only
 * described in a comment is one refactor away from being undone.
 */
export const agnescodeView = surface.agnescodeView;

/**
 * The panel's dictionaries, as the browser defines them.
 *
 * Exposed rather than re-declared for the same reason as the decision: a key
 * added to one language and not the other is invisible in the language that
 * has it, and shows as a raw key in the one that does not — so the equality
 * check has to read the real dictionaries.
 */
export const dictionaries = Object.freeze(surface.dictionaries);

/**
 * The failure-code tables the client branches on, as the browser defines
 * them. `test/panel.test.mjs` pins them against `codes.js`: every key must be
 * a declared wire code, the form-excluded set must equal `NO_LOGIN_CODES`,
 * and every credential refusal must carry a line of text.
 */
export const tables = Object.freeze(surface.tables);

/** `tt`/`format` stand-ins: the decision is about WHICH key applies. */
const identity = (value) => value;

/**
 * The panel's view model for one snapshot, evaluated exactly as the browser
 * evaluates it.
 *
 * `tt` and `format` are identity here: the decision is about which dictionary
 * key applies, not the text behind it, and the dictionary is exercised
 * separately through {@link dictionaries}.
 *
 * @param {import("./client-surface.js").SnapshotLike | null} data - the snapshot, or null when none was read.
 * @param {object|string|null} error - a transport string or a structured failure.
 * @returns {{failure: object|null, auth: import("./client-surface.js").PanelView["auth"],
 *   needsSetup: boolean, guidanceKey: string|null, guidance: string|null, render: string,
 *   consoleConnected: boolean|null, canManageAccount: boolean,
 *   coolingMs: number|null, needsUserAction: boolean}}
 */
export function decidePanelView(data, error) {
  const view = viewOf(data, error, identity);
  // The single source is IMPORTED, not restated. This line used to read
  // "Import the single-source decision from snapshot.ts to avoid duplicate
  // derivation" and then declare `(auth) => auth !== null` right underneath —
  // a comment claiming exactly the opposite of what the next line does, while
  // `snapshot.ts`'s own doc said callers must use the exported function rather
  // than duplicating that expression. ADR-006 records this residue; the fix is
  // the import, because ADR-006's judgement 1 is that a pure rule module must
  // be callable from Node directly (PITFALLS §42).
  //
  // `coolingMs` is the SECOND field that residue named, and it was the one that
  // could disagree: it used to re-derive "is a wait in force" as
  // `typeof retryAfterMs === "number" && > 0`, which ignores the parked flag,
  // while `servedWaitUntil` — the function `AccountForm` actually obeys —
  // counts nothing for a parked refusal. One auth block, two verdicts. It now
  // reads `servedWaitMs`, so "is anything pending" has one implementation.
  //
  // The three fields below are NOT residues and stay as they are. `render` is a
  // three-state coarsening for assertions — `PanelPage` gates on
  // `needsSetup && loadedOnce`, a first-frame state this view model has no
  // notion of — so the two are structurally different questions rather than two
  // copies of one. `consoleConnected` is a field read, not a verdict: the three
  // places that branch on it (`panel-page.ts:298` / `:404`, `snapshot.ts:261`)
  // each mean something different by it. ADR-006's "same source, written
  // twice" list over-reached on those two, and its residual note now says so.
  return {
    failure: view.failure,
    auth: view.auth,
    needsSetup: view.needsSetup,
    guidanceKey: view.guidanceKey,
    guidance: view.guidance,
    render: view.needsSetup ? RENDER.FORM : (data === null ? RENDER.TEXT : RENDER.PANELS),
    consoleConnected: data?.quota?.consoleConnected ?? null,
    canManageAccount: shouldShowAccountManagement(view.auth),
    coolingMs: servedWaitMs(view.auth ?? null),
    needsUserAction: view.auth?.needsUserAction === true
  };
}
