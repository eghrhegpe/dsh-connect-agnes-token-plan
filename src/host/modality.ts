/**
 * The single source of truth for "what can this catalog entry produce?".
 *
 * WHY THIS MODULE EXISTS — a design premise that did not survive contact with
 * the live gateway.
 *
 * ARCHITECTURE §5.4 decided model identification would be STRUCTURED rather
 * than name-regex, to fix `dsh-draw-router` missing `Agnes-u1.5-lite`. That
 * decision was taken against the SenseNova catalog, whose `/v1/models` entries
 * carry `output_modalities` / `input_modalities` / `context_length` /
 * `supported_features`. The Agnes gateway (new-api lineage — its `success` and
 * `supported_endpoint_types` fields are the tell) returns NONE of them
 * (live-verified 2026-10-01):
 *
 *   {"id":"agnes-image-2.5-flash","object":"model","created":1626777600,
 *    "owned_by":"custom","supported_endpoint_types":["openai"]}
 *
 * On Agnes the structured premise is therefore void, and BOTH readers of the
 * absent field silently went wrong in OPPOSITE directions — exactly the
 * disagreement §5.4 promised could never happen:
 *
 *   - `isImageGenModel` was strict ("missing = unknown = not an image model"),
 *     so the draw tool could never pick a model at all — it reported "catalog
 *     中没有出图模型" while the catalog was full of them;
 *   - `isChatModel` was permissive ("missing = chat"), so every image and video
 *     model landed in the chat picker, and each one 400s on first use
 *     ("模型 agnes-video-v2.0 是 video 模型，请使用 /v1/videos").
 *
 * Both predicates now resolve through {@link outputModalitiesOf}, so the two
 * lists cannot disagree by construction — the §5.4 intent, restored on a
 * catalog that has no field to be structured about.
 *
 * THREE RESOLUTION LEVELS, in precedence order:
 *
 *   1. DECLARED — `output_modalities` (or a known sibling spelling) is an
 *      array. Always wins, so a gateway that starts shipping the field takes
 *      over automatically with no code change here.
 *   2. INFERRED — no field, but the id carries the family segment the platform
 *      itself uses: `agnes-image-*` → image, `agnes-video-*` → video.
 *   3. ASSUMED — no field, no family segment: `["text"]`, i.e. a chat model.
 *
 * The name patterns are deliberately NARROW: they match a whole `image` /
 * `video` path segment, never a substring. The `dsh-draw-router` lesson still
 * holds — a loose substring regex is how its `/u1-fast/i` missed `u1.5-lite` —
 * so the fallback matches the platform's own naming convention exactly instead
 * of guessing at shapes it has never seen. `agnes-2.5-pro` and
 * `agnes-3.0-flash` are untouched by it, which is the point.
 *
 * @module dsh-connect-agnes-token-plan/modality
 */

import { str } from "./util.ts";

/** The modality token meaning "this entry produces images". */
export const IMAGE_MODALITY = "image";

/** The modality token meaning "this entry produces video". */
export const VIDEO_MODALITY = "video";

/** The modality token meaning "this entry produces text" — the chat default. */
export const TEXT_MODALITY = "text";

/**
 * The field spellings that may carry an entry's OUTPUT modalities.
 *
 * Mirrors `parsers.ts`'s input-side key list (`input_modalities` +
 * `inputTypes`): the snake_case platform field first, then the camelCase
 * sibling other gateways are expected to use. An unknown spelling is not
 * guessed at — it degrades to the name fallback, which is visible in the
 * resolution `source`.
 */
const OUTPUT_MODALITY_KEYS = Object.freeze(["output_modalities", "outputTypes"]);

/**
 * The Agnes family segment marking an image-generation model.
 *
 * Matches `agnes-image-2.1-flash` / `agnes-image-2.5-flash`; requires the
 * segment to stand alone (bounded by `-`, `_`, or the string ends) so a
 * hypothetical `imageservice` cannot be caught by accident.
 */
const IMAGE_ID_PATTERN = /(?:^|[-_])image(?:[-_]|$)/i;

/**
 * The Agnes family segment marking a video-generation model.
 *
 * Matches `agnes-video-2.5`, `agnes-video-2.5-flash` and `agnes-video-v2.0`.
 */
const VIDEO_ID_PATTERN = /(?:^|[-_])video(?:[-_]|$)/i;

/**
 * Read the DECLARED output modalities off a catalog entry, or `null`.
 *
 * `null` means "the platform said nothing" — the caller falls through to the
 * name fallback. An array the platform DID send is honoured verbatim, empty
 * array included: "declared nothing" is still a declaration, and overriding it
 * with a name guess would put the fallback above the platform's own word.
 * @param {object} entry - one normalized catalog entry.
 * @returns {string[]|null} lowercased modality names, or `null` when absent.
 */
export function declaredOutputModalities(entry: Record<string, unknown>) {
  if (entry === null || typeof entry !== "object") return null;
  for (const key of OUTPUT_MODALITY_KEYS) {
    const value = entry[key];
    if (!Array.isArray(value)) continue;
    return value.map((item) => str(item, "").toLowerCase()).filter((item) => item !== "");
  }
  return null;
}

/**
 * Resolve an entry's output modalities, and how they were decided.
 *
 * The `source` is part of the contract, not a debug extra: `"inferred"` and
 * `"assumed"` mean the answer is this plugin's reading of a naming convention
 * rather than the platform's own statement, and any surface that presents the
 * answer as fact (the panel's per-model capability line, a future video tool's
 * "not available" message) is expected to say so.
 * @param {object} entry - one normalized catalog entry.
 * @returns {{modalities: string[], source: "declared"|"inferred"|"assumed"}}
 */
export function outputModalitiesOf(entry: Record<string, unknown>) {
  const declared = declaredOutputModalities(entry);
  if (declared !== null) return { modalities: declared, source: "declared" };
  const id = str(entry?.id, "");
  const inferred: string[] = [];
  if (IMAGE_ID_PATTERN.test(id)) inferred.push(IMAGE_MODALITY);
  if (VIDEO_ID_PATTERN.test(id)) inferred.push(VIDEO_MODALITY);
  if (inferred.length > 0) return { modalities: inferred, source: "inferred" };
  return { modalities: [TEXT_MODALITY], source: "assumed" };
}

/**
 * Whether one catalog entry is an image-GENERATION model.
 *
 * The predicate the draw tool picks its candidates with. It stays on the
 * conservative side of a false positive — sending a draw request to a model
 * that cannot answer produces an error the agent cannot act on — but "no
 * signal at all" no longer means "no" on a gateway that never sends a signal.
 * @param {object} entry - one normalized catalog entry.
 * @returns {boolean}
 */
export function isImageGenModel(entry: Record<string, unknown>) {
  return outputModalitiesOf(entry).modalities.includes(IMAGE_MODALITY);
}

/**
 * Whether one catalog entry is a video-generation model.
 *
 * Exists so the chat exclusion can name what it is excluding, and so a future
 * video tool has one predicate to share rather than a second regex of its own.
 * @param {object} entry - one normalized catalog entry.
 * @returns {boolean}
 */
export function isVideoGenModel(entry: Record<string, unknown>) {
  return outputModalitiesOf(entry).modalities.includes(VIDEO_MODALITY);
}

/**
 * Whether a catalog entry can be addressed as a CHAT model on this provider's
 * OpenAI-compatible endpoint.
 *
 * Image and video models answer 400 on `/v1/chat/completions` with a message
 * naming the endpoint they DO want ("请使用 /v1/images/generations"), so
 * offering them in the picker only produces errors in DSH. This shares
 * {@link outputModalitiesOf} with {@link isImageGenModel} precisely so the
 * chat roster and the draw candidate list can never disagree about which
 * entries exist — the invariant §5.4 wanted, now enforced in one place instead
 * of promised across two.
 * @param {object} entry - one normalized catalog entry.
 * @returns {boolean} whether the entry is usable as a chat model.
 */
export function isChatModel(entry: Record<string, unknown>) {
  const { modalities } = outputModalitiesOf(entry);
  return !modalities.includes(IMAGE_MODALITY) && !modalities.includes(VIDEO_MODALITY);
}
