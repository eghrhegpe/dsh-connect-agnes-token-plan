/**
 * The model rosters' two shared, hook-free affordances — the ONE mechanism the
 * sibling rosters draw, with only the config differing (which rows, which
 * dictionary, which `name` the search box carries).
 *
 * Both were spelled out twice: once in `model-picker.ts` (the token-plan
 * roster) and once in `agnescode-tab.ts` (the AgnesCode roster). They produced
 * identical DOM, so the duplication was pure cost — two copies that had to
 * change together whenever the row or the tools row changed. Sharing them here
 * keeps the two rosters honest about what is really different (the rows they
 * render, the words they speak) and lets a row-shape change land in one place.
 *
 * Hook-free on purpose: the render suite drives the very DOM the browser
 * draws, so a shared part cannot silently drift away from what is shipped.
 */
import { format } from "./format.ts";
import { h } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import { S } from "./styles.ts";

/**
 * The tickable head of a model roster row: a labelled checkbox over the model
 * name. A roster is hook-free, so the handler is handed in — without it the box
 * is display-only and the allow-list could not be edited one model at a time.
 *
 * @param {object} props
 * @param {string} props.id - the model id, also the row's key and the span's title.
 * @param {string} props.label - the visible name (`aria-label` too, so a screen
 *   reader announces what the box ticks).
 * @param {boolean} props.on - the checkbox state.
 * @param {boolean} [props.busy] - disable the box while a save is in flight.
 * @param {(id: string) => void} [props.onToggle] - hand the edit back.
 * @param {unknown} [props.tail] - extra children to carry INSIDE the label (a
 *   sibling roster's pseudo rate, built by the caller because it translates
 *   through its own dictionary). The label wraps whatever follows the name, so
 *   a click on it ticks the box — which is why it rides in here rather than
 *   outside.
 * @returns {unknown} the label element.
 */
export function RosterCheckbox({ id, label, on, busy, onToggle, tail }: {
  id: string;
  label: string;
  on: boolean;
  busy: boolean | undefined;
  onToggle?: ((id: string) => void) | undefined;
  tail?: unknown;
}): unknown {
  return h(
    "label",
    {
      style: {
        display: "flex", alignItems: "center", gap: 10, flex: "1 1 auto",
        minWidth: 0, cursor: busy ? "default" : "pointer"
      }
    },
    h("input", {
      type: "checkbox",
      checked: on,
      disabled: busy === true,
      style: S.modelCheck,
      "aria-label": label,
      onChange: onToggle ? () => onToggle(id) : undefined
    }),
    h("span", { style: S.modelName, title: id }, label),
    tail ?? null
  );
}

/**
 * The search / count / tick-all / untick-all row a model picker puts above its
 * rows. The count LEADS the right-hand cluster — state, then actions — and the
 * bulk buttons share the search box's 32px height, so the row reads as one
 * grouped control instead of four loose ones.
 *
 * `name` is handed in, not hard-coded: it is the one thing the browser's
 * password manager notices about a text input. Without a `name` and
 * `autoComplete="off"`, this box was where Chromium typed a saved console
 * ACCOUNT — the API-key form on the same tab holds a `type="password"` field
 * with NO username field inside it, and Chromium's own guidance ("Password Form
 * Styles that Chromium Understands", point 2) says that when username and
 * password are split across forms, the password form must carry a username
 * field — otherwise it goes looking for one. This box was the only text input on
 * the page with no `autocomplete` and no `name`, so it got picked. `off` is the
 * direct instruction, and it is honoured here: the well-known "Chrome ignores
 * autocomplete=off" problem is about PASSWORD fields and address autofill, not
 * a plain search input.
 *
 * @param {object} props
 * @param {string} props.query - the filter text.
 * @param {(value: string) => void} props.setQuery - the filter write.
 * @param {string} props.name - this roster's search-box name.
 * @param {boolean} [props.busy] - disable the row while a save is in flight.
 * @param {number} props.tickedCount - how many rows are on.
 * @param {unknown[]} props.visible - the rows the filter left (drives the count
 *   and whether the bulk buttons are worth pressing).
 * @param {(on: boolean) => void} props.bulk - tick all / untick all.
 * @param {import("./runtime.ts").Tt} props.tt - the dictionary.
 * @returns {unknown} the tools row element.
 */
export function RosterTools({ query, setQuery, name, busy, tickedCount, visible, bulk, tt }: {
  query: string;
  setQuery: (value: string) => void;
  name: string;
  busy: boolean | undefined;
  tickedCount: number;
  visible: unknown[];
  bulk: (on: boolean) => void;
  tt: Tt;
}): unknown {
  return h(
    "div",
    { style: S.rosterTools },
    h("input", {
      type: "search",
      style: { ...S.input, flex: "1 1 200px", width: "auto" },
      value: query,
      placeholder: tt("llm.rosterSearchPlaceholder"),
      "aria-label": tt("llm.rosterSearchPlaceholder"),
      autoComplete: "off",
      name,
      disabled: busy,
      onChange: (event: { target: { value: string } }) => setQuery(event.target.value)
    }),
    h("span", {
      style: S.rosterCount,
      title: format(tt("llm.rosterCount"), { selected: tickedCount, total: visible.length })
    }, format(tt("llm.rosterCount"), { selected: tickedCount, total: visible.length })),
    h("button", {
      type: "button",
      style: S.rosterBulk,
      disabled: busy === true || visible.length === 0,
      onClick: () => bulk(true)
    }, tt("llm.rosterAll")),
    h("button", {
      type: "button",
      style: S.rosterBulk,
      disabled: busy === true || visible.length === 0,
      onClick: () => bulk(false)
    }, tt("llm.rosterNone"))
  );
}