// @ts-check
/**
 * The panel's own rendering, evaluated without a browser.
 *
 * `panel-decision.js` closes the mirror on WHAT the panel shows; this module
 * closes it on HOW the numbers reach the screen. The known gap was real: a
 * `PoolCard` that rendered `used/limit` as `limit/used`, or dropped the
 * remaining figure, still passed every check — the decision tests assert
 * which view renders, not what that view says.
 *
 * The four hook-free components (`QuotaCard`, `PoolCard`, `TrendTable`,
 * `SectionCard`) are plain functions, so they run unchanged in Node once the
 * shipped bundle is materialized by `client-surface.js`: they come pre-wired
 * to the recording `h`, with every closure dependency (`S`, `count`, `clock`,
 * `clockLong`, `format`) the same definitions the browser closes over.
 * Nothing is lifted from source text, so there is no structure for the checks
 * to lose track of.
 *
 * `AccountForm` is deliberately not exercised: it is built on `useState` and
 * friends, and faking the hook contract would test the fake. It stays a
 * documented gap rather than a pretended one.
 * @module dsh-sensenova-suite/panel-render
 */

import { surface } from "./client-surface.js";

/**
 * A recording element as the client's `h` produces it: a plain object with an
 * optional `type` (component function or tag string), optional `props`, and
 * children that may be another element, an array of them, a primitive, or
 * absent. The render walkers below receive arbitrary trees, so the shape is
 * deliberately loose — presence is checked at runtime, not asserted here.
 * @typedef {object} VNode
 * @property {Function|string} [type] - component function or tag string.
 * @property {object} [props]
 * @property {unknown} [children]
 */

/** The client's real style tokens, as the browser defines them. */
export const styles = surface.styles;

/**
 * The panel's real rendering components.
 *
 * `tt` stays a per-call argument (the components take it as a prop), so the
 * same components serve any dictionary — the tests pass an identity `tt` and
 * assert on dictionary KEYS, which is what decides the text, not the text
 * behind it.
 * @type {{QuotaCard: Function, PoolCard: Function, TrendTable: Function, SectionCard: Function}}
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
  const el = /** @type {VNode} */ (node);
  if (typeof el.type === "function") return texts(el.type(el.props));
  return texts(el.children);
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
  const el = /** @type {VNode} */ (node);
  if (typeof el.type === "function") return findElement(el.type(el.props), match);
  if (el.props !== undefined && match(el.props)) return node;
  // The recording `h` keeps a `.map()` result as a nested array child; flatten
  // children so the walker actually descends into rendered row lists.
  for (const child of /** @type {unknown[]} */ (Array.isArray(el.children) ? el.children.flat(Infinity) : (el.children ?? []))) {
    const hit = findElement(child, match);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * Depth-first search for EVERY element matching a props predicate, in tree
 * order (the sibling to {@link findElement} for rows of repeated elements).
 * @param {unknown} node - the tree to search.
 * @param {(props: object) => boolean} match - applied to every element.
 * @param {object[]} [out] - accumulator; the returned array.
 * @returns {object[]} every matching element, in tree order.
 */
export function findAll(node, match, out = []) {
  if (node === null || node === undefined || typeof node !== "object" || Array.isArray(node)) {
    return out;
  }
  const el = /** @type {VNode} */ (node);
  if (typeof el.type === "function") {
    findAll(el.type(el.props), match, out);
    return out;
  }
  if (el.props !== undefined && match(el.props)) out.push(node);
  for (const child of /** @type {unknown[]} */ (Array.isArray(el.children) ? el.children.flat(Infinity) : (el.children ?? []))) {
    findAll(child, match, out);
  }
  return out;
}
