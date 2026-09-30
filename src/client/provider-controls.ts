/**
 * The secret-free provider/draw registration controls: the status lines, the
 * live provider switch, and the live draw-tool switch. Verbatim logic from
 * the pre-split `clientts`.
 */
import { DRAW_PATH, PROVIDER_PATH } from "./const.ts";
import { count, format } from "./format.ts";
import { h, useCallback, useState } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
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
export function ProviderStatus({ llm, tt }: { llm?: Record<string, any> | null; tt: Tt }): unknown {
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
export function ProviderRegStatus({ llm, tt }: { llm?: Record<string, any> | null; tt: Tt }): unknown {
  if (!llm || typeof llm !== "object") return null;
  if (llm.registerProvider === true && llm.providerRegistered === true) {
    return h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" }, role: "status" },
      format(tt("llm.registered"), {
        id: String(llm.providerId ?? ""),
        models: count(llm.modelCount),
        vision: count(llm.visionCount)
      }));
  }
  if (llm.registerProvider === true && llm.llmAvailable !== true) {
    return h("div", { style: { ...S.formNote, color: "var(--dsw-alias-state-warn-primary)" } }, tt("llm.noService"));
  }
  if (llm.registerProvider === true && typeof llm.providerError === "string" && llm.providerError !== "") {
    return h("div", { style: S.formError, role: "alert" }, format(tt("llm.error"), { error: llm.providerError }));
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
  llm?: Record<string, any> | null;
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
      const response = await fetch(PROVIDER_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        cache: "no-store",
        body: JSON.stringify({ enabled: !enabled })
      });
      const payload = await response.json().catch(() => null);
      if (payload?.ok !== true) {
        throw new Error(typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`);
      }
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
 * The live draw-tool switch (docs/PROVIDER-HOT-RELOAD.md, same discipline
 * as `ProviderSwitch`). Posts `{ enabled }` to the plugin's own `/draw`
 * route; the Host persists the value in its state file. The draw tool
 * itself is mounted at `apply` time (lifecyclets), so a panel flip only
 * becomes visible after the NEXT Host (re)mount — but the switch state,
 * the source, and the snapshot's `llm.drawEnabled` are all live, so the
 * panel shows the effective value immediately. Hook-based like
 * `ProviderSwitch`, so the render suite exercises the status lines
 * instead; the route itself is covered by `routes.test.mjs`.
 */
export function DrawSwitch({ llm, onDone, tt }: {
  llm?: Record<string, any> | null;
  onDone?: () => void;
  tt: Tt;
}): unknown {
  const [busy, setBusy] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const enabled = llm?.drawEnabled === true;
  const toggle = useCallback(async () => {
    setBusy(true);
    setSwitchError(null);
    try {
      const response = await fetch(DRAW_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        cache: "no-store",
        body: JSON.stringify({ enabled: !enabled })
      });
      const payload = await response.json().catch(() => null);
      if (payload?.ok !== true) {
        throw new Error(typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`);
      }
      onDone?.();
    } catch (error) {
      setSwitchError(format(tt("draw.switchError"), { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
    }
  }, [enabled, onDone, tt]);
  // The draw tool mounts at Host (re)mount time (`lifecycle`), so unlike
  // the provider switch a flip is NOT immediate — the copy says so.
  const hasKey = llm?.hasApiKey === true;
  const candidates = Array.isArray(llm?.drawCandidateIds) ? llm.drawCandidateIds.map((id: unknown) => String(id)) : [];
  const preferred = llm?.drawPreferredModel != null ? String(llm.drawPreferredModel) : null;
  const effective = String(llm?.drawModel ?? "");
  const statusText = enabled
    ? (hasKey ? tt("draw.onList") : tt("draw.needsKey"))
    : tt("draw.off");
  // Pick a draw model from the panel: `null` returns to auto-pick. The Host
  // validates the id against the same catalog precedence the tool uses, so a
  // stale id degrades to the config default rather than a broken tool.
  const saveModel = useCallback(async (id: string | null) => {
    setBusy(true);
    setSwitchError(null);
    try {
      const response = await fetch(DRAW_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        cache: "no-store",
        body: JSON.stringify({ drawModelId: id })
      });
      const payload = await response.json().catch(() => null);
      if (payload?.ok !== true) {
        throw new Error(typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`);
      }
      onDone?.();
    } catch (error) {
      setSwitchError(format(tt("draw.switchError"), { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
    }
  }, [onDone, tt]);
  // Stable shape across states: switch row, lead-in, then the picker rows.
  // Unregistered greys the rows (the candidates are catalog facts that
  // survive the switch), and the picker only appears once a key produced a
  // catalog with image-capable models.
  const pickerRows = hasKey && candidates.length > 0
    ? h(
        "ul",
        { style: S.modelList, role: "radiogroup", "aria-label": tt("draw.title") },
        h(
          "li",
          { style: enabled ? S.modelRow : { ...S.modelRow, ...S.modelRowOff }, key: "auto" },
          h(
            "label",
            { style: { display: "flex", alignItems: "center", gap: 10, flex: "1 1 auto", minWidth: 0, cursor: busy ? "default" : "pointer" } },
            h("input", {
              type: "radio", name: "draw-model", checked: preferred === null, disabled: busy || !enabled,
              onChange: () => void saveModel(null), style: S.modelCheck
            }),
            h("span", { style: S.modelName }, tt("draw.autoOption"))
          ),
          h("span", { style: S.modelBadge }, preferred === null && effective !== "" ? `${tt("draw.badge")} · ${effective}` : tt("draw.badge"))
        ),
        ...candidates.map((id) => h(
          "li",
          { style: enabled ? S.modelRow : { ...S.modelRow, ...S.modelRowOff }, key: id },
          h(
            "label",
            { style: { display: "flex", alignItems: "center", gap: 10, flex: "1 1 auto", minWidth: 0, cursor: busy ? "default" : "pointer" } },
            h("input", {
              type: "radio", name: "draw-model", checked: preferred === id, disabled: busy || !enabled,
              onChange: () => void saveModel(id), style: S.modelCheck
            }),
            h("span", { style: S.modelName, title: id }, id)
          ),
          h("span", { style: S.modelBadge }, effective === id ? `${tt("draw.badge")} · ${tt("draw.effective")}` : tt("draw.badge"))
        ))
      )
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
      h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-primary)" } }, busy ? tt("draw.switchBusy") : tt("draw.switch"))
    ),
    h("div", { style: { ...S.muted, fontSize: 12, marginTop: 4 } }, statusText),
    pickerRows,
    switchError ? h("div", { style: S.formError, role: "alert" }, switchError) : null
  );
}
