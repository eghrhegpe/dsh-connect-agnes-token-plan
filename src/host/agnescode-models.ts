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
 *      until a probe proves them on the BFF — the one carve-out is
 *      `agnes-2.5-pro`, whose live 400 on `high` (2026-10-18, platform text:
 *      "Supported types are xhigh (default), medium, and low") proves `xhigh`
 *      and rules out `high`; its map aliases `high` → `xhigh` (see
 *      `agnescodeThinkingLevelMap`).
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

import { str, num, numZeroOk } from "./util.ts";
import { AGNESCODE_BASE_HEADERS, AGNESCODE_FALLBACK_MODELS } from "./agnescode.ts";
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

/**
 * This model's output ceiling when the live roster row carries none.
 *
 * The old code wrote `num(row?.maxOutputLength) ?? 32_000` — an INVENTED number
 * that exists nowhere else: below the harness's own `defaultMaxTokens` (32768),
 * far below the ceilings `AGNESCODE_FALLBACK_MODELS` states for most of these
 * models (65_536 … 393_216), and below the platform cap the sibling token-plan
 * route probed (65_536). A row that merely stopped carrying the field would
 * therefore have silently cut users to a fraction of their real budget, with
 * nothing anywhere saying so.
 *
 * So: prefer THIS model's own statement in the fallback table (the same table
 * `agnescodeRoster` already falls back to when the catalogue is unavailable,
 * so the two paths cannot disagree), and return `undefined` — omit the key, let
 * pi-ai's `defaultMaxTokens ?? 32768` take over — only when the model is in
 * neither place. Never a number invented here.
 *
 * @param {string} id - the model id (already known non-empty by the caller).
 * @param {unknown} declared - the roster row's own `maxOutputLength` reading.
 * @param {Record<string, number>|null} [overrides] - the operator's exact-id
 *   ceiling map (`maxTokensOverrides`, already sanitized).
 * @returns {number|undefined} the ceiling to declare, or `undefined` to omit.
 */
export function agnescodeMaxTokensFor(
  id: string,
  declared: unknown,
  overrides?: Record<string, number> | null
): number | undefined {
  const override = overrides?.[id];
  if (typeof override === "number" && Number.isInteger(override) && override > 0) return override;
  const own = num(declared);
  if (own !== undefined) return own;
  const known = (AGNESCODE_FALLBACK_MODELS as readonly { id: string; maxOutputLength?: number }[]).find((row) => row.id === id);
  return num(known?.maxOutputLength);
}

/** The zero-cost sentinel: per-token prices are unknowable (credit-gated). */
const NO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** The catalogue/identity headers every request carries (probed: required).
 * The anonymous half of one pair: `agnescodeHeaders`' map with its
 * `Authorization` line removed. The gate values come from
 * `AGNESCODE_BASE_HEADERS`, never a second copy here, so the two builders
 * cannot disagree. */
export function agnescodeRequestHeaders() {
  return { ...AGNESCODE_BASE_HEADERS };
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
export function agnescodeRoster(catalog: unknown, maxTokensOverrides?: Record<string, number> | null) {
  const rows = Array.isArray(catalog) && catalog.length > 0 ? catalog : AGNESCODE_FALLBACK_MODELS;
  const out: Array<{ id: string; name: string; vision: boolean; memberOnly: boolean; multiplier?: number; contextWindow: number; maxOutputLength: number }> = [];
  for (const row of rows) {
    const id = str(row?.id, "");
    if (id === "") continue;
    const multiplier = numZeroOk(row?.multiplier);
    // The SAME resolver the descriptor build uses, so the badge the user reads
    // and the `max_tokens` the request carries cannot disagree. `0` is the
    // roster's existing "nothing stated" encoding (the panel draws no segment).
    const maxOutputLength = agnescodeMaxTokensFor(id, row?.maxOutputLength, maxTokensOverrides);
    out.push({
      id,
      name: str(row?.name, id),
      // See `agnescodeVisionOf`: the catalogue declares no modality field, so
      // the Agnes family rows borrow `PROBED_VISION`'s official-doc evidence.
      vision: agnescodeVisionOf(row),
      memberOnly: row?.memberOnly === true,
      // `0` is a PUBLISHED PRICE ("free"), not a missing reading — read it
      // ONCE (the codebase's read-once discipline) and let an absent field
      // stay absent rather than become an explicit `undefined`, or
      // `exactOptionalPropertyTypes` rejects the row.
      ...(multiplier === undefined ? {} : { multiplier }),
      contextWindow: num(row?.contextWindow),
      maxOutputLength: maxOutputLength ?? 0
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
 *
 * PER-MODEL since 2026-10-18: a live session 400ed `agnes-2.5-pro` with
 * `reasoning_effort:"high"` — the platform's validator answered "Unexpected
 * reasoning effort high. Supported types are xhigh (default), medium, and
 * low". That model's ladder has NO `high`; its top is `xhigh`, which is also
 * its DEFAULT. The map keeps `high` OFFERED — the profile pins
 * `DEFAULT_REASONING_EFFORT` ("high") PROVIDER-WIDE, and dsh-llm-pi-ai THROWS
 * `UNSUPPORTED_REASONING_EFFORT` when the requested level is absent from the
 * model's supported set, so closing `high` would break the Default on every
 * request to this model — but dispatches it to the wire spelling the platform
 * accepts: `xhigh` (the platform default, so the Default keeps meaning "the
 * platform default"). `xhigh` is opened for this model too: the same live 400
 * text proves the platform accepts it. Every other id keeps the shared ladder.
 * @param {string} id - the model id.
 * @returns {object} the level → wire-spelling map.
 */
export function agnescodeThinkingLevelMap(id: string) {
  if (id === "agnes-2.5-pro") {
    return { off: null, minimal: null, low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh", max: null };
  }
  return { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null };
}

/**
 * Map one AgnesCode row onto the pi-ai model descriptor the adapter offers.
 * @param {object} row - an {@link agnescodeRoster} row (must carry `id`).
 * @param {object} [options] - `{ bffBase }` — the pinned per-account base.
 * @returns {object} the pi-ai descriptor.
 */
export function agnescodeToDescriptor(
  row: Record<string, unknown>,
  options: { bffBase?: string; maxTokensOverrides?: Record<string, number> | null } = {}
) {
  const id = str(row?.id, "");
  if (id === "") throw new Error("agnescodeToDescriptor: row has no id");
  const bffBase = str(options.bffBase, "");
  if (bffBase === "") throw new Error("agnescodeToDescriptor: a pinned bffBase is required");
  const vision = agnescodeVisionOf(row);
  // The credit multiplier is billing metadata pi-ai has no channel for (the
  // descriptor's `cost` is per-token USD, which this credit-gated gateway does
  // not have — see `NO_COST`), so it rides in the display name, the one
  // surface the DSH model picker renders. The panel's roster shows the same
  // figure, so the two views cannot disagree.
  //
  // Spelled `· x0.00` — the `·` + `x` form the sibling SenseNova plugin and
  // WorkBuddy's own selector already use, so a second convention would read as
  // noise. A zero multiplier renders `· x0.00` (it means free, a real price);
  // an absent one keeps the bare name (no claim at all).
  const multiplier = numZeroOk(row?.multiplier);
  const name = str(row?.name, id);
  const displayName = multiplier === undefined ? name : `${name} · x${multiplier.toFixed(2)}`;
  // Read ONCE (the codebase's read-once discipline — see `multiplier` above and
  // `agnescodeRoster`'s note): two reads could disagree if the source mutated
  // between them, and the descriptor could then claim a `maxTokens` the panel
  // does not show.
  const maxTokens = agnescodeMaxTokensFor(id, row?.maxOutputLength, options.maxTokensOverrides);
  return {
    id,
    name: displayName,
    api: "openai-completions",
    provider: AGNESCODE_PROVIDER_ID,
    baseUrl: bffBase,
    input: vision ? ["text", "image"] : ["text"],
    // See the module header: probed live 2026-10-03 — the BFF accepts
    // `reasoning_effort` none/low/medium/high and returns `reasoning_content`
    // under every one, so a thinking selector is honest here. `off` is null
    // (`agnescodeThinkingLevelMap`): the BFF's "none" does not disable thinking.
    reasoning: true,
    thinkingLevelMap: agnescodeThinkingLevelMap(id),
    cost: { ...NO_COST },
    // A positive window is required (pi-ai does arithmetic on it); the
    // AgnesCode catalogue always declares one, but guard against shape drift.
    contextWindow: num(row?.contextWindow) ?? 512_000,
    // `agnescodeMaxTokensFor` owns the fallback chain (this row → this model's
    // own fallback-table line → omit). **Not** a locally invented constant: the
    // old `?? 32_000` sat below every figure either source states.
    ...(maxTokens === undefined ? {} : { maxTokens }),
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
 * @param {object} [options] - `{ bffBase, maxTokensOverrides }`.
 * @returns {object[]} the pi-ai descriptors.
 */
export function buildAgnescodeDescriptors(
  roster: unknown,
  options: { bffBase?: string; maxTokensOverrides?: Record<string, number> | null } = {}
) {
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
