/**
 * The secret-free provider / agent-tool registration controls: the status
 * lines, the live provider switch, and the live draw- and video-tool
 * switches. The two tool cards share one body (`ToolSwitch`) because the Host
 * mounts both tools through one ladder and serves both routes through one
 * handler shape.
 */
import { DRAW_PATH, PROVIDER_PATH, VIDEO_PATH } from "./const.ts";
import { count, format } from "./format.ts";
import { postJsonOrThrow } from "./http.ts";
import { h, useCallback, useState } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import type { LlmData } from "./wire.ts";
import { S } from "./styles.ts";

/**
 * The API-key card's status: ONLY key provenance (+ the ephemeral-host
 * warning). Registration state lives in `ProviderRegStatus` on the
 * provider card — after the panel split into one card per concern, a
 * line about registration inside the key card was information flying
 * across card boundaries, repeating what the provider card's own switch
 * and status already say.
 *
 * Hook-free on purpose: like the pool cards, it is exercised by the Node
 * render suite, so a reworded or dropped status line fails a check. It
 * renders ONLY from the snapshot's `llm` block, which never carries the
 * key itself — booleans and a source tag.
 */
export function ProviderStatus({ llm, tt }: { llm?: LlmData | null; tt: Tt }): unknown {
  if (!llm || typeof llm !== "object") return null;
  const rows: unknown[] = [];
  // Where the key came from. `memory` and `env` are both real answers;
  // an unknown source degrades to the raw tag rather than a blank line.
  const sourceText = llm.hasApiKey === true
    ? format(tt("llm.keyPresent"), { source: tt(`llm.src.${String(llm.keySource ?? "")}`) || String(llm.keySource ?? "") })
    : tt("llm.noKey");
  rows.push(h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" }, role: "status" }, sourceText));
  if (llm.ephemeral === true) {
    rows.push(h("div", { style: { ...S.formNote, color: "var(--dsw-alias-state-warn-primary)" } }, tt("llm.ephemeral")));
  }
  return h("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 } }, ...rows);
}

/**
 * The provider card's registration status, hook-free like `ProviderStatus`
 * so the render suite pins every branch. The card title and the switch
 * below say "registration" already, so this is pure state + counts: the
 * id rides inside whichever line is showing, never as its own row.
 */
export function ProviderRegStatus({ llm, tt }: { llm?: LlmData | null; tt: Tt }): unknown {
  if (!llm || typeof llm !== "object") return null;
  // Order matters: a specific failure outranks a capability gap, which
  // outranks "the switch is ticked but registration has not landed yet".
  // The old fall-through told the reader "tick the switch above" when the
  // switch was ALREADY ticked and the registration silently failed — a lie
  // pointing at the wrong fix.
  if (llm.registerProvider === true && llm.providerRegistered === true) {
    return h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" }, role: "status" },
      format(tt("llm.registered"), {
        id: String(llm.providerId ?? ""),
        models: count(llm.modelCount),
        vision: count(llm.visionCount)
      }));
  }
  if (llm.registerProvider === true && typeof llm.providerError === "string" && llm.providerError !== "") {
    return h("div", { style: S.formError, role: "alert" }, format(tt("llm.error"), { error: llm.providerError }));
  }
  if (llm.registerProvider === true && llm.llmAvailable !== true) {
    return h("div", { style: { ...S.formNote, color: "var(--dsw-alias-state-warn-primary)" } }, tt("llm.noService"));
  }
  if (llm.registerProvider === true) {
    // Ticked on, no error, service present, but the register call has not
    // landed yet: say so instead of claiming the switch is off.
    return h("div", { style: { ...S.muted, fontSize: 12 }, role: "status" },
      format(tt("llm.registeredPending"), { id: String(llm.providerId ?? "") }));
  }
  return h("div", { style: { ...S.muted, fontSize: 12 } },
    format(tt("llm.off"), { id: String(llm.providerId ?? "") }));
}

/**
 * The live provider-registration switch (docs/PROVIDER-HOT-RELOAD.md).
 *
 * Posts `{ enabled }` to the plugin's own `/provider` route; the Host
 * persists the value in its state file and republishes the adapter pair
 * on the same request, so the flip lands without a config edit or a
 * restart. Hook-based like `ApiKeyForm`, so the render suite (which
 * cannot mount hooks) exercises the secret-free status lines instead;
 * the route itself is covered by `routes.test.mjs`. The state shown is
 * the SNAPSHOT's effective value, never local optimism — the poll after
 * `onDone` repaints whatever the Host actually reports.
 */
export function ProviderSwitch({ llm, onDone, tt }: {
  llm?: LlmData | null;
  onDone?: () => void;
  tt: Tt;
}): unknown {
  const [busy, setBusy] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const enabled = llm?.registerProvider === true;
  const toggle = useCallback(async () => {
    setBusy(true);
    setSwitchError(null);
    try {
      await postJsonOrThrow(PROVIDER_PATH, { enabled: !enabled });
      onDone?.();
    } catch (error) {
      setSwitchError(format(tt("llm.switchError"), { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
    }
  }, [enabled, onDone, tt]);
  return h(
    "label",
    { style: { display: "flex", gap: 8, alignItems: "center", margin: "0 0 12px", cursor: busy ? "wait" : "pointer" } },
    h("input", { type: "checkbox", checked: enabled, disabled: busy, onChange: toggle }),
    h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } }, busy ? tt("llm.switchBusy") : tt("llm.switch")),
    switchError ? h("span", { style: S.formError, role: "alert" }, switchError) : null
  );
}

/**
 * The shared body of an agent-tool card (`DrawSwitch`, `VideoSwitch`).
 *
 * Both tools are mounted by the SAME Host ladder (`mountAgentTool` in
 * `lifecycle.ts`) and both routes are served by the SAME handler shape
 * (`registerToolSwitchRoute` in `routes.ts`), so their cards differ only in
 * which route they post to, which `llm.*` fields they read, and which
 * dictionary prefix labels them. Writing the card once is what keeps the two
 * from drifting into different states for the same condition — the failure
 * mode the Host-side refactor was done to prevent.
 *
 * The dictionary suffixes are identical under both prefixes (`switch`,
 * `switchBusy`, `switchError`, `onList`, `off`, `needsKey`, `noCandidates`,
 * `badge`, `badgeNone`, `autoOption`, `effective`, `title`), so `k()` is the
 * only translation step.
 *
 * Mountable: the stand-in React returns `useState`'s initial value and passes
 * `useCallback` through, so `render.test.mjs` pins the picker's row markup —
 * the `modelRowHead` wrap below is that contract.
 */
function ToolSwitch({ path, prefix, modelKey, enabled, hasKey, candidates, preferred, effective, extraNote, onDone, tt }: {
  /** The plugin route the two actions post to. */
  path: string;
  /** Dictionary namespace: `"draw"` or `"video"`. */
  prefix: string;
  /**
   * The wire key the model-pick POST carries — `drawModelId` / `videoModelId`,
   * NOT a generic `modelId`: the Host's shared handler reads
   * `body[`${label}ModelId`]` so one route can never write the other's store.
   */
  modelKey: string;
  /** Effective switch value from the SNAPSHOT (never local optimism). */
  enabled: boolean;
  /** Whether an inference key is saved — the tool is inert without one. */
  hasKey: boolean;
  /** Catalogue ids this tool can actually drive (already filtered by the Host). */
  candidates: string[];
  /** Panel-pinned model id, or `null` for auto-pick. */
  preferred: string | null;
  /** The model the next call would actually use (`""` when the catalog yields none). */
  effective: string;
  /** Optional line under the list — used by video for the excluded 2.5 family. */
  extraNote?: unknown;
  onDone?: () => void;
  tt: Tt;
}): unknown {
  const [busy, setBusy] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const k = (suffix: string): string => tt(`${prefix}.${suffix}`);
  // Both tools mount at Host (re)mount time (`lifecycle`), so unlike the
  // provider switch a flip is NOT immediate — the copy says so.
  const toggle = useCallback(async () => {
    setBusy(true);
    setSwitchError(null);
    try {
      await postJsonOrThrow(path, { enabled: !enabled });
      onDone?.();
    } catch (error) {
      setSwitchError(format(k("switchError"), { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
    }
  }, [path, prefix, enabled, onDone, tt]);
  // Pick a model from the panel: `null` returns to auto-pick. The Host
  // validates the id against the same catalog precedence the tool uses, so a
  // stale id degrades to the config default rather than a broken tool.
  const saveModel = useCallback(async (id: string | null) => {
    setBusy(true);
    setSwitchError(null);
    try {
      await postJsonOrThrow(path, { [modelKey]: id });
      onDone?.();
    } catch (error) {
      setSwitchError(format(k("switchError"), { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
    }
  }, [path, modelKey, prefix, onDone, tt]);
  const statusText = enabled
    ? (hasKey ? k("onList") : k("needsKey"))
    : k("off");
  // Stable shape across states: switch row, lead-in, then the picker rows.
  // Unregistered greys the rows (the candidates are catalog facts that
  // survive the switch), and the picker only appears once a key produced a
  // catalog with capable models.
  const radioName = `${prefix}-model`;
  const pickerRows = hasKey && candidates.length > 0
    ? h(
        "ul",
        { style: S.modelList, role: "radiogroup", "aria-label": k("title") },
        h(
          "li",
          { style: enabled ? S.modelRow : { ...S.modelRow, ...S.modelRowOff }, key: "auto" },
          h(
            "div",
            { style: S.modelRowHead },
            h(
              "label",
              { style: { display: "flex", alignItems: "center", gap: 10, flex: "1 1 auto", minWidth: 0, cursor: busy ? "default" : "pointer" } },
              h("input", {
                type: "radio", name: radioName, checked: preferred === null && enabled, disabled: busy || !enabled,
                onChange: () => void saveModel(null), style: S.modelCheck
              }),
              h("span", { style: S.modelName }, k("autoOption"))
            ),
            // The auto badge shows WHICH model the auto-pick addresses: "image ·
            // <model>" when the catalog yields one, bare "image · (none)" when the
            // catalogue holds no capable model yet (key not saved, first poll
            // pending, or the plan has none) — so an empty list is not silently
            // read as "auto = any model" but as "there is no model".
            h("span", { style: S.modelBadge },
              effective !== ""
                ? `${k("badge")} · ${effective}`
                : `${k("badge")} · ${k("badgeNone")}`
            )
          )
        ),
        ...candidates.map((id) => h(
          "li",
          { style: enabled ? S.modelRow : { ...S.modelRow, ...S.modelRowOff }, key: id },
          h(
            "div",
            { style: S.modelRowHead },
            h(
              "label",
              { style: { display: "flex", alignItems: "center", gap: 10, flex: "1 1 auto", minWidth: 0, cursor: busy ? "default" : "pointer" } },
              h("input", {
                type: "radio", name: radioName, checked: preferred === id && enabled, disabled: busy || !enabled,
                onChange: () => void saveModel(id), style: S.modelCheck
              }),
              h("span", { style: S.modelName, title: id }, id)
            ),
            h("span", { style: S.modelBadge }, effective === id && enabled ? `${k("badge")} · ${k("effective")}` : k("badge"))
          )
        ))
      )
    : null;
  // When the list cannot be drawn (no key, or a key whose catalogue holds no
  // capable model), say so under the switch instead of leaving it blank: an
  // "on" switch with an empty area reads as "it works", which is not the
  // case. The lead-in `statusText` already carries the needs-key line when
  // the switch is ON; this hint covers the catalogue-empty case it does not name.
  const noListHint = hasKey && candidates.length === 0
    ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: 4 } }, k("noCandidates"))
    : null;
  // The switch row is just the control; the status lead-in gets its own
  // line — it introduces the model rows below, and squeezed next to the
  // label it read as a comment on the switch instead.
  return h(
    "div",
    { style: { marginBottom: 12 } },
    h(
      "label",
      { style: { display: "flex", gap: 8, alignItems: "baseline", cursor: busy ? "wait" : "pointer" } },
      h("input", { type: "checkbox", checked: enabled, disabled: busy, onChange: toggle }),
      h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-primary)" } }, busy ? k("switchBusy") : k("switch"))
    ),
    h("div", { style: { ...S.muted, fontSize: 12, marginTop: 4 } }, statusText),
    pickerRows,
    noListHint,
    extraNote ?? null,
    switchError ? h("div", { style: S.formError, role: "alert" }, switchError) : null
  );
}

/** Ids off a snapshot array field, coerced to strings and guarded against `null`. */
function idList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((id: unknown) => String(id)) : [];
}

/**
 * The live draw-tool switch (docs/PROVIDER-HOT-RELOAD.md, same discipline
 * as `ProviderSwitch`). Posts `{ enabled }` / `{ modelId }` to the plugin's
 * own `/draw` route; the Host persists the value in its state file. The draw
 * tool itself is mounted at `apply` time (lifecycle.ts), so a panel flip only
 * becomes visible after the NEXT Host (re)mount — but the switch state, the
 * source, and the snapshot's `llm.drawEnabled` are all live, so the panel
 * shows the effective value immediately. The route is covered by
 * `routes.test.mjs`.
 */
export function DrawSwitch({ llm, onDone, tt }: {
  llm?: LlmData | null;
  onDone?: () => void;
  tt: Tt;
}): unknown {
  return h(ToolSwitch, {
    path: DRAW_PATH,
    prefix: "draw",
    modelKey: "drawModelId",
    enabled: llm?.drawEnabled === true,
    hasKey: llm?.hasApiKey === true,
    candidates: idList(llm?.drawCandidateIds),
    preferred: llm?.drawPreferredModel != null ? String(llm.drawPreferredModel) : null,
    effective: String(llm?.drawModel ?? ""),
    onDone,
    tt
  });
}

/**
 * The live video-tool switch — `DrawSwitch`'s twin, on `/video`.
 *
 * The one thing it says that the draw card does not: the catalogue may hold
 * 2.5-series video models this tool deliberately will not drive. Their body
 * schema (`mode`/`seconds`/`size`/`aspect_ratio`) is disjoint from V2.0's
 * (`width`/`height`/`num_frames`/`frame_rate`), and sending one family's
 * fields to the other is a 400 — so the Host filters them out of the
 * candidates and the card names them, rather than letting a reader wonder
 * why a model they can see in the catalogue is missing here.
 */
export function VideoSwitch({ llm, onDone, tt }: {
  llm?: LlmData | null;
  onDone?: () => void;
  tt: Tt;
}): unknown {
  const excluded = idList(llm?.video25ModelIds);
  const extraNote = excluded.length > 0
    ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: 4 } },
        format(tt("video.note25"), { count: count(excluded.length), ids: excluded.join(" · ") }))
    : null;
  return h(ToolSwitch, {
    path: VIDEO_PATH,
    prefix: "video",
    modelKey: "videoModelId",
    enabled: llm?.videoEnabled === true,
    hasKey: llm?.hasApiKey === true,
    candidates: idList(llm?.videoCandidateIds),
    preferred: llm?.videoPreferredModel != null ? String(llm.videoPreferredModel) : null,
    effective: String(llm?.videoModel ?? ""),
    extraNote,
    onDone,
    tt
  });
}
