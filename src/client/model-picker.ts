/**
 * The curated model allow-list UI: the hook-free row list and the hook-based
 * picker around it. Verbatim logic from the pre-split `client.js`.
 */
import { MODELS_PATH } from "./const.ts";
import { format } from "./format.ts";
import { postJsonOrThrow } from "./http.ts";
import { bulkModelsIn, modelIsOn, toggleModelIn } from "./models.ts";
import { h, useCallback, useEffect, useMemo, useState } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import { S } from "./styles.ts";
import type { LlmData, ModelData } from "./wire.ts";

/**
 * The model picker's row list - hook-free, so the Node render suite
 * drives the very rows the browser draws.
 *
 * Each row is a checkbox, the model name, and a modality badge. The rows
 * come only from the Host's roster, so a curated id that no longer exists
 * can never become a checkbox: curation is a filter over the catalogue,
 * never a catalogue of its own.
 */
export function ModelRoster({ models, enabledIds, busy, tt, onToggle }: {
  models: ModelData[];
  enabledIds: unknown;
  busy: boolean | undefined;
  tt: Tt;
  onToggle?: (id: string) => void;
}): unknown {
  const list = Array.isArray(models) ? models : [];
  return h(
    "ul",
    { style: S.modelList, role: "list" },
    list.map((model) => {
      const id = String(model?.id ?? "");
      const label = String(model?.name ?? id);
      const on = modelIsOn(enabledIds, id);
      return h(
        "li",
        { key: id, style: { ...S.modelRow, ...(on ? {} : S.modelRowOff) } },
        h(
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
            // The roster is hook-free, so the handler is handed in from the
            // picker. Without it this box is display-only and the allow-list
            // cannot be edited by a single row at all.
            onChange: onToggle ? () => onToggle(id) : undefined
          }),
          h("span", { style: S.modelName, title: id }, label)
        ),
        h("span", { style: S.modelBadge, title: id }, model?.vision === true ? tt("llm.rosterVision") : tt("llm.rosterText")),
        // Context window the Host resolved for this row (declared value or
        // the 128k fallback), shown as a compact k figure.
        typeof model?.contextWindow === "number" && model.contextWindow > 0
          ? h("span", { style: S.modelBadge }, format(tt("llm.contextBadge"), { ctx: `${Math.round(model.contextWindow / 1000)}k` }))
          : null
      );
    })
  );
}

/**
 * The curated model allow-list: which of this key's models get pushed to
 * DSH's model list.
 *
 * Hook-based like `ApiKeyForm`, so the render suite exercises the secret-
 * free half it draws - `ModelRoster` and the counts - instead of this
 * state machine. The edit is local until saved: the picker holds a draft
 * of the allow-list, the "unsaved" state is DERIVED by comparing it with
 * the Host's current value, and the "saved" state is the same comparison
 * after a poll echoes the write. Both therefore cannot lie: a save that
 * never reached the Host keeps showing the edits, and an edit that ends
 * up identical to the Host's value shows neither button.
 */
export function ModelPicker({ llm, onDone, tt }: {
  llm?: LlmData | null;
  onDone?: () => void;
  tt: Tt;
}): unknown {
  const models = Array.isArray(llm?.models) ? llm.models : [];
  const hostIds = Array.isArray(llm?.enabledModelIds) ? llm.enabledModelIds : [];
  const [ids, setIds] = useState<string[]>(() => hostIds.slice());
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Serialising the allow-lists is the picker's only per-render cost that
  // scales with the catalogue, so it is memoised on the arrays themselves:
  // a keystroke in the search box must not re-stringify every saved id.
  const hostKey = useMemo(() => JSON.stringify(hostIds), [hostIds]);
  const idsKey = useMemo(() => JSON.stringify(ids), [ids]);
  const dirty = idsKey !== hostKey;
  const justSaved = savedKey !== null && savedKey === hostKey;

  // Follow the Host while the picker is untouched, so a catalogue refresh
  // reaches the list and a save from another client clears the draft.
  // `dirty` in the guard keeps an edit in flight from being clobbered.
  useEffect(() => {
    if (dirty === false) setIds(hostIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostKey]);

  // The "已保存" notice ends when the picker is edited again (or the
  // Host's value moves on). It must NOT end on the poll that echoes our
  // own write — that echo is exactly when the notice is supposed to show;
  // clearing it on every hostKey change made the success line unreachable.
  useEffect(() => {
    if (dirty === true) setSavedKey(null);
  }, [dirty]);

  const save = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    const posted = JSON.stringify(ids);
    try {
      const payload = await postJsonOrThrow(MODELS_PATH, { enabledModelIds: ids });
      // Matches hostKey as soon as the poll after onDone() echoes it.
      setSavedKey(posted);
      onDone?.();
    } catch (error) {
      setNotice(format(tt("llm.rosterError"), { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
    }
  }, [busy, ids, onDone, tt]);

  const needle = query.trim().toLowerCase();
  // `models` keeps its identity between polls (it comes straight off the
  // snapshot object), so memoising on it and the search text gives `bulk`
  // dependency values that are stable by REFERENCE — the earlier
  // `JSON.stringify(...)` deps existed only to fake that stability.
  const visible = useMemo(() => models.filter((model) => {
    if (needle === "") return true;
    return String(model?.id ?? "").toLowerCase().includes(needle)
      || String(model?.name ?? "").toLowerCase().includes(needle);
  }), [needle, models]);
  const tickedCount = visible.filter((model) => modelIsOn(ids, String(model?.id ?? ""))).length;

  /** Apply "tick all" / "untick all" to the VISIBLE rows only. */
  const bulk = useCallback((allOn: boolean) => {
    // Strings, never the `{id, name, vision}` rows: the allow-list is
    // compared against a roster of ids, and an object roster would filter to
    // nothing — "tick all" would have posted the hide-all sentinel.
    const roster = models.map((model) => String(model?.id ?? ""));
    const targets = visible.map((model) => String(model?.id ?? ""));
    setIds(bulkModelsIn(ids, roster, targets, allOn));
    setNotice(null);
  }, [models, visible, ids]);

  return h(
    "div",
    { style: { marginBottom: 14 } },
    // Title and rule share one line — the rule is the tail of the same
    // sentence, not a second notice competing for attention.
    h("p", { style: { margin: "0 0 10px" } },
      h("span", { style: S.sectionTitle }, tt("llm.roster"), " — "),
      h("span", { style: { ...S.muted, fontSize: 12 } }, tt("llm.rosterHint"))),
    models.length === 0
      ? h("p", { style: S.empty }, tt("llm.rosterEmpty"))
      : h(
          "div",
          null,
          h(
            "div",
            { style: S.rosterTools },
            h("input", {
              type: "search",
              style: { ...S.input, flex: "1 1 200px", width: "auto" },
              value: query,
              placeholder: tt("llm.rosterSearchPlaceholder"),
              "aria-label": tt("llm.rosterSearchPlaceholder"),
              disabled: busy,
              onChange: (event: { target: { value: string } }) => setQuery(event.target.value)
            }),
            h("button", {
              type: "button",
              style: S.button,
              disabled: busy === true || visible.length === 0,
              onClick: () => bulk(true)
            }, tt("llm.rosterAll")),
            h("button", {
              type: "button",
              style: S.button,
              disabled: busy === true || visible.length === 0,
              onClick: () => bulk(false)
            }, tt("llm.rosterNone")),
            h("span", {
              style: S.rosterCount,
              title: format(tt("llm.rosterCount"), { selected: tickedCount, total: visible.length })
            }, format(tt("llm.rosterCount"), { selected: tickedCount, total: visible.length }))
          ),
          visible.length === 0
            ? h("p", { style: S.empty }, tt("llm.rosterNoMatch"))
            : h(ModelRoster, {
                models: visible,
                enabledIds: ids,
                busy,
                tt,
                // One row is toggled against the WHOLE roster, not the
                // filtered view, so an edit survives a later change of the
                // search box.
                onToggle: (id) => {
                  setIds(toggleModelIn(ids, models.map((model) => String(model?.id ?? "")), id));
                  setNotice(null);
                }
              }),
          dirty
            ? h(
                "div",
                { style: S.rosterFoot },
                h("button", {
                  type: "button",
                  style: S.primary,
                  disabled: busy === true,
                  onClick: () => void save()
                }, busy ? tt("llm.rosterSaving") : tt("llm.rosterSave")),
                h("button", {
                  type: "button",
                  style: S.button,
                  disabled: busy === true,
                  onClick: () => {
                    setIds(hostIds);
                    setNotice(null);
                  }
                }, tt("llm.rosterDiscard")),
                h("span", { style: { ...S.muted, fontSize: 12 } }, tt("llm.rosterUnsaved"))
              )
            : justSaved
              ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-success-primary)" }, role: "status" }, tt("llm.rosterSaved"))
              : null,
          notice !== null ? h("p", { style: S.formError, role: "alert" }, notice) : null
        )
  );
}
