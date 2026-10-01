/**
 * Catalog entry -> pi-ai model descriptor mapping — the pure half of the
 * directly-registered Agnes LLM provider ("one-stop service", step three).
 *
 * This module deliberately imports NO runtime peer (`@earendil-works/pi-ai`,
 * `@deepseek-ai/dsh-llm-pi-ai`): it builds plain objects only, so the mapping
 * decisions are testable on a clean checkout the same way the qoder fork keeps
 * its own pi-ai model mapping peer-free. `llm-adapter.ts` is the peer-dependent half
 * that hands these descriptors to `createProvider`.
 *
 * Two decisions carried here are load-bearing rather than cosmetic:
 *
 * 1. `compat.supportsDeveloperRole: false`. pi-ai picks the system-prompt role
 *    as `reasoning && supportsDeveloperRole ? "developer" : "system"`, and when
 *    the flag is unset it AUTO-DETECTS, returning true for anything that does
 *    not look like a known non-standard provider. Agnes's direct endpoint
 *    does not speak the developer role, so an unset flag makes every request
 *    403 forever. Setting it false is the fix the qoder route proved necessary.
 * 2. `maxTokens` IS declared, pinned to the probed platform cap
 *    (`PROBED_MAX_TOKENS`, 65536 — the constant carries the probe evidence).
 *    The original decision here was "no value": a declared value becomes the
 *    output ceiling and pi-ai sends it as `max_tokens`, truncating long
 *    replies with `finish: max-tokens`. But "no value" never meant "no
 *    ceiling" — the harness registration (`dsh-llm-pi-ai` `resolveEntry`)
 *    requires a positive integer and fills undeclared models with its own
 *    `DEFAULT_MAX_TOKENS = 32768`, HALF the platform's ceiling, with the
 *    thinking phase sharing that same budget. Declaring the cap can only lift
 *    the truncation point, never lower it. The compat pin stays the field
 *    NAME (`max_tokens`) only.
 * 3. `reasoning: true` + a `thinkingLevelMap`. Agnes chat models think by
 *    default (verified 2026-09-29: default reasoning_effort high, thinking
 *    text returned as `reasoning` on flash-lite and `reasoning_content` on
 *    deepseek/glm/kimi — pi-ai reads both spellings). `reasoning: true` is
 *    what makes DSH offer the 思考强度 selector and what makes pi-ai surface
 *    the thinking. Note this is set UNCONDITIONALLY rather than read off a
 *    capability flag: the Agnes catalog carries no `supported_features` field
 *    at all (live-verified 2026-10-01), so there is nothing to read. The map
 *    pins picker levels to platform-valid wire values:
 *    `off: "none"` (the platform's off spelling — "off" itself 400s),
 *    `minimal: null` (unverified on this gateway), and the extended levels
 *    strictly per the live ladder (2026-10-01: `max` on every Agnes chat
 *    model, `xhigh` on agnes-3.0-flash only — see PROBED_EFFORT).
 *
 * @module dsh-connect-agnes-token-plan/llm-models
 */

import { str, num } from "./util.ts";
import { identifyVisionModel } from "./parsers.ts";
import { isChatModel } from "./modality.ts";
import type { AdapterConfig } from "./types.ts";

/**
 * The provider id this plugin registers under.
 *
 * It must NOT be the bare `"Agnes"`: a hand-written `llm-pi-ai` row using
 * that id can already exist in an operator's profile (apiKeyEnv
 * `AGNES_TOKEN_PLAN_API_KEY`, base `https://api.agnes-ai.cn/v1`), and
 * `registerAdapter` with a colliding id is refused as a duplicate. This own
 * slug-shaped id cannot collide with that row or with another plugin.
 */
export const LLM_PROVIDER_ID = "agnes-token-plan";

/** What the DSH model picker shows as the provider's name. */
export const LLM_DISPLAY_NAME = "Agnes Token Plan";

/**
 * The thinking effort the profile pins as DSH's "Default" on this provider.
 *
 * One constant for two claims: `llm-adapter.ts` pins it into the profile, and
 * the snapshot echoes it to the panel roster, so the number the user reads is
 * the number the adapter dispatches. Editing one without the other is now
 * impossible by construction.
 */
export const DEFAULT_REASONING_EFFORT = "high";

/**
 * Per-token prices are unknowable for a quota plan; report zero everywhere.
 *
 * ⚠️ The zeros are a SENTINEL, not "free". Agnes Token Plan is a credit
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
 * 128k is the conservative Agnes-family default; a catalog field that
 * states a real window always wins.
 */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * The per-request output ceiling the Agnes gateway enforces, probed live.
 *
 * Evidence (2026-10-01, `api.agnes-ai.cn/v1/chat/completions`, `reasoning_effort:
 * "high"`): `max_tokens: 32768` and `max_tokens: 65536` answered 200 on
 * agnes-2.5-flash (65536 re-confirmed on agnes-2.0-flash), omitting the field
 * entirely also answered 200, and `max_tokens: 131072` answered 400 with the
 * platform's own refusal text `max_tokens 不能超过 65536` — the cap is stated
 * by the platform, not inferred. The catalog carries no `max_output_length`
 * field to read (AGNES-API.md §7.1), so this probed constant stands in for
 * the missing declaration.
 *
 * Declaring it is NOT the truncation risk the original "no value" decision
 * feared: the harness fills undeclared models with `DEFAULT_MAX_TOKENS =
 * 32768`, so the only real choice was "half the cap" vs "the cap" (module
 * header, decision 2). If the platform ever starts declaring per-model
 * `max_output_length`, adopt it ONLY after a live-contract probe re-run —
 * catalog values are leads, not contracts (PITFALLS §20).
 */
export const PROBED_MAX_TOKENS = 65_536;

/**
 * Read a positive context window off the catalog entry's known spellings.
 *
 * `context_length` is the field the platform actually emits (verified against
 * the live catalog, 2026-09); the other spellings are kept as fallbacks in
 * case the platform ever reverts to a different name. Agnes's `/v1/models`
 * entries are kept whole by `console-client.ts`, so a field the platform adds
 * later needs no parser change here — only its name has to be added to this
 * list.
 * @param {object} entry - one normalized catalog entry.
 * @returns {number} the declared window, or the fallback.
 */
export function contextWindowOf(entry) {
  for (const key of ["context_length", "context_window", "contextWindow", "max_context_tokens"]) {
    const value = Math.floor(num(entry?.[key], 0));
    if (value > 0) return value;
  }
  return FALLBACK_CONTEXT_WINDOW;
}

/**
 * Read the platform's declared per-request output ceiling, 0 when unknown.
 *
 * This is a DISPLAY fact only. The descriptor pins the PROBED platform cap
 * (`PROBED_MAX_TOKENS`, module header decision 2) as its request parameter;
 * this roster figure still reads the catalog, which on Agnes declares nothing
 * (0 = the panel draws no segment — never guess). It says what the platform
 * can emit at most per the catalog's own claim, so the user learns why a long
 * reply can still stop with `finish_reason: length`.
 * Same spelling-first policy as {@link contextWindowOf}.
 * @param {object} entry - one normalized catalog entry.
 * @returns {number} the declared ceiling, or 0 when the entry states none.
 */
export function maxOutputLengthOf(entry) {
  for (const key of ["max_output_length", "maxOutputLength", "max_output_tokens"]) {
    const value = Math.floor(num(entry?.[key], 0));
    if (value > 0) return value;
  }
  return 0;
}

/**
 * Whether a catalog entry can be addressed as a CHAT model on this provider's
 * OpenAI-compatible endpoint.
 *
 * Delegated to `modality.ts` so this roster and the draw tool's candidate list
 * resolve modalities through the SAME function — ARCHITECTURE §5.4's "the two
 * lists can never disagree" is now a property of the code rather than a
 * promise between two copies. The catalog also lists image and video
 * GENERATION models (`agnes-image-*`, `agnes-video-*`): they answer 400 on
 * `/v1/chat/completions` naming the endpoint they do want ("请使用
 * /v1/images/generations"), so offering them here only produces errors in DSH.
 *
 * The previous local copy treated a missing `output_modalities` as "chat"
 * (permissive). That was defensible on a gateway that might start sending the
 * field, and actively wrong on the Agnes gateway, which sends no modality
 * metadata at all (live-verified 2026-10-01) — it put every image and video
 * model into the picker. See `modality.ts` for the resolution order.
 * @param {object} entry - one normalized catalog entry.
 * @returns {boolean} whether the entry is usable as a chat model.
 */
export { isChatModel };

/**
 * The picker's 思考强度 levels, pinned to platform-valid wire spellings.
 *
 * DSH's picker offers levels from `getSupportedThinkingLevels(model)`
 * (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`), and pi-ai's
 * openai-completions dispatch sends `reasoning_effort = map[level] ?? level`.
 * Agnes's OpenAI-compat gateway rejects `off` (the OpenAI spelling) and
 * `minimal`; the extended levels are PER-MODEL, per the 2026-10-01 live
 * ladder (see PROBED_EFFORT): `xhigh` only on agnes-3.0-flash, `max` on
 * every Agnes chat model. So:
 *
 * - `off: "none"` — the picker's "关闭" must send `none`, not `off`;
 *   - `low`/`medium` — 200 on every known chat model; a model ABSENT from
 *     the table (an unknown id) still gets them via the Agnes safe-set so
 *     the picker is never empty. A model PRESENT in the table with a level
 *     set `false` keeps it closed. The live-contract replay
 *     (`test/live-contract.mjs`) probes the per-model levels and flips the
 *     table cells once a model's 200 is recorded.
 * - `xhigh`/`max` — per the table; the safe-set keeps both closed for
 *   unknown ids.
 *
 * A value of `null` means "the picker must not offer this level"; a string is
 * the wire spelling the level dispatches to.
 * @param {object} entry - one normalized catalog entry.
 * @returns {object} the thinkingLevelMap.
 */
/**
 * Per-model 思考档位 probe table (frozen 2026-10-01 from the live ladder
 * replay, mirrored from `test/baselines/agnes-contract.json`
 * §reasoningEffort — every cell is a platform answer, not a guess).
 *
 * The baseline records which `reasoning_effort` values the platform
 * answered 200 for per model (full ladder none/low/medium/high/xhigh/max,
 * max_tokens=8; 429 cells re-run clean before recording):
 *   - `high` — the platform default for every chat model;
 *   - `none` — thinking off, 200 on every model (the message drops the
 *     reasoning field entirely);
 *   - `low` / `medium` — 200 on every chat model;
 *   - `xhigh` — ONLY agnes-3.0-flash. On 2.0/2.5 the platform 400s and its
 *     validator states the union itself: "Input should be 'none', 'low',
 *     'medium', 'high' or 'max'" — xhigh is not in it. 3.0-flash's upstream
 *     runs a wider validator and answers 200.
 *   - `max` — 200 on EVERY Agnes chat model. A real dialect flip from the
 *     SenseNova era, where max was glm-5.2-only: the table follows the
 *     platform per model, never the family history.
 *
 * The panel roster line must not quote a level the platform may 400 on.
 * A model ABSENT from this table (an unknown / future id) is offered the
 * safe OpenAI-compatible set — `off`→`none`, plus `low`/`medium`/`high` —
 * while `xhigh`/`max` stay closed until a live-contract probe proves them
 * on that specific model. A model PRESENT here (even all-`false`) is a
 * known id whose closed levels stay closed even where the safe-set would
 * open them. A new model that turns out to accept an extra level is added
 * here WITH its probe evidence (the baseline's `driftLog` discipline),
 * never assumed.
 */
const PROBED_EFFORT = Object.freeze({
  "agnes-2.0-flash": { low: true, medium: true, high: true, xhigh: false, max: true },
  "agnes-2.5-flash": { low: true, medium: true, high: true, xhigh: false, max: true },
  "agnes-3.0-flash": { low: true, medium: true, high: true, xhigh: true, max: true }
});

export function thinkingLevelMapFor(entry) {
  const id = str(entry?.id, "");
  const probed = PROBED_EFFORT[id];
  if (!probed) {
    // Agnes: the provider row advertises low/medium/high, so a model with no
    // per-model probe is offered the safe OpenAI-compatible set
    // (off→none, low/medium/high). The extended xhigh/max levels stay closed
    // until a live-contract probe proves them on a specific model.
    return { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null };
  }
  return {
    off: "none",
    minimal: null,
    // low/medium: per-model, gated on the probe table.
    low: probed?.low === true ? "low" : null,
    medium: probed?.medium === true ? "medium" : null,
    // high: the platform default on every chat model; always offered.
    high: "high",
    // Extended levels: only a 200 probe for THIS model opens the level.
    xhigh: probed?.xhigh === true ? "xhigh" : null,
    max: probed?.max === true ? "max" : null
  };
}

/** pi-ai's escalation ladder (`EXTENDED_THINKING_LEVELS`, dist/models.js:550). */
const THINKING_LADDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The thinking levels DSH's selector will actually offer for one model.
 *
 * This mirrors pi-ai's `getSupportedThinkingLevels` (dist/models.js:551)
 * against OUR map: walk the ladder, drop levels the map pins to `null`, and
 * treat `xhigh`/`max` as opt-in (they must be present and non-null). DSH
 * builds the model-settings effort list through exactly that function, so a
 * roster row quoting this list cannot disagree with what the picker lets the
 * user select — one contract, both ends. If pi-ai's rule ever changes, this
 * filter changes with it (pinned by test/render + routes).
 * @param {object} entry - one normalized catalog entry.
 * @returns {string[]} level ids in escalation order, e.g. ["off","low",...].
 */
export function supportedThinkingLevels(entry) {
  const map = thinkingLevelMapFor(entry);
  return THINKING_LADDER.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/**
 * Map one catalog entry onto the pi-ai model descriptor the adapter offers.
 *
 * Vision is the SAME identification the snapshot publishes
 * (`identifyVisionModel`: the platform's `input_modalities` first, the name
 * fallback only when no structured field exists) — so the model picker cannot
 * disagree with the panel's vision list about which models accept images.
 * @param {object} entry - one normalized catalog entry (must carry `id`).
 * @param {object} [options] - wiring.
 * @param {string} [options.providerId] - the provider id the descriptor belongs to.
 * @param {string} [options.baseUrl] - the OpenAI-compatible base URL.
 * @returns {object} the pi-ai descriptor.
 */
export function toPiDescriptor(entry: any, options: AdapterConfig = {}) {
  const { providerId = LLM_PROVIDER_ID, baseUrl } = options;
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
    // Every Agnes chat model thinks by default. The flag is set unconditionally
    // because the catalog advertises no capability field to read (it sends no
    // `supported_features` at all); see the module header (decision 3) for why
    // the flag is true and what the map pins.
    reasoning: true,
    thinkingLevelMap: thinkingLevelMapFor(entry),
    cost: { ...NO_COST },
    contextWindow: contextWindowOf(entry),
    // `supportsDeveloperRole: false` is load-bearing — see the module header.
    // maxTokens pins the probed platform cap (decision 2): leaving it undeclared
    // meant the harness default 32768, half of what the platform accepts.
    maxTokens: PROBED_MAX_TOKENS,
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
 * The id that stands for "nothing is offered".
 *
 * An empty allow-list already means "no filter", so there has to be a second
 * spelling for "the filter matched nothing": a string that can never be a real
 * model id, kept as the list's only entry. `filterByEnabled` then filters by
 * an id that matches nothing, which is the offer the user asked for. A bare
 * `[]` cannot mean both "all models" and "no models" at once.
 *
 * The panel carries the SAME literal (`client.js` `HIDE_ALL_MODELS`) because
 * the browser bundle cannot import this module; `test/provider.test.mjs` pins
 * the two together so a rename on either side goes red.
 */
export const HIDE_ALL_MODELS = "__hide_all__";

/**
 * Whether one model id would be offered for a given allow-list.
 *
 * Mirrors {@link filterByEnabled}: an empty list offers everything, a
 * non-empty list is a strict allow-list, and the {@link HIDE_ALL_MODELS}
 * sentinel offers nothing.
 * @param {string[]|undefined} enabledIds - the allow-list; positionally required,
 *   though `undefined`/non-array is tolerated at runtime (treated as empty).
 * @param {string} id - the model id to ask about.
 * @returns {boolean}
 */
export function isModelEnabled(enabledIds, id) {
  const list = Array.isArray(enabledIds) ? enabledIds : [];
  if (list.length === 0) return true;
  return list.includes(str(id, ""));
}

/**
 * The panel-facing roster: one row per addressable catalog entry.
 *
 * Deliberately a projection, not the raw entries: the snapshot carries no
 * more than the picker needs (id, a display name, and the same vision
 * verdict the descriptors use), so a catalogue field the platform adds later
 * cannot leak into the panel for no reason.
 *
 * Deduping keeps the LAST occurrence at its first-seen position, exactly like
 * {@link buildDescriptors} and `catalog-store.normalizeEntries`: a fresher
 * read of the same id wins. If this diverged, the roster and the registered
 * offer would disagree about which models exist, and a ticked model could
 * become an unregistered one.
 * @param {object[]} entries - the normalized catalog entries.
 * @returns {{id: string, name: string, vision: boolean}[]}
 */
export function rosterOf(entries) {
  const position = new Map();
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    // Image-generation models are not chat models and are not offered (see
    // `isChatModel`): the roster and the registered offer must agree about
    // which models exist, or a ticked model could become an unregistered one.
    if (!isChatModel(entry)) continue;
    const id = str(entry?.id, "");
    if (id === "") continue;
    const row = {
      id,
      name: str(entry?.name, id),
      vision: identifyVisionModel(entry).vision === true
    };
    if (position.has(id)) {
      out[position.get(id)] = row;
    } else {
      position.set(id, out.length);
      out.push(row);
    }
  }
  return out;
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
export function buildDescriptors(entries: any[], options: AdapterConfig = {}) {
  const { providerId = LLM_PROVIDER_ID, baseUrl, enabledIds = [], unavailableModelIds = [] } = options;
  // Image- and video-generation models cannot be addressed as chat models
  // (`modality.ts` resolves which entries those are) and are excluded BEFORE
  // the allow-list, so a stale id in `enabledIds` matches nothing rather than
  // resurrecting one.
  const blocked = new Set(Array.isArray(unavailableModelIds) ? unavailableModelIds : []);
  const filtered = filterByEnabled(entries, enabledIds).filter(isChatModel);
  const seen = new Map();
  const out = [];
  for (const entry of Array.isArray(filtered) ? filtered : []) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const id = str(entry.id, "");
    if (id === "") continue;
    // A model the Host has declared unavailable would answer every request with
    // an error the user cannot act on, so the picker must not offer it — the
    // panel (via `rosterWithAvailability`) still shows it, greyed, with the
    // reason. Skipping here means a doomed request is never even dispatched.
    if (blocked.has(id)) continue;
    if (!seen.has(id)) {
      seen.set(id, out.length);
      out.push(undefined);
    }
    out[seen.get(id)] = toPiDescriptor({ ...entry, id }, { providerId, baseUrl });
  }
  return out;
}

/**
 * The panel-facing roster with per-model availability.
 *
 * Like {@link rosterOf} it projects one row per chat-model id, but each row also
 * carries whether the model is currently callable — the "清单自带识别" the
 * provider advertises to the panel. Unlike the PICKER (which drops blocked
 * models via `buildDescriptors` so no doomed request is dispatched), the panel
 * keeps them in the list, greyed, so the user can see *why* a model is missing
 * from the picker rather than wondering where it went.
 *
 * `blockedIds` is handed IN rather than derived here, because what makes a
 * model unavailable is a platform fact, not a roster fact. On Agnes the answer
 * is currently always "nothing is blocked": the platform allocates no quota per
 * model, and its account-wide request window cannot be read as a remaining
 * figure (the console reports cumulative usage, not a balance), so silently
 * emptying the picker would hide the models for a reason the panel could not
 * explain. Account-level exhaustion is surfaced as a panel line instead.
 * @param {object[]} entries - the normalized catalog entries.
 * @param {string[]} [blockedIds] - model ids to report as unavailable.
 * @returns {{id: string, name: string, vision: boolean, available: boolean, quotaExhausted: boolean, contextWindow: number, maxOutputLength: number, thinkingLevels: string[]}[]}
 */
export function rosterWithAvailability(entries, blockedIds = []) {
  const blocked = new Set(Array.isArray(blockedIds) ? blockedIds : []);
  const position = new Map();
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isChatModel(entry)) continue;
    const id = str(entry?.id, "");
    if (id === "") continue;
    const row = {
      id,
      name: str(entry.name, id),
      vision: identifyVisionModel(entry).vision === true,
      available: !blocked.has(id),
      quotaExhausted: blocked.has(id),
      // The window the descriptor itself will use: a declared `context_length`
      // when the catalog has one, else the same 128k fallback pi-ai gets —
      // so the badge never contradicts the effective behavior.
      contextWindow: contextWindowOf(entry),
      // The platform's declared output ceiling (0 = unknown). Widening the
      // projection here is deliberate: the raw entry stays Host-side, and the
      // panel quotes only these two parameter figures plus the vision verdict.
      maxOutputLength: maxOutputLengthOf(entry),
      // What the DSH selector will really offer this model (same rule pi-ai
      // applies to the registered descriptor) — the per-model fact worth
      // repeating on a row, unlike the provider-wide default, which the panel
      // states once in its header.
      thinkingLevels: supportedThinkingLevels(entry)
    };
    if (position.has(id)) {
      out[position.get(id)] = row;
    } else {
      position.set(id, out.length);
      out.push(row);
    }
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
  const list = (Array.isArray(entries) ? entries : []).filter(isChatModel);
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
