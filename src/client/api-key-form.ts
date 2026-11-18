/**
 * The inference API-key editor (free `sk-…` or Token Plan `cpk-…`): save,
 * forget, show/hide, busy and outcome notes. Same security shape as
 * `AccountForm`: the value leaves component state the moment it is saved,
 * and the key is NEVER populated from the snapshot — the Host only reports
 * whether one exists. It is hook-based, so like AccountForm the render
 * suite does not mount it; the secret-free half it displays IS covered, via
 * `ProviderStatus` (in `provider-controls.ts`, alongside the provider card
 * body `ProviderForm` that this key feeds).
 */
import { AGNES_INTL_LOGIN_URL, AGNES_SIGNUP_URL, API_KEY_PATH } from "./const.ts";
import { postJson } from "./http.ts";
import { h, useCallback, useState } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import type { LlmData } from "./wire.ts";
import { ProviderStatus } from "./provider-controls.ts";
import { S } from "./styles.ts";

/**
 * The site this editor addresses (ADR-021): the CN reference by default,
 * the INTL one when `site` is `"intl"`. The two editors post to ONE route
 * (`API_KEY_PATH`); the body's `site` field tells the Host which reference —
 * and which row's cache and publisher — the save or forget belongs to. The
 * `llm` status prop always carries the SAME site's key facts (the caller
 * passes `data.llm` for CN and `data.intl.llm` for INTL), so the editor's
 * secret-free lines never mix two sites' provenance.
 * @param {object} props - the form's props.
 * @param {"intl"} [props.site] - address the INTL reference instead of the CN one.
 * @param {LlmData|null|undefined} [props.llm] - the addressed site's key facts.
 * @param {Function} [props.onDone] - the full-reload fallback for mounts without an echo hook.
 * @param {Tt} props.tt - the translation function.
 * @returns {unknown} the form element.
 */
export function ApiKeyForm({ llm, onDone, site, tt }: {
  llm?: LlmData | null;
  onDone?: () => void;
  site?: "intl";
  tt: Tt;
}): unknown {
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [forgotten, setForgotten] = useState(false);
  const post = useCallback((payload: Record<string, unknown>) => postJson(API_KEY_PATH, payload), []);
  // One site tag rides every POST this editor makes, so a save can never
  // plant a reference in the row it was not shown for. Inline (not a
  // captured object) because a fresh literal per render would churn the
  // callbacks' dependency lists.
  const siteTag = site === "intl" ? { site: "intl" as const } : {};

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
      const body = await post({ ...siteTag, apiKey });
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
      const body = await post({ ...siteTag, forget: true });
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
  // A configured key's editor folds into one `<details>` row: the status
  // block is what a working setup needs daily, while the paste-a-key form
  // is a maintenance action — one click away, not on screen. Without a
  // key the editor is the entry point and shows open.
  const keyEditor = h(
    "div",
    null,
    h(
      "label",
      { style: S.field },
      h("span", { style: S.fieldLabel }, tt(site === "intl" ? "llm.intlKeyField" : "llm.keyField")),
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
          onChange: (event: { target: { value: string } }) => {
            setApiKey(event.target.value);
            // An outcome note ("已保存"/"已忘记") must not outlive the state
            // it describes: once the field is edited, the note no longer
            // reflects what is in the input. The next submit overwrites the
            // previous outcome anyway, so a stale note is only ever a lie.
            setSaved(false);
            setForgotten(false);
          }
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
    h("p", { style: S.formNote }, tt("llm.footnote")),
    // The official site is ALWAYS one click away, whichever state the key is
    // in: without a key it is where you get one; with one it is where you
    // manage the quota that key spends. Slightly redundant with the quota
    // tab, deliberately — leaving the panel to find the console should not
    // require remembering a URL.
    h(
      "a",
      {
        // The INTL editor points at the INTERNATIONAL site's login entry
        // (ADR-021, probed 2026-11-18); the CN one keeps its console.
        href: site === "intl" ? AGNES_INTL_LOGIN_URL : AGNES_SIGNUP_URL,
        target: "_blank",
        rel: "noreferrer",
        style: S.externalLink
      },
      llm?.hasApiKey === true ? tt(site === "intl" ? "llm.intlKeyConsoleHint" : "llm.keyConsoleHint") : tt(site === "intl" ? "llm.intlKeyRegisterHint" : "llm.keyRegisterHint")
    )
  );
  // The SectionCard wrapping this form is the collapse: one fold, not
  // two. An inner `<details>` around the editor meant opening the card
  // revealed only a status line and hid the very input the card is for.
  return h(
    "form",
    { onSubmit: submit },
    keyEditor,
    h(ProviderStatus, { llm, tt })
  );
}

// `ProviderForm` (the provider card: switch + roster + registration status)
// moved to `provider-controls.ts` next to its constituents; this file is
// now the key editor only.
