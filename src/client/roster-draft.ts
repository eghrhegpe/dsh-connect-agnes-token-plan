/**
 * The draft/dirty/saved state machine the two model pickers share.
 *
 * `ModelPicker` (the Token Plan roster) and `AgnescodeModelPicker` (the
 * AgnesCode roster) present the same edit affordances over different routes,
 * row shapes and dictionary keys. Everything AROUND those differences was
 * duplicated line for line — the draft, the derived "unsaved" flag, the
 * "已保存" notice and the two effects that keep them honest.
 *
 * Duplicated hook wiring is not like duplicated prose: the second copy has no
 * way to be checked against the first, and one of these effects carries a fixed
 * bug in its comment ("clearing it on every hostKey change made the success line
 * unreachable"). A repair applied to one picker and not the other would restore
 * exactly that bug, silently. So the machine lives here, once, and each picker
 * supplies only what genuinely differs: its roster, its save call, its wording.
 *
 * What stays at the CALL SITE, deliberately:
 *  - normalising `hostIds` — `ModelPicker` passes the snapshot's array as-is
 *    while `AgnescodeModelPicker` drops non-string entries, and folding that
 *    into the hook would silently change one of them;
 *  - `save()` — the endpoints and error keys differ (`llm.rosterError` vs
 *    `agnescode.rosterError`), and the notice has to be built with that
 *    picker's own `tt`.
 */
import { useCallback, useEffect, useMemo, useState } from "./runtime.ts";
import { bulkModelsIn, modelIsOn, rosterMatches, toggleModelIn } from "./models.ts";

/** The two fields the shared row algebra reads off a roster row. */
interface RosterRow {
  id?: unknown;
  name?: unknown;
}

/** What {@link useRosterDraft} hands back: state, flags, and the row actions. */
export interface RosterDraft {
  /** The draft allow-list (local until saved). */
  ids: string[];
  setIds: (value: string[] | ((prev: string[]) => string[])) => void;
  /** True while a save is in flight; disables every control. */
  busy: boolean;
  setBusy: (value: boolean) => void;
  /** The search box's raw text (the filter, never the saved value). */
  query: string;
  setQuery: (value: string) => void;
  /** The serialised draft echoed back by the Host after a successful save. */
  savedKey: string | null;
  setSavedKey: (value: string | null) => void;
  /** A failure line, already formatted; `null` when there is nothing to say. */
  notice: string | null;
  setNotice: (value: string | null) => void;
  /** `JSON.stringify(ids)` — the draft's identity for the comparisons below. */
  idsKey: string;
  /** `JSON.stringify(hostIds)` — the Host's identity. */
  hostKey: string;
  /** The draft differs from the Host's value: show save/discard. */
  dirty: boolean;
  /** The Host came back carrying our write: show the success line. */
  justSaved: boolean;
  /** The rows matching the current search text. */
  visible: RosterRow[];
  /** How many VISIBLE rows are ticked (the count the tools row quotes). */
  tickedCount: number;
  /** Tick/untick every VISIBLE row, against the whole roster. */
  bulk: (allOn: boolean) => void;
  /** Toggle one row, against the whole roster. */
  toggle: (id: string) => void;
  /** Drop the draft and follow the Host again. */
  discard: () => void;
}

/**
 * The shared draft machine for a curated model roster.
 *
 * @param rows - the roster rows the route currently reports (already defaulted
 *   to `[]` by the caller, so identity is stable between polls).
 * @param hostIds - the Host's curated ids, already normalised by the caller.
 * @returns the draft, its derived flags, and the row actions.
 */
export function useRosterDraft(rows: RosterRow[], hostIds: string[]): RosterDraft {
  const [ids, setIds] = useState<string[]>(() => hostIds.slice());
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Serialising the allow-lists is the only per-render cost that scales with
  // the catalogue, so it is memoised on the arrays themselves: a keystroke in
  // the search box must not re-stringify every saved id.
  const hostKey = useMemo(() => JSON.stringify(hostIds), [hostIds]);
  const idsKey = useMemo(() => JSON.stringify(ids), [ids]);
  const dirty = idsKey !== hostKey;
  const justSaved = savedKey !== null && savedKey === hostKey;

  // Follow the Host while the picker is untouched, so a catalogue refresh
  // reaches the list and a save from another client clears the draft.
  // `dirty` in the guard keeps an edit in flight from being clobbered. The dep
  // array is `[hostKey]` ON PURPOSE: `dirty` is derived from `idsKey`/`ids`,
  // and re-running on it would echo our own writes back onto the list. (No
  // eslint runs here — the tsc + gates take its place — so there is no
  // directive to carry for the deliberate omission.)
  useEffect(() => {
    if (dirty === false) setIds(hostIds);
  }, [hostKey]);

  // The "已保存" notice ends when the picker is edited again (or the Host's
  // value moves on). It must NOT end on the poll that echoes our own write —
  // that echo is exactly when the notice is supposed to show; clearing it on
  // every hostKey change made the success line unreachable.
  useEffect(() => {
    if (dirty === true) setSavedKey(null);
  }, [dirty]);

  const needle = query.trim().toLowerCase();
  // `rows` keeps its identity between polls (it comes straight off the
  // snapshot object), so memoising on it and the search text gives `bulk`
  // dependency values that are stable by REFERENCE.
  const visible = useMemo(() => rows.filter((row) => rosterMatches(row, needle)), [needle, rows]);
  const tickedCount = visible.filter((row) => modelIsOn(ids, String(row?.id ?? ""))).length;

  /** Apply "tick all" / "untick all" to the VISIBLE rows only. */
  const bulk = useCallback((allOn: boolean) => {
    // Strings, never the `{id, name}` rows: the allow-list is compared against
    // a roster of ids, and an object roster would filter to nothing — "tick
    // all" would have posted the hide-all sentinel.
    const roster = rows.map((row) => String(row?.id ?? ""));
    const targets = visible.map((row) => String(row?.id ?? ""));
    setIds(bulkModelsIn(ids, roster, targets, allOn));
    setNotice(null);
  }, [rows, visible, ids]);

  // One row is toggled against the WHOLE roster, not the filtered view, so an
  // edit survives a later change of the search box.
  const toggle = useCallback((id: string) => {
    setIds(toggleModelIn(ids, rows.map((row) => String(row?.id ?? "")), id));
    setNotice(null);
  }, [ids, rows]);

  const discard = useCallback(() => {
    setIds(hostIds);
    setNotice(null);
  }, [hostIds]);

  return {
    ids, setIds, busy, setBusy, query, setQuery, savedKey, setSavedKey, notice, setNotice,
    idsKey, hostKey, dirty, justSaved, visible, tickedCount, bulk, toggle, discard
  };
}
