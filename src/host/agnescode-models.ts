/**
 * AgnesCode catalogue entry → pi-ai model descriptor mapping — the peer-free
 * half of the desktop-app upstream provider. Same peer-free
 * discipline: plain objects only (no Host peer import); `agnescode-llm-adapter.ts`
 * is the peer-dependent half.
 *
 * Three decisions carried here:
 *   1. `reasoning: false` — the catalogue rows declare a `thinking_toggle`
 *      (default ON), but the WIRE field that would control it from OpenAI
 *      chat is UNVERIFIED (ROADMAP §6.3). Offering a thinking selector would
 *      promise something the descriptor cannot emit; the honest v1 shape is
 *      "no toggle; the BFF defaults to thinking ON". A stated limitation, not
 *      an oversight.
 *   2. The base URL is PER-ACCOUNT (`bffPublicBaseUrl` from the session
 *      file), so it rides through the builder's options instead of a module
 *      constant — the reference reverse-proxy's hardcoded `.com` constant is
 *      the trap this avoids.
 *   3. `memberOnly` models are OFFERED, not dropped: gating is account state,
 *      not model truth (red line 7's spirit — state limits, never silently
 *      retract models). The panel badges them; a request that hits the gate
 *      fails visibly at the upstream.
 *
 * @module dsh-connect-agnes-token-plan/agnescode-models
 */

import { str, num } from "./util.ts";
import { AGNESCODE_FALLBACK_MODELS } from "./agnescode.ts";

/** The provider id this plugin registers under for AgnesCode. */
export const AGNESCODE_PROVIDER_ID = "sensenova-agnescode";

/** What the DSH model picker shows as the AgnesCode provider's name. */
export const AGNESCODE_DISPLAY_NAME = "SenseNova AgnesCode";

/** The zero-cost sentinel: per-token prices are unknowable (credit-gated). */
const NO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** The catalogue/identity headers every request carries (probed: required). */
export function agnescodeRequestHeaders() {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-App-Id": "1",
    "X-Platform": "1",
    "X-User-Language": "zh-Hans"
  };
}

/**
 * The AgnesCode model rows the panel shows and the adapter offers.
 *
 * A live catalogue row always beats the static fallback roster. The row keeps
 * what the picker and panel need — plus `memberOnly`, which this provider HAS
 * a platform-declared fact for and the panel badges.
 * @param {object[]|null} [catalog] - the `fetchAgnescodeCatalog` result.
 * @returns {object[]} the AgnesCode model rows.
 */
export function agnescodeRoster(catalog: unknown) {
  const rows = Array.isArray(catalog) && catalog.length > 0 ? catalog : AGNESCODE_FALLBACK_MODELS;
  const out: Array<{ id: string; name: string; vision: boolean; memberOnly: boolean; multiplier: number; contextWindow: number; maxOutputLength: number }> = [];
  for (const row of rows) {
    const id = str(row?.id, "");
    if (id === "") continue;
    out.push({
      id,
      name: str(row?.name, id),
      vision: row?.vision === true,
      memberOnly: row?.memberOnly === true,
      // No multiplier concept on this provider: billing is the credit pool
      // (credits-balance), not per-model rates — `undefined` means the roster
      // draws no rate chip, which is the honest shape.
      multiplier: typeof row?.multiplier === "number" ? row.multiplier : undefined,
      contextWindow: num(row?.contextWindow),
      maxOutputLength: num(row?.maxOutputLength)
    });
  }
  return out;
}

/**
 * Map one AgnesCode row onto the pi-ai model descriptor the adapter offers.
 * @param {object} row - an {@link agnescodeRoster} row (must carry `id`).
 * @param {object} [options] - `{ bffBase }` — the pinned per-account base.
 * @returns {object} the pi-ai descriptor.
 */
export function agnescodeToDescriptor(row: any, options: { bffBase?: string } = {}) {
  const id = str(row?.id, "");
  if (id === "") throw new Error("agnescodeToDescriptor: row has no id");
  const bffBase = str(options.bffBase, "");
  if (bffBase === "") throw new Error("agnescodeToDescriptor: a pinned bffBase is required");
  const vision = row?.vision === true;
  return {
    id,
    name: str(row?.name, id),
    api: "openai-completions",
    provider: AGNESCODE_PROVIDER_ID,
    baseUrl: bffBase,
    input: vision ? ["text", "image"] : ["text"],
    // See the module header: the thinking wire channel is unverified in v1;
    // the BFF defaults to thinking ON.
    reasoning: false,
    cost: { ...NO_COST },
    // A positive window is required (pi-ai does arithmetic on it); the
    // AgnesCode catalogue always declares one, but guard against shape drift.
    contextWindow: num(row?.contextWindow) ?? 512_000,
    maxTokens: num(row?.maxOutputLength) ?? 32_000,
    headers: agnescodeRequestHeaders(),
    // Same OpenAI-compat CN gateway family: pin the
    // classic `max_tokens` field and the legacy system role (the developer
    // role is unverified here — pin it false, the safe direction).
    compat: { maxTokensField: "max_tokens", supportsDeveloperRole: false }
  };
}

/**
 * Build the whole descriptor list for one AgnesCode roster.
 * @param {object[]} [roster] - the {@link agnescodeRoster} result.
 * @param {object} [options] - `{ bffBase }`.
 * @returns {object[]} the pi-ai descriptors.
 */
export function buildAgnescodeDescriptors(roster: any, options: { bffBase?: string } = {}) {
  const list = Array.isArray(roster) ? roster : agnescodeRoster(null);
  const out: ReturnType<typeof agnescodeToDescriptor>[] = [];
  const seen = new Set();
  for (const row of list) {
    const id = str(row?.id, "");
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push(agnescodeToDescriptor(row, options));
  }
  return out;
}
