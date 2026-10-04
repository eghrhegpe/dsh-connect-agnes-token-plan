/**
 * AgnesCode catalogue entry → pi-ai model descriptor mapping — the peer-free
 * half of the desktop-app upstream provider. Same peer-free
 * discipline: plain objects only (no Host peer import); `agnescode-llm-adapter.ts`
 * is the peer-dependent half.
 *
 * Three decisions carried here:
 *   1. `reasoning: true` + a BFF-specific `thinkingLevelMap` — probed LIVE on
 *      2026-10-03 against the per-account BFF (`agnes-3.0-flash`,
 *      `{bffBase}/v1/chat/completions`): the OpenAI-compatible `reasoning_effort`
 *      ladder `none`/`low`/`medium`/`high` is ACCEPTED (HTTP 200 under every
 *      one) and the BFF returns `message.reasoning_content` under each — even
 *      with NO thinking field at all (the v1 shape), which is why v1's
 *      `reasoning: false` never actually turned thinking off, it only hid the
 *      selector. `off` is `null` on purpose: `reasoning_effort:"none"` does NOT
 *      disable thinking (still 188 reasoning tokens), and the desktop App's real
 *      off switch (`request_params.agnes_thinking_enabled:false`) is not
 *      expressible in pi-ai's string-valued map. Offering "off" would promise
 *      "thinking off" and deliver "still thinking". `xhigh`/`max` stay closed
 *      until a probe proves them on the BFF.
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
import { PROBED_VISION } from "./llm-models.ts";
import { normalizeEnabledIds } from "./catalog-store.ts";

/**
 * The provider id this plugin registers under for AgnesCode.
 *
 * The bare product name, the same granularity the sibling `dsh-connect-workbuddy`
 * uses for `workbuddy` / `workbuddy-global`: the vendor is implied by the
 * plugin. (It used to be `agnes-agnescode`, which read as a stutter — the
 * vendor prefix repeated the product name that already carries "Agnes".)
 *
 * Deliberately NOT `sensenova-*`: the sibling plugin
 * `dsh-connect-sensenova-token-plan` registers those ids, and a duplicated id
 * is rejected by `registerAdapter` as DUPLICATE_ADAPTER — one of the two would
 * silently vanish from the picker (ARCHITECTURE.md §5). `agnescode` sits in
 * neither namespace, so that collision is impossible either way.
 */
export const AGNESCODE_PROVIDER_ID = "agnescode";

/** What the DSH model picker shows as the AgnesCode provider's name. */
export const AGNESCODE_DISPLAY_NAME = "AgnesCode";

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
 * Whether an AgnesCode roster row accepts image input.
 *
 * AgnesCode's own BFF `/models` rows declare no modality field — only
 * `model_type: "text"` and `supported_endpoint_types` — so the catalogue alone
 * would answer "no vision" for EVERY row (that is why `fetchAgnescodeCatalog`
 * pins `vision: false`). But AgnesCode serves the SAME Agnes model family the
 * Token Plan gateway does (`agnes-3.0-flash` / `agnes-2.5-flash` /
 * `agnes-2.5-pro` all appear in both rosters), whose official docs declare
 * image input — `PROBED_VISION` (llm-models.ts) is that evidence, and the
 * Token Plan side already probed `agnes-3.0-flash` accepting the standard
 * OpenAI `image_url` block live. Non-agnes ids (`deepseek-*` / `glm-*` /
 * `kimi-*`) have no such claim and stay text-only.
 *
 * Resolution order: the row's own `vision` (if the catalogue ever declares
 * one) wins, then `PROBED_VISION` for the Agnes family, then false.
 * @param {object} row - one AgnesCode roster row (must carry `id`).
 * @returns {boolean} whether the row accepts image input.
 */
export function agnescodeVisionOf(row: Record<string, unknown>) {
  if (row?.vision === true) return true;
  const id = str(row?.id, "");
  return (PROBED_VISION as Record<string, boolean>)[id] === true;
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
      // See `agnescodeVisionOf`: the catalogue declares no modality field, so
      // the Agnes family rows borrow `PROBED_VISION`'s official-doc evidence.
      vision: agnescodeVisionOf(row),
      memberOnly: row?.memberOnly === true,
      // The desktop App DOES show a per-model consumption factor, read from a
      // `points_cost_multiplier` field (label: "Credits per call"), but the
      // `/models` response THIS plugin reads does not carry it — probed live
      // 2026-10-04: 8 rows, no such key, and 12 candidate paths on the same
      // host all 404 (ROADMAP §6.3.1 「倍率字段补记」). So the field is not
      // absent platform-wide, it is simply not on this data source yet; the
      // roster therefore draws no rate chip, which is the honest shape until
      // the carrying response is located. `undefined` means "not read here",
      // NOT "the platform has no such concept".
      multiplier: typeof row?.multiplier === "number" ? row.multiplier : undefined,
      contextWindow: num(row?.contextWindow),
      maxOutputLength: num(row?.maxOutputLength)
    });
  }
  return out;
}

/**
 * Curate a roster with the panel's allow-list.
 *
 * The EMPTY list is the load-bearing convention (same as the Token Plan side):
 * no curation means the roster is pushed WHOLE, so a fresh install keeps the
 * old behaviour. Only a non-empty list filters — and it filters by the row's
 * `id`, the one fact both the checkbox and the descriptor are keyed on.
 * @param {object[]} rows - the {@link agnescodeRoster} result.
 * @param {unknown} enabledIds - the curated ids (empty = no filter).
 * @returns {object[]} the rows to publish.
 */
export function filterAgnescodeRows(rows: unknown, enabledIds: unknown) {
  const list = (Array.isArray(rows) ? rows : []) as Record<string, unknown>[];
  const ids = normalizeEnabledIds(enabledIds);
  if (ids.length === 0) return list;
  const keep = new Set(ids);
  return list.filter((row) => keep.has(str(row?.id, "")));
}

/**
 * The thinking level map this provider offers, keyed on pi-ai's ladder.
 *
 * The BFF's `reasoning_effort` ladder was probed live on 2026-10-03
 * (`agnes-3.0-flash`): `none`/`low`/`medium`/`high` are all ACCEPTED (HTTP 200)
 * — but `none` does NOT disable thinking (the response still carried
 * `reasoning_content`, 188 reasoning tokens). The desktop App's real off switch
 * is `request_params.agnes_thinking_enabled:false` (or
 * `request_params.thinking_effort:"off"`), which a string-valued thinking map
 * cannot emit. So `off` is DELIBERATELY `null`: offering it would promise
 * "thinking off" and deliver "still thinking" — the same class of silent lie
 * `docs/DSH-LLM-DEVELOP.md` §4 warns about for the opposite direction. The
 * levels pi-ai actually sends (`low`/`medium`/`high`) are the ones probed 200.
 * `xhigh`/`max` stay closed until a probe proves them on the BFF.
 * @returns {object} the level → wire-spelling map.
 */
export function agnescodeThinkingLevelMap() {
  return { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null };
}

/**
 * Map one AgnesCode row onto the pi-ai model descriptor the adapter offers.
 * @param {object} row - an {@link agnescodeRoster} row (must carry `id`).
 * @param {object} [options] - `{ bffBase }` — the pinned per-account base.
 * @returns {object} the pi-ai descriptor.
 */
export function agnescodeToDescriptor(row: Record<string, unknown>, options: { bffBase?: string } = {}) {
  const id = str(row?.id, "");
  if (id === "") throw new Error("agnescodeToDescriptor: row has no id");
  const bffBase = str(options.bffBase, "");
  if (bffBase === "") throw new Error("agnescodeToDescriptor: a pinned bffBase is required");
  const vision = agnescodeVisionOf(row);
  return {
    id,
    name: str(row?.name, id),
    api: "openai-completions",
    provider: AGNESCODE_PROVIDER_ID,
    baseUrl: bffBase,
    input: vision ? ["text", "image"] : ["text"],
    // See the module header: probed live 2026-10-03 — the BFF accepts
    // `reasoning_effort` none/low/medium/high and returns `reasoning_content`
    // under every one, so a thinking selector is honest here. `off` is null
    // (`agnescodeThinkingLevelMap`): the BFF's "none" does not disable thinking.
    reasoning: true,
    thinkingLevelMap: agnescodeThinkingLevelMap(),
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
export function buildAgnescodeDescriptors(roster: unknown, options: { bffBase?: string } = {}) {
  const list = (Array.isArray(roster) ? roster : agnescodeRoster(null)) as Record<string, unknown>[];
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
