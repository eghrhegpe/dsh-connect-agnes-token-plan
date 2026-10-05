/**
 * The one place that decides "which value is in charge" for an opt-in switch.
 *
 * Every opt-in in this plugin answers the same question from two places — the
 * value the operator saved in the panel (`switch-store`) and the value the
 * patch declares (`Settings`) — and every consumer needs not just the answer
 * but also WHERE it came from, because the panel prints that as "面板 / 配置"
 * and an answer without its source is a line the operator cannot act on.
 *
 * That question was previously re-answered at eleven call sites, in two
 * dialects that look alike and mean different things:
 *
 *   A. `(panel ?? settings.x) === true`  — 有配置默认（provider / draw / video）
 *   B. `panel === true`                  — 无配置默认（agnescode：它根本没有
 *                                          配置默认值，面板说关就是关）
 *
 * The two are easy to confuse by eye, and confusing them is not cosmetic:
 * reading B as A would make AgnesCode register itself whenever the patch's
 * (nonexistent) default happened to be truthy. So both live here, as one
 * function whose `configDefault` argument carries the distinction — B is A
 * with no default, not a separate rule.
 *
 * SCOPE: exactly the four opt-ins that have BOTH halves — a panel-saved value
 * in a `switch-store` file AND a patch default (provider / draw / video /
 * AgnesCode). A fifth opt-in, `writeImageModelIds`, is deliberately NOT here:
 * it has one source (the patch row), no panel affordance, no state file and no
 * route, so it has nothing to arbitrate. `CONFIG_DEFAULTS.writeImageModelIds`
 * carries the reasoning; a fifth entry in that list of four would be a false
 * claim about a `write-image-model-ids.json` that does not exist.
 *
 * @module dsh-connect-agnes-token-plan/switch-precedence
 */

/** Where an effective switch value came from. The panel prints these verbatim. */
export const SWITCH_SOURCE = {
  /** The operator saved a value in the panel; it wins. */
  PANEL: "panel",
  /** Nothing is saved, so the patch's declared default is in charge. */
  CONFIG: "config",
  /** Nothing is saved and this switch has no config default — it is simply off. */
  OFF: "off"
};

/**
 * Resolve the effective value of a boolean switch.
 *
 * @param {boolean|null|undefined} panelValue - the panel-saved value
 *   (`null` / `undefined` = the operator has not set it).
 * @param {boolean|undefined} configDefault - the patch's default. Pass
 *   `undefined` for a switch that has NO config default (AgnesCode): then an
 *   unset panel value resolves to `off`, never to a value nobody declared.
 * @returns {{enabled: boolean, source: string}} the effective value and
 *   where it came from — both, because a value without its source is an
 *   unactionable line on the panel.
 */
export function resolveSwitchEnabled(panelValue: boolean | null | undefined, configDefault?: boolean) {
  if (typeof panelValue === "boolean") {
    return { enabled: panelValue === true, source: SWITCH_SOURCE.PANEL };
  }
  // Not set in the panel. A switch with no config default is off — the
  // alternative (`false`) reads identically here but would silently acquire a
  // default the moment someone adds one to the patch schema.
  if (typeof configDefault !== "boolean") {
    return { enabled: false, source: SWITCH_SOURCE.OFF };
  }
  return { enabled: configDefault === true, source: SWITCH_SOURCE.CONFIG };
}

/**
 * Resolve the effective value of a non-boolean switch preference (a model id).
 *
 * Separate from {@link resolveSwitchEnabled} because "unset" is a different
 * sentinel for each: an unset model preference is `null`, while `""` is a real
 * value meaning "auto-pick from the catalog" — collapsing the two would turn
 * "operator asked for auto" into "operator never set it".
 *
 * @param {string|null|undefined} panelValue - the panel-saved preference.
 * @param {string} configDefault - the patch's default (`""` = auto).
 * @returns {{value: string, source: string}}
 */
export function resolveSwitchValue(panelValue: string | null | undefined, configDefault: string) {
  if (typeof panelValue === "string") {
    return { value: panelValue, source: SWITCH_SOURCE.PANEL };
  }
  return { value: configDefault, source: SWITCH_SOURCE.CONFIG };
}

/**
 * Read a panel-saved value once, tolerating every way "not available" shows up.
 *
 * The previous idiom — `(store ? store.enabled() : null).catch(() => null)` —
 * is a trap: when `store` is absent the expression is the literal `null`, and
 * `null.catch(...)` throws `TypeError` instead of answering `null`. It only
 * ever worked because no current caller passes an absent store; one new caller
 * that does would turn a missing store into a 500.
 *
 * @template T
 * @param {undefined|null|Function} read - `() => Promise<T>`; anything
 *   else is treated as "no store".
 * @returns {Promise<T|null>} the value, or `null` when unreadable.
 */
export async function readPanelValue<T>(
  read: undefined | null | (() => Promise<T>)
): Promise<T | null> {
  if (typeof read !== "function") return null;
  try {
    const value = await read();
    return value === undefined ? null : value;
  } catch {
    // An unreadable state file means "not set", never "refuse the request":
    // every switch here is opt-in, and failing closed is the default anyway.
    return null;
  }
}
