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
 * The secret-free registration status, step three.
 *
 * Hook-free on purpose: like the pool cards, it is exercised by the Node
 * render suite, so a reworded or dropped status line fails a check. It
 * renders ONLY from the snapshot's `llm` block, which never carries the
 * key itself — booleans, a source tag, counts, and an optional error.
 */
export function ProviderStatus({ llm, tt }: { llm?: Record<string, any> | null; tt: Tt }): unknown {
  if (!llm || typeof llm !== "object") return null;
  const rows: unknown[] = [];
  // Where the key came from. `memory` and `env` are both real answers;
  // an unknown source degrades to the raw tag rather than a blank line.
  const sourceText = llm.hasApiKey === true
    ? format(tt("llm.keyPresent"), { source: tt(`llm.src.${String(llm.keySource ?? "")}`) || String(llm.keySource ?? "") })
    : tt("llm.noKey");
  rows.push(h("div", { style: { ...S.muted, fontSize: 12 } }, sourceText));
  if (llm.ephemeral === true) {
    rows.push(h("div", { style: { ...S.formNote, color: "var(--dsw-alias-state-warn-primary)" } }, tt("llm.ephemeral")));
  }
  // The registration line is the one the section title promises.
  if (llm.registerProvider === true && llm.providerRegistered === true) {
    rows.push(h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" }, role: "status" },
      format(tt("llm.registered"), {
        id: String(llm.providerId ?? ""),
        models: count(llm.modelCount),
        vision: count(llm.visionCount)
      })));
  } else if (llm.registerProvider === true && llm.llmAvailable !== true) {
    rows.push(h("div", { style: { ...S.formNote, color: "var(--dsw-alias-state-warn-primary)" } }, tt("llm.noService")));
  } else if (llm.registerProvider === true && typeof llm.providerError === "string" && llm.providerError !== "") {
    rows.push(h("div", { style: S.formError, role: "alert" }, format(tt("llm.error"), { error: llm.providerError })));
  } else {
    rows.push(h("div", { style: S.formNote }, tt("llm.off")));
  }
  if (typeof llm.providerId === "string" && llm.providerId !== "") {
    rows.push(h("div", { style: { ...S.muted, fontSize: 11, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" } },
      format(tt("llm.id"), { id: llm.providerId })));
  }
  return h("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 } }, ...rows);
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
  const statusText = enabled
    ? (llm?.hasApiKey === true
        ? format(tt("draw.on"), { model: String(llm?.drawModelId ?? "") || "the first discovered one" })
        : tt("draw.needsKey"))
    : tt("draw.off");
  return h(
    "div",
    { style: { marginBottom: 12 } },
    h("div", { style: S.sectionTitle }, tt("draw.title")),
    h(
      "label",
      { style: { display: "flex", gap: 8, alignItems: "center", margin: "0 0 6px", cursor: busy ? "wait" : "pointer" } },
      h("input", { type: "checkbox", checked: enabled, disabled: busy, onChange: toggle }),
      h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } }, busy ? tt("draw.switchBusy") : tt("draw.switch"))
    ),
    h("div", { style: { ...S.muted, fontSize: 12 } }, statusText),
    switchError ? h("div", { style: S.formError, role: "alert" }, switchError) : null
  );
}
