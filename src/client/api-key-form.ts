/**
 * The inference API-key editor (`sk-…`) with the llm section assembled around
 * it. Same security shape as `AccountForm`: show/hide, save/forget, busy and
 * outcome notes, and the value leaves component state the moment it is saved.
 * It is hook-based, so like AccountForm the render suite does not mount it;
 * the secret-free half it displays IS covered, via `ProviderStatus`. The key
 * is NEVER populated from the snapshot — the Host only reports whether one
 * exists.
 */
import { API_KEY_PATH } from "./const.js";
import { h, useCallback, useState } from "./runtime.js";
import type { Tt } from "./runtime.js";
import { DrawSwitch, ProviderStatus, ProviderSwitch } from "./provider-controls.js";
import { ModelPicker } from "./model-picker.js";
import { S } from "./styles.js";

export function ApiKeyForm({ llm, onDone, tt }: {
  llm?: Record<string, any> | null;
  onDone?: () => void;
  tt: Tt;
}): unknown {
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [forgotten, setForgotten] = useState(false);

  const post = useCallback(async (payload: Record<string, unknown>) => {
    const response = await fetch(API_KEY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      cache: "no-store",
      body: JSON.stringify(payload)
    });
    return response.json().catch(() => null);
  }, []);

  const submit = useCallback(async (event?: { preventDefault?: () => void }) => {
    event?.preventDefault?.();
    // A whitespace check, not a prefix check: the platform owns the key
    // format, and rejecting a shape it later changes would lock users out.
    if (apiKey.trim() === "") {
      setFormError(tt("llm.empty"));
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const body = await post({ apiKey });
      if (body && body.ok === true) {
        setApiKey("");
        setSaved(true);
        setForgotten(false);
        onDone?.();
        return;
      }
      setFormError(body?.error ?? tt("auth.network"));
    } catch {
      setFormError(tt("auth.network"));
    } finally {
      setBusy(false);
    }
  }, [apiKey, post, onDone, tt]);

  const forget = useCallback(async () => {
    setBusy(true);
    setFormError(null);
    try {
      const body = await post({ forget: true });
      if (body?.ok !== true) {
        setFormError(body?.error ?? tt("auth.network"));
        return;
      }
      setForgotten(true);
      setSaved(false);
      setApiKey("");
      onDone?.();
    } catch {
      setFormError(tt("auth.network"));
    } finally {
      setBusy(false);
    }
  }, [post, onDone, tt]);

  // Only a REFERENCE the panel stored can be forgotten: an environment
  // value has no panel-saved copy to clear, so the button would mislead.
  const canForget = llm?.hasApiKey === true && llm?.keySource === "credentials";
  return h(
    "form",
    { onSubmit: submit },
    h(ProviderStatus, { llm, tt }),
    h(ProviderSwitch, { llm, onDone, tt }),
    h(DrawSwitch, { llm, onDone, tt }),
    h(ModelPicker, { llm, onDone, tt }),
    h(
      "label",
      { style: S.field },
      h("span", { style: S.fieldLabel }, tt("llm.keyField")),
      h(
        "div",
        { style: { display: "flex", gap: 6, alignItems: "center" } },
        h("input", {
          style: { ...S.input, flex: 1 },
          type: showKey ? "text" : "password",
          value: apiKey,
          autoComplete: "off",
          placeholder: tt("llm.placeholder"),
          disabled: busy,
          onChange: (event: { target: { value: string } }) => setApiKey(event.target.value)
        }),
        h(
          "button",
          { type: "button", style: { ...S.button, flex: "none" }, disabled: busy, onClick: () => setShowKey((shown) => !shown) },
          showKey ? tt("auth.hide") : tt("auth.show")
        )
      )
    ),
    h(
      "div",
      { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 4 } },
      h(
        "button",
        { type: "submit", style: { ...S.primary, ...(busy ? S.primaryBusy : {}) }, disabled: busy },
        busy ? tt("llm.saving") : tt("llm.save")
      ),
      canForget
        ? h("button", { type: "button", style: S.button, disabled: busy, onClick: forget }, tt("llm.forget"))
        : null
    ),
    forgotten
      ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-success-primary)" }, role: "status" }, tt("llm.forgotten"))
      : saved
        ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-success-primary)" }, role: "status" }, tt("llm.saved"))
        : null,
    formError ? h("p", { style: S.formError, role: "alert" }, formError) : null,
    h("p", { style: S.formNote }, tt("llm.footnote"))
  );
}
