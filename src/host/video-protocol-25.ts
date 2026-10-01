/**
 * The Agnes VIDEO 2.5 parameter family — the OpenAI-Videos-compatible
 * whole-second scheme.
 *
 * Part of the 2026-10 split of `video.ts` (see that file's header for the
 * family map; behaviour was frozen by `video.test.mjs` before and after).
 *
 * Mutually exclusive with the V2.0 body (`video-protocol.ts`): `mode` /
 * `seconds` / `size` / `aspect_ratio` (plus `first_frame` / `last_frame` /
 * `images` media fields and `seed`). Sending the V2.0 `width` / `height` /
 * `num_frames` / `frame_rate` fields to a 2.5 model is a 400, and the reverse
 * is too — so {@link buildVideoBody25} never emits a V2.0 field, and the V2.0
 * builder never emits a 2.5 one. The two builders are dispatched per model by
 * `isVideo25Family` inside `defineVideoTool`.
 *
 * @module dsh-connect-agnes-token-plan/video-protocol-25
 */

import { str } from "./util.ts";
import { isVideo25Flash } from "./video-models.ts";
import {
  VIDEO_IMAGE_PATTERN,
  VIDEO_DEFAULT_NUM_FRAMES,
  VIDEO_DEFAULT_FRAME_RATE
} from "./video-protocol.ts";

/** The resolution tiers the 2.5 family documents. */
export const VIDEO25_SIZES = Object.freeze(["720P", "960P", "2K"]);

/** `2.5-flash` only supports this tier; anything else is a 400. */
export const VIDEO25_FLASH_ONLY_SIZE = "720P";

/** The whole-second range the 2.5 family accepts (submitted as a string). */
export const VIDEO25_SECONDS_MIN = 4;

export const VIDEO25_SECONDS_MAX = 12;

/** The `2.5-flash` reference-mode image ceiling. */
export const VIDEO25_FLASH_REFERENCE_LIMIT = 5;

/** The 2.5 aspect whitelist and their width/height values, for nearest-match. */
export const VIDEO25_ASPECT_TABLE = Object.freeze([
  { ratio: "21:9", value: 21 / 9 },
  { ratio: "16:9", value: 16 / 9 },
  { ratio: "4:3", value: 4 / 3 },
  { ratio: "1:1", value: 1 },
  { ratio: "3:4", value: 3 / 4 },
  { ratio: "9:16", value: 9 / 16 }
]);

/** The 2.5 mode whitelist. */
export const VIDEO25_MODES = Object.freeze(["text", "keyframe", "reference"]);

/** Documented default duration (whole seconds). */
export const VIDEO25_DEFAULT_SECONDS = 5;

/** Documented default resolution tier. */
export const VIDEO25_DEFAULT_SIZE = "720P";

/**
 * The tool-call fields that ONLY the 2.5 family understands.
 *
 * `buildVideoBody` destructures only the V2.0 fields, so any of these handed to
 * a V2.0 model would be SILENTLY IGNORED: a caller asking for a 10s 2K clip
 * would receive a 5s 720P one with no signal. `defineVideoTool` uses this list
 * to refuse the mix instead (AGNES-API.md §7.5.1b).
 */
export const VIDEO25_ONLY_FIELDS = Object.freeze(["seconds", "size", "aspect_ratio", "mode", "keyframes"]);

/**
 * The prefix every 2.5-family error carries: the model id the builder actually
 * resolved, plus which parameter system that model speaks.
 *
 * Before this the messages said only "2.5 系列", which named a FAMILY without
 * naming what the agent had actually addressed — the only way to learn which
 * model was dispatched was to read the catalog. Naming it makes the error
 * self-correcting on its own line.
 * @param {unknown} model - the resolved model id.
 * @returns {string} e.g. `模型 agnes-video-2.5-flash（2.5 秒数制）：`
 */
export function video25ErrorContext(model) {
  return `模型 ${str(model, "") || "(未指定模型)"}（2.5 秒数制）：`;
}

/**
 * The resolution tier one 2.5 call resolves to.
 *
 * An EXPLICIT `size` must be whitelisted — and a flash variant may only be
 * `720P` — so an illegal value throws, matching the V2.0 throw-not-clamp
 * discipline. When nothing is given, the flash variant is pinned to its only
 * legal tier, and every other 2.5 model defaults to 720P.
 * @param {unknown} explicit - the requested size.
 * @param {string} model - the catalog id (decides the flash pinning).
 * @returns {string} a whitelisted tier.
 * @throws {Error} on a non-whitelisted explicit value, or a flash value above 720P.
 */
export function resolveVideo25Size(explicit, model) {
  if (explicit !== undefined && explicit !== null) {
    const tier = String(explicit).trim().toUpperCase();
    if (!VIDEO25_SIZES.includes(tier)) {
      throw new Error(`${video25ErrorContext(model)}无效的 size ${String(explicit)}：支持 ${VIDEO25_SIZES.join(" / ")}${isVideo25Flash(model) ? `，且该模型（2.5-flash）仅支持 ${VIDEO25_FLASH_ONLY_SIZE}` : ""}`);
    }
    if (isVideo25Flash(model) && tier !== VIDEO25_FLASH_ONLY_SIZE) {
      throw new Error(`${video25ErrorContext(model)}无效的 size ${String(explicit)}：该模型（2.5-flash）仅支持 ${VIDEO25_FLASH_ONLY_SIZE}`);
    }
    return tier;
  }
  return isVideo25Flash(model) ? VIDEO25_FLASH_ONLY_SIZE : VIDEO25_DEFAULT_SIZE;
}

/** Documented default aspect (the "16:9" a call with no width/height steers to). */
export const VIDEO25_DEFAULT_ASPECT = "16:9";

/**
 * Match any width/height to the 2.5 aspect whitelist, nearest ratio.
 *
 * The 2.5 family does not take `width` / `height` — those are a 400. This is
 * how an operator's preferred dimensions still steer the output: nearest
 * whitelisted aspect. A call with NO usable dimensions lands exactly on the
 * documented default 16:9 (the target IS 16/9, which is a whitelisted value —
 * no tie-break involved). Invalid dimensions likewise fall back to that
 * default.
 * @param {unknown} width - the candidate width.
 * @param {unknown} height - the candidate height.
 * @returns {string} a whitelisted aspect ratio.
 */
export function nearestAspect25(width, height) {
  const valid = typeof width === "number" && width > 0 && typeof height === "number" && height > 0;
  const target = valid ? width / height : 16 / 9;
  let best = VIDEO25_ASPECT_TABLE.find((row) => row.ratio === VIDEO25_DEFAULT_ASPECT) ?? VIDEO25_ASPECT_TABLE[0]!;
  for (const row of VIDEO25_ASPECT_TABLE) {
    if (Math.abs(row.value - target) < Math.abs(best.value - target)) best = row;
  }
  return best.ratio;
}

/**
 * Frame count / frame rate → whole seconds, clamped to the 2.5 range.
 *
 * This is the bridge that lets a caller who thinks in frames (the V2.0
 * mental model) still steer a 2.5 call's DURATION: `121 @ 24fps` → `5`
 * seconds. Bad frame rate falls back to the documented 24; a bad frame count
 * to 121 (≈5s). The clamp is deliberate here (unlike the V2.0 frame-count
 * throw): the 2.5 platform only accepts whole seconds 4–12, so a frame count
 * that would imply 3s or 15s must land on a legal value rather than a 400.
 * @param {unknown} numFrames - the candidate frame count.
 * @param {unknown} frameRate - the candidate frame rate.
 * @returns {number} a whole second in `4–12`.
 */
export function secondsFromFrameTiming(numFrames, frameRate) {
  const fps = typeof frameRate === "number" && Number.isFinite(frameRate) && frameRate > 0 ? frameRate : VIDEO_DEFAULT_FRAME_RATE;
  const frames = typeof numFrames === "number" && Number.isFinite(numFrames) && numFrames > 0 ? numFrames : VIDEO_DEFAULT_NUM_FRAMES;
  return Math.min(VIDEO25_SECONDS_MAX, Math.max(VIDEO25_SECONDS_MIN, Math.round(frames / fps)));
}

/**
 * Build the `videos` request body for the 2.5 parameter system.
 *
 * The 2.5 family is OpenAI-Videos-compatible: `mode` (`text` / `keyframe` /
 * `reference`) + `seconds` (whole, `4–12`) + `size` (720P/960P/2K) +
 * `aspect_ratio` (whitelist), with media fields `first_frame` / `last_frame`
 * / `images` and an optional `seed`. It does NOT accept the V2.0
 * `width` / `height` / `num_frames` / `frame_rate` fields — sending them is a
 * 400 — so those are translated, not passed through:
 *
 *   - an EXPLICIT `seconds` wins (and must be a whole 4–12, else throw);
 *   - otherwise `num_frames` / `frame_rate` are converted to the nearest
 *     whole second via {@link secondsFromFrameTiming};
 *   - `size` resolves through {@link resolveVideo25Size} (flash pinned to
 *     720P, illegal values throw);
 *   - `aspect_ratio` takes an EXPLICIT whitelisted value, or falls back to
 *     the nearest match of `width` / `height` via {@link nearestAspect25};
 *   - the media inputs map to a mode: `image` alone → `keyframe`
 *     (`first_frame`); two `keyframes` → `keyframe` (`first_frame` +
 *     `last_frame`); three or more `keyframes` → `reference` (`images`,
 *     ≤5 on flash); no media → `text`.
 *
 * `negative_prompt` is a V2.0 field and is intentionally NOT forwarded: the
 * 2.5 system has no equivalent, and an unknown top-level field is a 400.
 * @param {object} options - `{ model, prompt, mode, seconds, size, aspectRatio, width, height, numFrames, frameRate, image, keyframes, seed }`.
 * @returns {object} the wire body.
 * @throws {Error} on an out-of-range explicit value (seconds / size / aspect /
 *   seed) or a conflicting media combination.
 */
export function buildVideoBody25(options: Record<string, any> = {}) {
  const { model, prompt, mode, seconds, size, aspectRatio, width, height, numFrames, frameRate, image, keyframes, seed } = options;
  const flash = isVideo25Flash(model);

  // ---- media: image / keyframes are mutually exclusive, both must be public.
  const frameUrls = Array.isArray(keyframes)
    ? keyframes.filter((item) => typeof item === "string" && item !== "")
    : [];
  const imageUrl = typeof image === "string" && image.trim() !== "" ? image.trim() : undefined;
  if (frameUrls.length > 0 && imageUrl !== undefined) {
    throw new Error(`${video25ErrorContext(model)}image 与 keyframes 不能同时使用：图生视频传单张 image，关键帧动画传 keyframes 数组`);
  }
  const mediaUrls = [...frameUrls, ...(imageUrl === undefined ? [] : [imageUrl])];
  for (const url of mediaUrls) {
    if (!VIDEO_IMAGE_PATTERN.test(url)) {
      throw new Error(`${video25ErrorContext(model)}无效的参考图 "${url.slice(0, 64)}"：必须是平台可直接抓取的公共 HTTP(S) 图片 URL`);
    }
  }

  // ---- mode: explicit value must be whitelisted; otherwise derived from media.
  // An explicit mode also carries the media into the body: `keyframe` with two
  // keyframes → first/last, `reference` with a pool → images.
  let resolvedMode: string;
  const media: Record<string, unknown> = {};
  const explicitMode = mode !== undefined && mode !== null && String(mode).trim() !== ""
    ? String(mode).trim()
    : undefined;
  if (explicitMode !== undefined) {
    if (!VIDEO25_MODES.includes(explicitMode)) {
      throw new Error(`${video25ErrorContext(model)}无效的 mode "${explicitMode}"：支持 ${VIDEO25_MODES.join(" / ")}`);
    }
    resolvedMode = explicitMode;
    if (frameUrls.length >= 2) {
      if (frameUrls.length === 2) {
        media.first_frame = frameUrls[0];
        media.last_frame = frameUrls[1];
      } else {
        if (flash && frameUrls.length > VIDEO25_FLASH_REFERENCE_LIMIT) {
          throw new Error(`${video25ErrorContext(model)}reference 图片最多 ${VIDEO25_FLASH_REFERENCE_LIMIT} 张，收到 ${frameUrls.length} 张，请减少关键帧数量`);
        }
        media.images = frameUrls;
      }
    } else if (imageUrl !== undefined) {
      media.first_frame = imageUrl;
    }
  } else if (frameUrls.length >= 2) {
    if (frameUrls.length === 2) {
      resolvedMode = "keyframe";
      media.first_frame = frameUrls[0];
      media.last_frame = frameUrls[1];
    } else {
      resolvedMode = "reference";
      if (flash && frameUrls.length > VIDEO25_FLASH_REFERENCE_LIMIT) {
        throw new Error(`${video25ErrorContext(model)}reference 图片最多 ${VIDEO25_FLASH_REFERENCE_LIMIT} 张，收到 ${frameUrls.length} 张，请减少关键帧数量`);
      }
      media.images = frameUrls;
    }
  } else if (imageUrl !== undefined) {
    resolvedMode = "keyframe";
    media.first_frame = imageUrl;
  } else {
    resolvedMode = "text";
  }

  // ---- seconds: explicit whole 4–12, else derived from frame timing.
  let resolvedSeconds: number;
  if (seconds !== undefined && seconds !== null) {
    const explicit = Number(seconds);
    if (!Number.isInteger(explicit) || explicit < VIDEO25_SECONDS_MIN || explicit > VIDEO25_SECONDS_MAX) {
      throw new Error(`${video25ErrorContext(model)}无效的 seconds ${String(seconds)}：须为 ${VIDEO25_SECONDS_MIN}–${VIDEO25_SECONDS_MAX} 的整数秒`);
    }
    resolvedSeconds = explicit;
  } else {
    resolvedSeconds = secondsFromFrameTiming(numFrames, frameRate);
  }

  // ---- size: explicit whitelisted (flash pinned to 720P), else the default.
  const resolvedSize = resolveVideo25Size(size, model);

  // ---- aspect_ratio: explicit whitelisted, else nearest width/height match.
  let resolvedAspect: string;
  if (aspectRatio !== undefined && aspectRatio !== null && String(aspectRatio).trim() !== "") {
    const a = String(aspectRatio).trim();
    const known = VIDEO25_ASPECT_TABLE.some((row) => row.ratio === a);
    if (!known) {
      throw new Error(`${video25ErrorContext(model)}无效的 aspect_ratio "${a}"：支持 ${VIDEO25_ASPECT_TABLE.map((row) => row.ratio).join(" / ")}`);
    }
    resolvedAspect = a;
  } else {
    resolvedAspect = nearestAspect25(width, height);
  }

  const body: Record<string, unknown> = {
    model: str(model, ""),
    prompt: str(prompt, ""),
    mode: resolvedMode,
    seconds: String(resolvedSeconds),
    size: resolvedSize,
    aspect_ratio: resolvedAspect
  };
  Object.assign(body, media);
  if (seed !== undefined && seed !== null) {
    if (!Number.isInteger(seed)) throw new Error(`${video25ErrorContext(model)}无效的 seed ${seed}：必须是整数`);
    body.seed = seed;
  }
  return body;
}
