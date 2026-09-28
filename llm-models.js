/**
 * Catalog entry -> pi-ai model descriptor mapping — the pure half of the
 * directly-registered SenseNova LLM provider ("one-stop service", step three).
 *
 * This module deliberately imports NO runtime peer (`@earendil-works/pi-ai`,
 * `@deepseek-ai/dsh-llm-pi-ai`): it builds plain objects only, so the mapping
 * decisions are testable on a clean checkout the same way the qoder fork keeps
 * its own `pi-model.js` peer-free. `llm-adapter.js` is the peer-dependent half
 * that hands these descriptors to `createProvider`.
 *
 * Two decisions carried here are load-bearing rather than cosmetic:
 *
 * 1. `compat.supportsDeveloperRole: false`. pi-ai picks the system-prompt role
 *    as `reasoning && supportsDeveloperRole ? "developer" : "system"`, and when
 *    the flag is unset it AUTO-DETECTS, returning true for anything that does
 *    not look like a known non-standard provider. SenseNova's direct endpoint
 *    does not speak the developer role, so an unset flag makes every request
 *    403 forever. Setting it false is the fix the qoder route proved necessary.
 * 2. No `maxTokens` VALUE is declared. A declared value becomes the output
 *    ceiling and pi-ai sends it as `max_tokens`, truncating long replies with
 *    `finish: max-tokens`. Only the field NAME (`max_tokens`) is pinned.
 *
 * @module dsh-connect-sensenova-token-plan/llm-models
 */

import { str, num } from "./util.js";
import { identifyVisionModel } from "./parsers.js";

/**
 * The provider id this plugin registers under.
 *
 * It must NOT be the bare `"sensenova"`: a hand-written `llm-pi-ai` row using
 * that id can already exist in an operator's profile (apiKeyEnv
 * `SENSENOVA_API_KEY`, base `https://token.sensenova.cn/v1/`), and
 * `registerAdapter` with a colliding id is refused as a duplicate. This own
 * slug-shaped id cannot collide with that row or with another plugin.
 */
export const LLM_PROVIDER_ID = "sensenova-token-plan";

/** What the DSH model picker shows as the provider's name. */
export const LLM_DISPLAY_NAME = "SenseNova Token Plan";

/**
 * Per-token prices are unknowable for a quota plan; report zero everywhere.
 *
 * ⚠️ The zeros are a SENTINEL, not "free". SenseNova Token Plan is a credit
 * pool billed by pool usage, so a per-token USD price simply does not exist on
 * this route — but the model still burns credits. A panel row showing
 * "$0.00" is describing "no per-token price known", never "this model costs
 * nothing". Keep this comment next to the set so a future reader does not
 * "fix" it to real prices or, worse, to `null` (which pi-ai may render as an
 * unknown-cost row and break the picker's cost arithmetic).
 */
export const NO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/**
 * Advertised context window when the catalog declares no usable one.
 *
 * pi-ai's options builder does arithmetic on `model.contextWindow`, so an
 * undefined value behaves like zero rather than "unknown" and breaks max-token
 * calculation; the qoder route therefore always supplies a positive number.
 * 128k is the conservative SenseNova-family default; a catalog field that
 * states a real window always wins.
 */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * Read a positive context window off the catalog entry's known spellings.
 *
 * SenseNova's `/v1/models` entries are kept whole by `console-client.js`, so a
 * field the platform adds later needs no parser change here — only its name has
 * to be added to this list.
 * @param {object} entry - one normalized catalog entry.
 * @returns {number} the declared window, or the fallback.
 */
export function contextWindowOf(entry) {
  for (const key of ["context_window", "contextWindow", "max_context_tokens"]) {
    const value = Math.floor(num(entry?.[key], 0));
    if (value > 0) return value;
  }
  return FALLBACK_CONTEXT_WINDOW;
}

/**
 * Map one catalog entry onto the pi-ai model descriptor the adapter offers.
 *
 * Vision is the SAME identification the snapshot publishes
 * (`identifyVisionModel`: the platform's `input_modalities` first, the name
 * fallback only when no structured field exists) — so the model picker cannot
 * disagree with the panel's vision list about which models accept images.
 * @param {object} entry - one normalized catalog entry (must carry `id`).
 * @param {object} options - wiring.
 * @param {string} options.providerId - the provider id the descriptor belongs to.
 * @param {string} options.baseUrl - the OpenAI-compatible base URL.
 * @returns {object} the pi-ai descriptor.
 */
export function toPiDescriptor(entry, { providerId = LLM_PROVIDER_ID, baseUrl } = {}) {
  const id = str(entry?.id, "");
  if (id === "") throw new Error("toPiDescriptor: catalog entry has no id");
  const vision = identifyVisionModel(entry).vision === true;
  return {
    id,
    // Prefer the catalog's own display name; fall back to the id.
    name: str(entry.name, id),
    api: "openai-completions",
    provider: providerId,
    baseUrl,
    // Vision is automatic: the catalog's modality field decides, the user does
    // not configure it per model.
    input: vision ? ["text", "image"] : ["text"],
    // SenseNova chat models served over this endpoint are not the "reasoning"
    // shape pi-ai special-cases; leave the flag at its conservative default.
    reasoning: false,
    cost: { ...NO_COST },
    contextWindow: contextWindowOf(entry),
    // `supportsDeveloperRole: false` is load-bearing — see the module header.
    // There is deliberately no `maxTokens` VALUE here: declaring one truncates
    // replies; only the wire field name is pinned.
    compat: { maxTokensField: "max_tokens", supportsDeveloperRole: false }
  };
}

/**
 * Narrow a catalog to the models the user enabled.
 *
 * An **empty list means "no filter"**: a fresh install has curated nothing and
 * must still be offered every model (the WorkBuddy convention). Once non-empty
 * the list is an allow-list; an id that names no current catalog entry is
 * harmless — it simply matches nothing this catalog.
 * @param {object[]} entries - the normalized catalog entries.
 * @param {string[]} [enabledIds] - the allow-list; empty/absent disables it.
 * @returns {object[]} the entries still offered, in catalog order.
 */
export function filterByEnabled(entries, enabledIds) {
  const list = Array.isArray(enabledIds) ? enabledIds : [];
  if (list.length === 0) return Array.isArray(entries) ? entries : [];
  const allow = new Set(list);
  return (Array.isArray(entries) ? entries : []).filter((entry) => allow.has(str(entry?.id, "")));
}

/**
 * Build the whole descriptor list for one catalog.
 *
 * Entries without an id are dropped (they could not be addressed on the wire)
 * and duplicate ids keep the LAST occurrence, matching the catalog store's
 * normalization so the adapter and the persisted catalog can never diverge.
 * @param {object[]} entries - the normalized catalog entries.
 * @param {object} options - `{ providerId, baseUrl, enabledIds }`.
 * @returns {object[]} the pi-ai descriptors, in first-seen order.
 */
export function buildDescriptors(entries, { providerId = LLM_PROVIDER_ID, baseUrl, enabledIds = [] } = {}) {
  const filtered = filterByEnabled(entries, enabledIds);
  const seen = new Map();
  const out = [];
  for (const entry of Array.isArray(filtered) ? filtered : []) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const id = str(entry.id, "");
    if (id === "") continue;
    if (!seen.has(id)) {
      seen.set(id, out.length);
      out.push(undefined);
    }
    out[seen.get(id)] = toPiDescriptor({ ...entry, id }, { providerId, baseUrl });
  }
  return out;
}

/**
 * Counts the provider-registration status reports: how many models the catalog
 * offered and how many of them accept image input, keyed by the same vision
 * identification the descriptors use.
 * @param {object[]} entries - the normalized catalog entries.
 * @returns {{modelCount: number, visionCount: number, visionIds: string[]}}
 */
export function summarizeCatalog(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const visionIds = list
    .filter((entry) => str(entry?.id, "") !== "")
    .map((entry) => identifyVisionModel(entry))
    .filter((entry) => entry.vision === true)
    .map((entry) => entry.id);
  return {
    modelCount: list.filter((entry) => str(entry?.id, "") !== "").length,
    visionCount: visionIds.length,
    visionIds
  };
}
