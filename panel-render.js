/**
 * The panel's own rendering, evaluated without a browser.
 *
 * `panel-decision.js` closes the mirror on WHAT the panel shows; this module
 * closes it on HOW the numbers reach the screen. The known gap was real: a
 * `PoolCard` that rendered `used/limit` as `limit/used`, or dropped the
 * remaining figure, still passed every check — the decision tests assert
 * which view renders, not what that view says.
 *
 * The three components (`QuotaCard`, `PoolCard`, `TrendTable`) are hook-free
 * plain functions, so they run unchanged in Node once the shipped bundle is
 * materialized by `client-surface.js`: they come pre-wired to the recording
 * `h`, with every closure dependency (`S`, `count`, `clock`, `clockLong`,
 * `format`) the same definitions the browser closes over. Nothing is lifted
 * from source text, so there is no structure for the checks to lose track of.
 *
 * `AccountForm` is deliberately not exercised: it is built on `useState` and
 * friends, and faking the hook contract would test the fake. It stays a
 * documented gap rather than a pretended one.
 * @module dsh-connect-sensenova-token-plan/panel-render
 */

import { surface } from "./client-surface.js";

/** The client's real style tokens, as the browser defines them. */
export const styles = surface.styles;

/**
 * The panel's real rendering components.
 *
 * `tt` stays a per-call argument (the components take it as a prop), so the
 * same components serve any dictionary — the tests pass an identity `tt` and
 * assert on dictionary KEYS, which is what decides the text, not the text
 * behind it.
 * @type {{QuotaCard: Function, PoolCard: Function, TrendTable: Function}}
 */
export const render = surface.components;

/**
 * Expand a rendered element tree to plain text, calling function components
 * as React would.
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
