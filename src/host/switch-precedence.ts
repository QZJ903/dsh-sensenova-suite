/**
 * The single adjudicator for "panel-saved value vs config default" across
 * every opt-in switch.
 *
 * Historically the rule was hand-copied at three call sites (the provider
 * route, the models route, the draw route) in two look-alike dialects:
 *
 *   - the boolean switch: `(panel ?? config) === true` plus
 *     `panel === null ? "config" : "panel"`;
 *   - the model preference: `panel ?? config` plus the same source probe.
 *
 * This module is peer-free and deliberately tiny: the whole point is that a
 * switch can never again invent its own precedence dialect, and the source
 * label (`panel` / `config`) always rides with the answer so the panel can
 * say which side is in charge. `test/switch-precedence.test.mjs` pins the
 * dialect so a new caller copying the shape is the odd one out.
 *
 * One switch HAD no config default: the Raccoon provider switch, removed with
 * the second upstream in the 2026-10 consolidation. While it lived, a profile
 * without a saved value fell to `off` with nothing to fall back on — no
 * precedence to adjudicate — so it was served by {@link resolveSwitchOff} (a
 * bare `panel === true`) rather than the default dialect above. Every switch
 * alive today has a config default (the panel tool switches adjudicate in
 * pool-store's `effectiveToolEnabled`, panel-first tri-state), so
 * `resolveSwitchOff` currently has no production caller; it stays as the named
 * primitive for the day a default-less switch returns, with
 * `test/switch-precedence.test.mjs` pinning its dialect.
 *
 * @module dsh-sensenova-suite/switch-precedence
 */

/**
 * Resolve the effective boolean switch: a panel-saved value always wins,
 * otherwise the config default rules.
 * @param {boolean|null} panel - the panel-saved value (`null` = never saved).
 * @param {boolean} config - the patch-declared default.
 * @returns {boolean} the effective switch.
 */
export function resolveSwitchEnabled(panel: boolean | null, config: boolean): boolean {
  return (panel ?? config) === true;
}

/**
 * Resolve a boolean switch that has NO config default: a saved `true` turns
 * it on, and any other value — including a never-saved `null` — leaves it
 * off. There is no config fallback to consult, so the caller must not pass
 * one; use {@link resolveSwitchEnabled} when a config default exists. The
 * Raccoon provider switch was the only such caller and left with the 2026-10
 * consolidation, so this currently has no production use — it stays as the
 * named primitive (dialect pinned by `test/switch-precedence.test.mjs`) for
 * the day a default-less switch returns. Keeping this as its own named call
 * (instead of a bare `panelValue === true`) is what makes "this switch has no
 * default" a fact in the API surface rather than a comment the next author
 * has to remember.
 * @param {boolean|null} panel - the panel-saved value (`null` = never saved).
 * @returns {boolean} the effective switch.
 */
export function resolveSwitchOff(panel: boolean | null): boolean {
  return panel === true;
}

/**
 * Resolve the effective string preference (e.g. a draw-model id): a
 * panel-saved value wins, otherwise the config default rules.
 * @param {string|null} panel - the panel-saved value (`null` = never saved).
 * @param {string|undefined} config - the patch-declared default.
 * @returns {string|undefined} the effective preference.
 */
export function resolveSwitchValue(panel: string | null, config: string | undefined): string | undefined {
  return panel ?? config;
}

/**
 * Where the effective value came from — the panel when it saved one, the
 * config otherwise. Rides with every resolved answer so the panel can name
 * the side in charge.
 * @param {boolean|string|null} panel - the panel-saved value.
 * @returns {"panel"|"config"}
 */
export function switchSource(panel: boolean | string | null): "panel" | "config" {
  return panel === null ? "config" : "panel";
}
