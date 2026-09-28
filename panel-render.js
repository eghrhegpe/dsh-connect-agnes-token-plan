/**
 * The panel's own rendering, evaluated without a browser.
 *
 * `panel-decision.js` closes the mirror on WHAT the panel shows; this module
 * closes it on HOW the numbers reach the screen. The known gap was real: a
 * `PoolCard` that rendered `used/limit` as `limit/used`, or dropped the
 * remaining figure, still passed every check — the decision tests assert
 * which view renders, not what that view says.
 *
 * These three components (`WindowRow`, `PoolCard`, `TrendTable`) are plain
 * functions with no hooks, so the same lift-and-evaluate move works: their
 * source is cut out of the shipped `client.js` and evaluated in Node against
 * a recording `h`, with every closure dependency (`S`, `count`, `clock`,
 * `clockLong`, `format`) likewise lifted from the client rather than
 * re-implemented here. If the panel's rendering changes, these checks follow;
 * if the structure moves out from under the markers, this module throws.
 *
 * `AccountForm` is deliberately not lifted: it is built on `useState` and
 * friends, and faking the hook contract would test the fake. It stays a
 * documented gap rather than a pretended one.
 * @module dsh-connect-sensenova-token-plan/panel-render
 */

import {
  extractFunction,
  extractObjectLiteral
} from "./panel-decision.js";

/**
 * A recording stand-in for the client's `h`: plain objects instead of React
 * elements, function components left UNCALLED (exactly how React receives
 * them), so a check can expand the tree itself and see the real structure.
 * @type {typeof import("./client.js").h}
 */
const h = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children: children.length === 1 && Array.isArray(children[0]) ? children[0] : children
});

/** The client's real style tokens, lifted verbatim. */
const S = new Function(`return ${extractObjectLiteral("const S = {")}`)();

/** The lifted style tokens, exported so checks can reference the real values. */
export const styles = S;

/** The client's real helpers, lifted verbatim — not re-implemented here. */
const helpers = new Function(
  `${extractFunction("function clock(epoch)")}
   ${extractFunction("function clockLong(epoch)")}
   ${extractFunction("function count(value)")}
   ${extractFunction("function format(template, vars)")}
   return { clock, clockLong, count, format };`
)();

/**
 * The panel's real rendering components, in one factory.
 *
 * `tt` stays a per-call argument (the components take it as a prop), so the
 * same lifted source serves any dictionary — the tests pass an identity `tt`
 * and assert on dictionary KEYS, which is what decides the text, not the
 * text behind it.
 * @type {{WindowRow: Function, PoolCard: Function, TrendTable: Function}}
 */
export const render = new Function(
  "h", "S", "clock", "clockLong", "count", "format",
  `${extractFunction("function WindowRow({ label, window, tt })")}
   ${extractFunction("function PoolCard({ pool, tt })")}
   ${extractFunction("function TrendTable({ trend, tt })")}
   return { WindowRow, PoolCard, TrendTable };`
)(h, S, helpers.clock, helpers.clockLong, helpers.count, helpers.format);

/**
 * Expand a lifted element tree to plain text, calling function components as
 * React would.
 * @param {unknown} node - an element, array, primitive, or null.
 * @returns {string[]} every string the render would put on screen.
 */
export function texts(node) {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  if (typeof node.type === "function") return texts(node.type(node.props));
  return texts(node.children);
}

/**
 * Depth-first search for one element by a props predicate.
 * @param {unknown} node - the tree to search.
 * @param {(props: object) => boolean} match - applied to every element.
 * @returns {object|null} the first matching element, or null.
 */
export function findElement(node, match) {
  if (node === null || node === undefined || typeof node !== "object" || Array.isArray(node)) {
    return null;
  }
  if (typeof node.type === "function") return findElement(node.type(node.props), match);
  if (node.props !== undefined && match(node.props)) return node;
  for (const child of [].concat(node.children ?? [])) {
    const hit = findElement(child, match);
    if (hit !== null) return hit;
  }
  return null;
}
