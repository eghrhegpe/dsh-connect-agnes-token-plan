/**
 * The panel's own reading and decision — extracted from the real client.
 *
 * This logic used to be tested through a hand-written copy called
 * `panelDecision`, described in its own comment as "mirrored from PanelPage".
 * A mirror is a promise nobody keeps: the copy tests one thing and the panel
 * runs another, and the two drift silently the moment either side is edited.
 * That drift was not hypothetical here — the mirror had no notion of the
 * throttling fields (`retryAfterMs`, `needsUserAction`), so the greying-out
 * behaviour added to fix the account lockout was never actually covered.
 *
 * `client.js` is a browser bundle that cannot be imported from Node, so this
 * module does not re-implement the panel's logic: it READS it straight out of
 * the shipped client source and evaluates it. If the panel changes, these
 * checks follow automatically — which is the entire point.
 *
 * WARNING: This module locates functions in client.js by exact string matching.
 * If you rename a function, move a block, or reformat client.js, the markers
 * below will silently stop matching. If `moved()` fires, update the marker
 * strings in this file to match the new client.js structure — do NOT delete
 * the failing extraction and replace it with a hand-written copy.
 * @module dsh-connect-sensenova-token-plan/panel-decision
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// This module sits at the plugin root, beside the client it reads.
const CLIENT_PATH = join(dirname(fileURLToPath(import.meta.url)), "client.js");

/** What the panel can render in its empty state. */
export const RENDER = {
  /** Show the account form: the user can fix this themselves. */
  FORM: "AccountForm",
  /** Show the read-only panel body (pools and trend). */
  PANELS: "pools",
  /** Nothing but an explanation — a config error no login can fix. */
  TEXT: "text-only"
};

const source = readFileSync(CLIENT_PATH, "utf8");

/**
 * Fail loudly when the client's structure moves out from under these checks.
 *
 * Silently testing a stale copy is the failure mode this module exists to
 * remove, so an unrecognised shape is an error, never an empty result.
 * @param {string} what - what was being looked for.
 * @returns {never}
 */
function moved(what) {
  throw new Error(
    `could not locate ${what} in client.js. The panel's structure changed; update ` +
      "panel-decision.js to match it, so these checks keep testing the real code " +
      "rather than a copy that has drifted."
  );
}

/**
 * Cut one function declaration out of the client source, braces balanced.
 * @param {string} declaration - the line that starts the function.
 * @returns {string} the function's source.
 */
export function extractFunction(declaration) {
  const start = source.indexOf(declaration);
  if (start === -1) moved(`"${declaration.trim().slice(0, 48)}"`);
  // A destructured signature like `function PoolCard({ pool, tt })` carries a
  // `{` of its own; walking braces from there returns half a header. Balance
  // the parameter list's parentheses first, so the brace walk starts at the
  // body's opening brace.
  let i = source.indexOf("(", start);
  let depth = 0;
  for (; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")" && --depth === 0) {
      i += 1;
      break;
    }
  }
  i = source.indexOf("{", i);
  depth = 0;
  for (; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  moved(`the body of "${declaration.trim()}"`);
}

/**
 * The panel's own reading of a snapshot body, as the browser defines it.
 *
 * @type {(body: unknown) => {data: object|null, error: object|string|null}}
 */
export const interpretSnapshot = new Function(
  `${extractFunction("function interpretSnapshot(body)")} return interpretSnapshot;`
)();

/**
 * The panel's own view model, as the browser defines it.
 *
 * The decision runs as a run of `const` statements in the component, not a
 * function, so it is lifted as a block and wrapped. It ends at `guidance`:
 * everything after that builds React elements, which needs the browser.
 *
 * `tt` and `format` are supplied as identity stubs. The decision is about
 * WHICH dictionary key applies, not the text behind it, and the dictionary
 * does not exist outside the browser.
 * @type {(data: object|null, error: any) => object}
 */
/**
 * Cut one object literal out of the client source, braces balanced.
 * @param {string} declaration - the line that opens the literal.
 * @returns {string} the literal's source, starting at its `{`.
 */
export function extractObjectLiteral(declaration) {
  const start = source.indexOf(declaration);
  if (start === -1) moved(`"${declaration}"`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  moved(`the body of "${declaration}"`);
}

/**
 * Every failure-code literal the panel compares against.
 *
 * `client.js` is a browser bundle and cannot import `codes.js`, so it spells
 * the codes out — a fourth copy of the taxonomy, and the one furthest from
 * the module that produces them. It cannot be deduplicated here, but it can
 * be checked: a code the panel branches on that the Host never sends, or a
 * typo in one, fails the suite instead of quietly never matching.
 *
 * Two shapes are read: comparisons (`failure.code === "…"`) and the keys of
 * the refusal-to-message table (`login_rejected: "auth.badCredentials"`).
 */
export const clientCodeLiterals = Object.freeze([...new Set([
  ...[...source.matchAll(/\bcode\s*(?:===|!==)\s*"([a-z_]+)"/g)].map((match) => match[1]),
  ...[...source.matchAll(/^\s+([a-z_]+):\s*"auth\.[A-Za-z]+"/gm)].map((match) => match[1])
])]);

/**
 * The panel's own dictionaries, as the browser defines them.
 *
 * Lifted from the shipped client for the same reason the decision is: a key
 * added to one language and not the other is invisible in the language that
 * has it, and shows as a raw key in the one that does not. The check that
 * keeps them equal therefore has to read the real dictionaries, not a copy.
 */
export const dictionaries = Object.freeze({
  zh: new Function(`return ${extractObjectLiteral("const zh = {")}`)(),
  en: new Function(`return ${extractObjectLiteral("const en = {")}`)()
});

export const decidePanelView = new Function(
  "tt",
  "format",
  (() => {
    const start = source.indexOf("const failure = error === null");
    const endMarker = ": tt(guidanceKey);";
    const end = source.indexOf(endMarker);
    if (start === -1 || end === -1 || end < start) moved("the panel decision");
    const block = source.slice(start, end + endMarker.length);
    return `return (data, error) => { ${block}
      return {
        failure, auth, needsSetup, guidanceKey,
        render: needsSetup ? "AccountForm" : (data === null ? "text-only" : "pools"),
        canManageAccount: auth !== null && auth.hasAccount === true,
        coolingMs: typeof auth?.retryAfterMs === "number" && auth.retryAfterMs > 0 ? auth.retryAfterMs : null,
        needsUserAction: auth?.needsUserAction === true
      };
    };`;
  })()
)((key) => key, (template) => template);
