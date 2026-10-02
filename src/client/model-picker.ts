/**
 * The curated model allow-list UI: the hook-free row list and the hook-based
 * picker around it. Verbatim logic from the pre-split `client.js`.
 */
import { MODELS_PATH } from "./const.ts";
import { format, tokenSize } from "./format.ts";
import { postJsonOrThrow } from "./http.ts";
import { modelIsOn } from "./models.ts";
import { useRosterDraft } from "./roster-draft.ts";
import { h, useCallback } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import { S } from "./styles.ts";
import type { LlmData, ModelData } from "./wire.ts";

/**
 * The model picker's row list - hook-free, so the Node render suite
 * drives the very rows the browser draws.
 *
 * Each row is two lines in the WorkBuddy shape: a head line (checkbox, the
 * model name, an optional `×N` pseudo rate, badges for NOTABLE states only)
 * and an indented parameter line quoting the figures the platform declares -
 * window, output ceiling, and the thinking levels DSH's selector will really
 * offer for THIS model. A provider-wide constant (the default effort) never
 * repeats per row - it is stated once in the header, because a fact that
 * never varies between rows is noise, not information.
 * The rows come only from the Host's roster, so a curated id that no longer
 * exists can never become a checkbox: curation is a filter over the catalogue,
 * never a catalogue of its own. A default ("text only") earns no badge, and a
 * figure the catalogue does not declare draws no segment - the list quotes
 * facts, never guesses.
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
      const ctx = typeof model?.contextWindow === "number" && model.contextWindow > 0
        ? format(tt("llm.contextBadge"), { ctx: tokenSize(model.contextWindow) })
        : null;
      const out = typeof model?.maxOutputLength === "number" && model.maxOutputLength > 0
        ? format(tt("llm.metaOutput"), { out: tokenSize(model.maxOutputLength) })
        : null;
      // The selectable ladder, projected Host-side with pi-ai's own filter over
      // the descriptor map - so this list IS what the DSH selector offers.
      // Localized per level (关闭/低/中/高/极高/最高), joined compactly.
      const levels = Array.isArray(model?.thinkingLevels) && model.thinkingLevels.length > 0
        ? format(tt("llm.metaLevels"), {
          levels: model.thinkingLevels.map((level) => tt(`llm.level.${level}`)).join("/")
        })
        : null;
      const meta = [ctx, out, levels].filter(Boolean).join(" · ");
      const rate = typeof model?.multiplier === "number" ? model.multiplier : null;
      return h(
        "li",
        { key: id, style: { ...S.modelRow, ...(on ? {} : S.modelRowOff) } },
        h("div", { style: S.modelRowHead },
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
            h("span", { style: S.modelName, title: id }, label),
            // The pseudo rate rides directly after the name like WorkBuddy's
            // `(0.29x)`: the Host matched it through the same operator config
            // that labels the trend chart, so badge and chart cannot diverge.
            rate !== null
              ? h("span", { style: S.modelRate, title: tt("llm.rosterRateTitle") }, `×${rate}`)
              : null
          ),
          // A badge marks a NOTABLE state: image input is the exception worth
          // quoting, and `quota exhausted` says why a ticked row still will
          // not show up in the DSH picker (the buildDescriptors parity rule).
          model?.vision === true ? h("span", { style: S.modelBadge }, tt("llm.rosterVision")) : null,
          model?.quotaExhausted === true
            ? h("span", { style: { ...S.modelBadge, color: "var(--dsw-alias-state-error-primary)" } }, tt("llm.rosterExhausted"))
            : null
        ),
        // The parameter line carries only what was declared: an unknown
        // figure draws no segment, and a line with nothing to say vanishes.
        meta === "" ? null : h("div", { style: S.modelMeta }, meta)
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
 * state machine. The draft/dirty/saved machinery now lives in
 * `roster-draft.ts`, shared with `AgnescodeModelPicker`; what stays here is
 * only what this roster does differently — it POSTs to `MODELS_PATH` itself
 * and words its errors with the `llm.roster*` keys.
 */
export function ModelPicker({ llm, onDone, tt }: {
  llm?: LlmData | null;
  onDone?: () => void;
  tt: Tt;
}): unknown {
  const models = Array.isArray(llm?.models) ? llm.models : [];
  const hostIds = Array.isArray(llm?.enabledModelIds) ? llm.enabledModelIds : [];
  // The draft/dirty/saved machine is shared with `AgnescodeModelPicker` — see
  // `roster-draft.ts` for why it is not spelled out twice.
  const {
    ids, busy, setBusy, query, setQuery, setSavedKey, notice, setNotice,
    dirty, justSaved, visible, tickedCount, bulk, toggle, discard
  } = useRosterDraft(models, hostIds);

  const save = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    const posted = JSON.stringify(ids);
    try {
      await postJsonOrThrow(MODELS_PATH, { enabledModelIds: ids });
      // Matches hostKey as soon as the poll after onDone() echoes it.
      setSavedKey(posted);
      onDone?.();
    } catch (error) {
      setNotice(format(tt("llm.rosterError"), { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
    }
  }, [busy, ids, onDone, tt, setBusy, setNotice, setSavedKey]);

  return h(
    "div",
    { style: { marginBottom: 14 } },
    // Title and rule share one line — the rule is the tail of the same
    // sentence, not a second notice competing for attention. The provider-wide
    // thinking default rides here too: it is one constant for every row, so
    // the roster says it ONCE instead of repeating it seven times.
    h("p", { style: { margin: "0 0 10px" } },
      h("span", { style: S.sectionTitle }, tt("llm.roster"), " — "),
      h("span", { style: { ...S.muted, fontSize: 12 } }, tt("llm.rosterHint")),
      typeof llm?.thinkingDefault === "string" && llm.thinkingDefault !== ""
        ? h("span", { style: { ...S.muted, fontSize: 12 } },
          ` · ${format(tt("llm.rosterThinkingDefault"), { level: tt(`llm.level.${llm.thinkingDefault}`) })}`)
        : null),
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
              // Without this the browser's password manager typed a saved
              // console ACCOUNT into this box. It is not a keyword being
              // detected — it is a gap: the API-key form on the same tab holds
              // a `type="password"` field with NO username field inside it, and
              // Chromium's own guidance ("Password Form Styles that Chromium
              // Understands", point 2) says that when username and password are
              // split across forms, the password form must carry a username
              // field — otherwise it goes looking for one. This box was the
              // only text input on the page with no `autocomplete` and no
              // `name`, so it got picked.
              //
              // `off` is the direct instruction, and it is honoured here: the
              // well-known "Chrome ignores autocomplete=off" problem is about
              // PASSWORD fields and address autofill, not a plain search input.
              // `render.test.mjs` group I2 walks every rendered component and
              // fails if any other text input is left unlabelled this way.
              autoComplete: "off",
              name: "model-search",
              disabled: busy,
              onChange: (event: { target: { value: string } }) => setQuery(event.target.value)
            }),
            // The count LEADS the right-hand cluster - state, then actions -
            // and the bulk buttons share the search box's 32px height, so the
            // row reads as one grouped control instead of four loose ones.
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
                onToggle: toggle
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
                  onClick: discard
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
