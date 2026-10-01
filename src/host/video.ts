/**
 * The Agnes VIDEO-generation module — the V2.0 half.
 *
 * Sibling of `draw.ts`, and deliberately NOT a copy of it: the two protocols
 * differ in the one way that decides the whole shape of the code. `draw.ts` is
 * a single request/response (`drawOnce`); video is an ASYNCHRONOUS TASK — you
 * POST to create, then poll until the task reaches a terminal state. So this
 * module's spine is `createVideoTask` → `pollVideoResult`, and there is no
 * per-call cooldown gate (see "no cooldown" below).
 *
 * The contract is not guessed. Four independent upstream implementations were
 * read rather than assumed — all four live in the SIBLING checkout's reference
 * tree (`~/.dsh/plugins/dsh-connect-agnes/upstream`, which is NOT this repo's
 * `upstream/`):
 *
 *   - the `dsh-agnes` DSH plugin (v0.6.0) — TypeScript, talks to the SAME host
 *     this plugin does; its video module is the closest analogue;
 *   - the `dsh-agnes-gen` JS plugin;
 *   - the `agnes-ai-generation-skill` tree — its `references/api.md` is the
 *     vendor-facing written contract;
 *   - the `Agnes-Media-Create` Python reference.
 *
 * ⚠️ THE HOST TRAP, measured rather than inferred: the Python reference
 * hardcodes `https://apihub.agnes-ai.com`, the INTERNATIONAL site. The two
 * sites expose identical paths on different hosts with NON-INTERCHANGEABLE
 * tokens — the JS plugin's own source comment records it ("拿国际站的 Key 打
 * 国内站的域名只会得到 401"), and it was re-measured here on 2026-10-01: this
 * plugin's key returns `Invalid token` from `apihub.agnes-ai.com` and works on
 * `api.agnes-ai.cn`. This module therefore derives EVERY endpoint from the
 * configured `apiBase` and hardcodes no host.
 *
 * ⚠️ AND THE PATH ASYMMETRY: creation lives under the OpenAI-compatible root
 * (`{apiBase}/videos` = `https://api.agnes-ai.cn/v1/videos`), but the query
 * endpoint does NOT — it is `https://api.agnes-ai.cn/agnesapi`, one level
 * ABOVE `/v1`. `buildVideoQueryEndpoint` strips the version segment for
 * exactly this reason; appending `/v1` there would 404.
 *
 * BOTH VIDEO PARAMETER FAMILIES ARE COVERED. The catalog lists two families
 * that speak MUTUALLY EXCLUSIVE parameter systems, and the tool drives both:
 *
 *   - the V2.0 family (`agnes-video-v2.0`) speaks `width` / `height` /
 *     `num_frames` (8n+1) / `frame_rate`;
 *   - the 2.5 family (`agnes-video-2.5` / `agnes-video-2.5-flash`) speaks a
 *     different, OpenAI-Videos-compatible scheme — `mode` / `seconds` /
 *     `size` / `aspect_ratio` — and rejects the V2.0 fields with a 400, and
 *     vice versa.
 *
 * So {@link pickVideoModel} may address EITHER family, and the tool picks the
 * matching body builder per model: {@link buildVideoBody} for V2.0,
 * {@link buildVideoBody25} for 2.5. `2.5-flash` is tighter (720P only, ≤5
 * reference images) and is converged by `isVideo25Flash` rather than being
 * silently sent a 400.
 *
 * WHY NO COOLDOWN GATE, unlike `draw.ts`: that gate exists to stop an agent
 * hammering a drained pool with attempts that cost seconds each. One video
 * attempt costs MINUTES (create + poll) and draws on the same shared video
 * rate-limit pool — on the token-plan tier, 5 RPM. The protocol's own latency
 * spaces retries far wider than the 30s gate would, so a gate here would be
 * dead code that merely looks protective. Recorded as a decision, not an
 * omission.
 *
 * @module dsh-connect-agnes-token-plan/video
 */

import { str, num, obj } from "./util.ts";
import { isVideoGenModel } from "./modality.ts";

/** The agent tool name. Prefixed like `agnes_draw_image` so it cannot collide with another plugin's tool. */
export const VIDEO_TOOL_NAME = "agnes_video_generate";

/**
 * The documented V2.0 model id.
 *
 * Only a last-resort label for messages and schema defaults: the model actually
 * dispatched is always resolved from the live catalog (or an explicit
 * `model` / `videoModelId`), so an upstream rename needs no code change here.
 */
export const VIDEO_DEFAULT_MODEL = "agnes-video-v2.0";

/** How long to wait between two status queries. */
export const VIDEO_POLL_INTERVAL_MS = 5_000;

/**
 * A hard ceiling on the number of status queries in one poll loop.
 *
 * The real bound is the wall-clock budget below, and with the real `Date.now`
 * that alone terminates the loop. This exists because the clock is INJECTABLE:
 * a non-advancing one would make `remaining <= 0` unreachable and spin forever
 * — a failure mode first hit while writing this module's own tests. 1000 is
 * far above any legitimate count (a 10-minute budget at 5s intervals is 120),
 * so it can only ever fire on a broken clock.
 */
export const VIDEO_MAX_POLLS = 1_000;

/** The poll budget for one generation; video tasks run for minutes, not seconds. */
export const VIDEO_DEFAULT_TIMEOUT_MS = 600_000;

/** Per-HTTP-call deadline (create and each query), independent of the poll budget. */
export const VIDEO_REQUEST_TIMEOUT_MS = 120_000;

/** `num_frames` ceiling the platform enforces. */
export const VIDEO_MAX_FRAMES = 441;

/** `frame_rate` bounds the platform enforces. */
export const VIDEO_MIN_FRAME_RATE = 1;

/** Upper `frame_rate` bound. */
export const VIDEO_MAX_FRAME_RATE = 60;

/** Documented default width (16:9). */
export const VIDEO_DEFAULT_WIDTH = 1152;

/** Documented default height (16:9). */
export const VIDEO_DEFAULT_HEIGHT = 768;

/** Documented default frame count — 121 @ 24fps ≈ 5 seconds. */
export const VIDEO_DEFAULT_NUM_FRAMES = 121;

/** Documented default frame rate. */
export const VIDEO_DEFAULT_FRAME_RATE = 24;

/**
 * The frame counts the platform documents as common, for error hints only.
 *
 * The real rule is the arithmetic one (`8n + 1`, `≤ 441`); this list exists so
 * a rejected value can name the nearest legal neighbour instead of just
 * refusing.
 */
export const VIDEO_COMMON_FRAME_COUNTS = Object.freeze([81, 121, 161, 241, 441]);

/** Task states that end the poll loop. */
export const VIDEO_TERMINAL_STATUSES = Object.freeze(["completed", "failed"]);

/** Reference images must be URLs the platform can fetch itself. */
const VIDEO_IMAGE_PATTERN = /^https?:\/\//;

/**
 * The version segment the query endpoint must NOT carry.
 *
 * `apiBase` is the OpenAI-compatible root (`…/v1`); `/agnesapi` hangs off the
 * host root instead. Stripping `/v1` (and anything deeper, so an operator who
 * pasted a full `/v1/chat/completions` still lands correctly) is what keeps a
 * hand-edited `apiBase` from producing a 404 on every poll.
 * @param {string} apiBase - the configured base.
 * @returns {string} the host root, or `""` when nothing usable was given.
 */
function hostRootOf(apiBase) {
  const trimmed = str(apiBase, "").trim().replace(/\/+$/, "");
  if (trimmed === "") return "";
  return trimmed.replace(/\/v1(\/.*)?$/, "");
}

/**
 * Build the task-creation endpoint from the OpenAI-compatible base.
 *
 * Every operator spelling lands on the same URL: `…/v1` → `…/v1/videos`; a
 * value already ending in `/videos` passes through; a deeper `/v1/<something>`
 * is rewound to `/v1`; anything else gets `/v1/videos` appended.
 * @param {string} apiBase - the configured base (default `https://api.agnes-ai.cn/v1`).
 * @returns {string} the full create endpoint.
 */
export function buildVideoEndpoint(apiBase) {
  const trimmed = str(apiBase, "").trim().replace(/\/+$/, "");
  if (trimmed === "") return "";
  if (/\/videos$/.test(trimmed)) return trimmed;
  if (/\/v1$/.test(trimmed)) return `${trimmed}/videos`;
  if (/\/v1\//.test(trimmed)) return trimmed.replace(/\/v1\/.*$/, "/v1/videos");
  return `${trimmed}/v1/videos`;
}

/**
 * Build the status-query endpoint — deliberately NOT under `/v1`.
 *
 * See the module header: the query route lives at `{host}/agnesapi`, so the
 * version segment is stripped rather than appended.
 * @param {string} apiBase - the configured base.
 * @returns {string} the full query endpoint, or `""` when the base is unusable.
 */
export function buildVideoQueryEndpoint(apiBase) {
  const root = hostRootOf(apiBase);
  return root === "" ? "" : `${root}/agnesapi`;
}

/**
 * Whether a frame count satisfies the platform's `8n + 1` rule within bounds.
 * @param {unknown} value - the candidate.
 * @returns {boolean}
 */
export function isValidFrameCount(value) {
  return Number.isInteger(value) && value >= 1 && value <= VIDEO_MAX_FRAMES && (value - 1) % 8 === 0;
}

/**
 * The nearest legal frame count at or above `value`, for an error hint.
 * @param {number} value - the rejected value.
 * @returns {number} a legal frame count.
 */
export function nearestFrameCount(value) {
  const candidate = VIDEO_COMMON_FRAME_COUNTS.find((count) => count >= value);
  return candidate ?? VIDEO_MAX_FRAMES;
}

/**
 * Whether a model id belongs to the 2.5 family (a DIFFERENT parameter system).
 *
 * The platform's own naming carries the generation, so the split needs no
 * table: anything with `2.5` in it speaks `mode`/`seconds`/`size`, everything
 * else speaks the V2.0 `width`/`num_frames`/`frame_rate` system this module
 * implements.
 * @param {string} model - the catalog id.
 * @returns {boolean}
 */
export function isVideo25Family(model) {
  return /2\.5/.test(str(model, ""));
}

/**
 * Whether a model id is the `-flash` variant of the 2.5 family.
 *
 * Flash is the same parameter system with TIGHTER limits (720P only, ≤5
 * reference images); the split is by name, the same no-table approach as
 * {@link isVideo25Family}.
 * @param {string} model - the catalog id.
 * @returns {boolean}
 */
export function isVideo25Flash(model) {
  return isVideo25Family(model) && /flash/i.test(str(model, ""));
}

/**
 * The video-generation model ids of one catalog, de-duplicated in first-seen order.
 *
 * Recognition is delegated to `modality.ts`, so this list and the chat roster
 * can never disagree about which entries exist.
 * @param {object[]} entries - the normalized catalog entries.
 * @returns {string[]}
 */
export function videoGenModelIds(entries) {
  const position = new Map();
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isVideoGenModel(entry)) continue;
    const id = str(entry?.id, "");
    if (id === "") continue;
    if (position.has(id)) {
      out[position.get(id)] = id;
    } else {
      position.set(id, out.length);
      out.push(id);
    }
  }
  return out;
}

/**
 * The subset of video ids this module can actually address — the V2.0 family.
 * @param {object[]} entries - the normalized catalog entries.
 * @returns {string[]}
 */
export function videoV2ModelIds(entries) {
  return videoGenModelIds(entries).filter((id) => !isVideo25Family(id));
}

/**
 * The subset of video ids that speak the 2.5 parameter system
 * (`mode` / `seconds` / `size` / `aspect_ratio`).
 * @param {object[]} entries - the normalized catalog entries.
 * @returns {string[]}
 */
export function video25ModelIds(entries) {
  return videoGenModelIds(entries).filter((id) => isVideo25Family(id));
}

/**
 * Choose the model one video call addresses.
 *
 * Precedence mirrors `pickDrawModel`: an explicitly requested id wins even when
 * the catalog does not list it (a manual override — the platform answers the
 * error itself if the id is wrong), then the configured preference when the
 * catalog confirms it (ANY family — a 2.5 preference is honoured, because the
 * tool now drives both systems), then the auto-pick: the first V2.0 id, and
 * only when the catalog holds NO V2.0 model at all does it fall through to the
 * first 2.5 id. An empty catalog yields `null`, and the caller turns that into
 * an actionable message rather than dispatching a request.
 * @param {object[]} entries - the normalized catalog entries.
 * @param {string} [requested] - the tool call's `model` parameter.
 * @param {string} [preferred] - the configured default (`videoModelId`).
 * @returns {string|null} the chosen id, or `null` when nothing can be picked.
 */
export function pickVideoModel(entries, requested, preferred) {
  const want = str(requested, "").trim();
  if (want !== "") return want;
  const allVideo = videoGenModelIds(entries);
  if (allVideo.length === 0) return null;
  const config = str(preferred, "").trim();
  if (config !== "" && allVideo.includes(config)) return config;
  const v2 = videoV2ModelIds(entries);
  if (v2.length > 0) return v2[0];
  return allVideo[0];
}

/**
 * Build the `videos` request body for the V2.0 parameter system.
 *
 * Invalid EXPLICIT values THROW rather than being clamped, unlike
 * `buildDrawBody`'s `n`. The difference is deliberate: a clamped image count
 * costs one cheap extra image, while a clamped frame count silently changes the
 * video's DURATION after minutes of generation — the caller must be told, not
 * quietly overruled.
 * @param {object} options - `{ model, prompt, width, height, numFrames, frameRate, seed, negativePrompt, image }`.
 * @returns {object} the wire body.
 * @throws {Error} on any out-of-range explicit value.
 */
export function buildVideoBody(options: Record<string, any> = {}) {
  const { model, prompt, width, height, numFrames, frameRate, seed, negativePrompt, image } = options;
  const body: Record<string, unknown> = {
    model: str(model, ""),
    prompt: str(prompt, "")
  };
  if (width !== undefined && width !== null) {
    if (!Number.isInteger(width) || width <= 0) {
      throw new Error(`无效的 width ${width}：必须是正整数`);
    }
    body.width = width;
  }
  if (height !== undefined && height !== null) {
    if (!Number.isInteger(height) || height <= 0) {
      throw new Error(`无效的 height ${height}：必须是正整数`);
    }
    body.height = height;
  }
  if (numFrames !== undefined && numFrames !== null) {
    if (!isValidFrameCount(numFrames)) {
      throw new Error(
        `无效的 num_frames ${numFrames}：必须 ≤ ${VIDEO_MAX_FRAMES} 且满足 8n+1（常用值 ${VIDEO_COMMON_FRAME_COUNTS.join(" / ")}，最接近的较大合法值 ${nearestFrameCount(Number(numFrames) || 1)}）`
      );
    }
    body.num_frames = numFrames;
  }
  if (frameRate !== undefined && frameRate !== null) {
    if (typeof frameRate !== "number" || !Number.isFinite(frameRate) || frameRate < VIDEO_MIN_FRAME_RATE || frameRate > VIDEO_MAX_FRAME_RATE) {
      throw new Error(`无效的 frame_rate ${frameRate}：支持范围 ${VIDEO_MIN_FRAME_RATE}–${VIDEO_MAX_FRAME_RATE}`);
    }
    body.frame_rate = frameRate;
  }
  if (seed !== undefined && seed !== null) {
    if (!Number.isInteger(seed)) throw new Error(`无效的 seed ${seed}：必须是整数`);
    body.seed = seed;
  }
  const negative = str(negativePrompt, "");
  if (negative !== "") body.negative_prompt = negative;
  const source = str(image, "");
  if (source !== "") {
    if (!VIDEO_IMAGE_PATTERN.test(source)) {
      throw new Error(`无效的 image "${source.slice(0, 64)}"：必须是平台可直接抓取的公共 HTTP(S) 图片 URL`);
    }
    body.image = source;
  }
  return body;
}

/* ------------------------------------------------------------------------
 * 2.5 family — the OpenAI-Videos-compatible whole-second scheme.
 *
 * Mutually exclusive with the V2.0 body: `mode` / `seconds` / `size` /
 * `aspect_ratio` (plus `first_frame` / `last_frame` / `images` media fields
 * and `seed`). Sending the V2.0 `width` / `height` / `num_frames` /
 * `frame_rate` fields to a 2.5 model is a 400, and the reverse is too — so
 * `buildVideoBody25` never emits a V2.0 field, and the V2.0 builder never
 * emits a 2.5 one. The two builders are dispatched per model by
 * `isVideo25Family` inside `defineVideoTool`.
 * ---------------------------------------------------------------------- */

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
  let best = VIDEO25_ASPECT_TABLE.find((row) => row.ratio === VIDEO25_DEFAULT_ASPECT);
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

/**
 * Read the task identifiers out of a create-task response.
 *
 * `video_id` is the recommended lookup key and is preferred; `task_id` (with
 * `id` as the same field under its other spelling) is the legacy fallback the
 * upstream reference also honours.
 * @param {object} data - the parsed create response.
 * @returns {{videoId: string, taskId: string, status: string}}
 */
export function parseVideoTask(data) {
  const source = obj(data);
  return {
    videoId: str(source.video_id, ""),
    taskId: str(source.task_id, "") || str(source.id, ""),
    status: str(source.status, "")
  };
}

/**
 * The identifier a poll should address: `video_id` when present, else `task_id`.
 * @param {object} task - a {@link parseVideoTask} result.
 * @returns {string} the id, or `""` when the platform returned neither.
 */
export function videoTaskIdOf(task) {
  return str(task?.videoId, "") || str(task?.taskId, "");
}

/**
 * Read a status-query response into the fields the tool and its hint use.
 *
 * `url` is read from the top level AND from `metadata.url` because the live
 * response and the documented example disagree on which one carries it (the
 * upstream reference records the same two-layer fallback).
 * @param {object} data - the parsed query response.
 * @returns {{videoId: string, taskId: string, status: string, progress: number, seconds: string, size: string, url: string, error: unknown}}
 */
export function parseVideoQuery(data) {
  const source = obj(data);
  const metadata = obj(source.metadata);
  // `num()` insists on a POSITIVE value, which would turn a legitimate 0%
  // progress into "absent"; progress is read directly so 0 stays 0.
  const progress = typeof source.progress === "number" && Number.isFinite(source.progress) ? source.progress : 0;
  return {
    videoId: str(source.video_id, ""),
    taskId: str(source.task_id, ""),
    status: str(source.status, "").toLowerCase(),
    progress,
    seconds: str(source.seconds, "") || (typeof source.seconds === "number" ? String(source.seconds) : ""),
    size: str(source.size, ""),
    url: str(source.url, "") || str(metadata.url, ""),
    error: source.error ?? metadata.error
  };
}

/**
 * Whether a task state ends the poll loop.
 * @param {string} status - the state string.
 * @returns {boolean}
 */
export function isVideoTerminal(status) {
  return VIDEO_TERMINAL_STATUSES.includes(str(status, "").toLowerCase());
}

/**
 * Turn a failed HTTP answer into the message the agent (and the trace) reads.
 *
 * The 429 split mirrors the chat and draw discipline: a drained shared pool is
 * not worth retrying, a plain rate limit is. The 400 branch carries the
 * platform's own words, which for this gateway name the exact parameter that
 * was rejected.
 * @param {number} status - the HTTP status code.
 * @param {string} bodyText - the raw body (best effort, may be empty).
 * @returns {string} the agent-facing message.
 */
export function describeVideoFailure(status, bodyText) {
  const text = str(bodyText, "").slice(0, 300);
  if (status === 401 || status === 403) {
    return `video failed: HTTP ${status} — the AGNES_TOKEN_PLAN_API_KEY is missing, invalid or not authorized for this model. Set it in the panel's 模型接入 area${text === "" ? "" : `; body: ${text}`}`;
  }
  if (status === 429) {
    if (/insufficient|quota/i.test(text)) {
      return `video failed: HTTP 429 — 配额不足（共享池已耗尽或该视频模型不在套餐内），稍后或换模型再试; body: ${text}`;
    }
    return `video failed: HTTP 429 — 限频（token-plan 档视频约 5 RPM，且建任务与轮询共用同一个池），请稍等重试; body: ${text}`;
  }
  if (status === 404) {
    return `video failed: HTTP 404 — 任务不存在或 endpoint 不对（检查 apiBase；建任务走 {apiBase}/videos，查询走 {host}/agnesapi）${text === "" ? "" : `; body: ${text}`}`;
  }
  return `video failed: HTTP ${status}${text === "" ? "" : ` ${text}`}`;
}

/**
 * Fire one JSON request and parse the answer.
 *
 * The deadline aborts through an `AbortController` so an in-flight body read is
 * cancelled too, and the whole flow stays injectable for the tests.
 * @param {object} options - wiring.
 * @param {Function} options.fetchImpl - the fetch to use (injected).
 * @param {string} options.url - the full endpoint.
 * @param {string} options.method - `"POST"` or `"GET"`.
 * @param {string} options.apiKey - the resolved `sk-` key.
 * @param {object} [options.body] - the wire body (POST only).
 * @param {number} [options.timeoutMs] - the per-call deadline.
 * @returns {Promise<object>} the parsed JSON.
 */
async function requestJson({ fetchImpl, url, method, apiKey, body = undefined, timeoutMs = VIDEO_REQUEST_TIMEOUT_MS }) {
  if (typeof fetchImpl !== "function") throw new Error("video: fetchImpl is required");
  if (str(url, "") === "") throw new Error("video: endpoint is empty — check apiBase");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`video request timeout after ${timeoutMs}ms`)), Math.max(1_000, timeoutMs));
  try {
    const response = await fetchImpl(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
      signal: controller.signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(describeVideoFailure(response.status, text));
    }
    return await response.json().catch(() => {
      throw new Error("video: response is not valid JSON");
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create one video task.
 * @param {object} options - `{ fetchImpl, endpoint, apiKey, body, timeoutMs }`.
 * @returns {Promise<{videoId: string, taskId: string, status: string}>}
 * @throws {Error} when the platform refuses, or returns no task identifier.
 */
export async function createVideoTask({ fetchImpl, endpoint, apiKey, body, timeoutMs = VIDEO_REQUEST_TIMEOUT_MS }) {
  const data = await requestJson({ fetchImpl, url: endpoint, method: "POST", apiKey, body, timeoutMs });
  const task = parseVideoTask(data);
  if (videoTaskIdOf(task) === "") {
    throw new Error(`video: 平台未返回 video_id/task_id，无法轮询：${JSON.stringify(data).slice(0, 300)}`);
  }
  return task;
}

/**
 * Query one task's current state.
 * @param {object} options - `{ fetchImpl, queryEndpoint, apiKey, videoId, model, timeoutMs }`.
 * @returns {Promise<object>} a {@link parseVideoQuery} result.
 */
export async function queryVideoTask({ fetchImpl, queryEndpoint, apiKey, videoId, model, timeoutMs = VIDEO_REQUEST_TIMEOUT_MS }) {
  const params = new URLSearchParams();
  params.set("video_id", str(videoId, ""));
  // `model_name` is REQUIRED for the 2.5 family's keyframe/reference modes and
  // harmless for V2.0, so it always travels rather than being conditional.
  const name = str(model, "");
  if (name !== "") params.set("model_name", name);
  const separator = queryEndpoint.includes("?") ? "&" : "?";
  const data = await requestJson({
    fetchImpl,
    url: `${queryEndpoint}${separator}${params.toString()}`,
    method: "GET",
    apiKey,
    timeoutMs
  });
  return parseVideoQuery(data);
}

/** The default sleep, injected in tests so a poll loop runs instantly. */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll a task until it reaches a terminal state or the budget runs out.
 *
 * The budget is wall-clock and enforced here rather than by a request count, so
 * a slow platform cannot stretch the wait past `timeoutMs`. The timeout error
 * carries the task id, because the task keeps running server-side — the agent
 * can come back for it instead of re-generating.
 * @param {object} options - wiring.
 * @param {Function} options.fetchImpl - the fetch to use.
 * @param {string} options.queryEndpoint - the `agnesapi` URL.
 * @param {string} options.apiKey - the resolved key.
 * @param {string} options.videoId - the task identifier.
 * @param {string} [options.model] - sent as `model_name`.
 * @param {number} [options.timeoutMs] - the poll budget.
 * @param {number} [options.pollIntervalMs] - the gap between queries.
 * @param {Function} [options.sleep] - injected sleeper.
 * @param {Function} [options.now] - injected clock.
 * @param {Function} [options.isDisposed] - `() => boolean`, true after unmount.
 * @returns {Promise<object>} the terminal {@link parseVideoQuery} result.
 * @throws {Error} on timeout, disposal, or a refused query.
 */
export async function pollVideoResult({
  fetchImpl,
  queryEndpoint,
  apiKey,
  videoId,
  model,
  timeoutMs = VIDEO_DEFAULT_TIMEOUT_MS,
  pollIntervalMs = VIDEO_POLL_INTERVAL_MS,
  sleep = defaultSleep,
  now = Date.now,
  isDisposed = () => false
}) {
  const budget = Math.max(1_000, Math.floor(num(timeoutMs, VIDEO_DEFAULT_TIMEOUT_MS)));
  const interval = Math.max(100, Math.floor(num(pollIntervalMs, VIDEO_POLL_INTERVAL_MS)));
  const deadline = now() + budget;
  let attempts = 0;
  for (;;) {
    if (isDisposed()) throw new Error("Agnes video tool is no longer mounted");
    if (++attempts > VIDEO_MAX_POLLS) {
      throw new Error(
        `视频生成轮询超过 ${VIDEO_MAX_POLLS} 次仍未结束（video_id=${videoId}）——任务仍在平台侧运行，请稍后用 video_id 重新查询，不要重复提交`
      );
    }
    const value = await queryVideoTask({ fetchImpl, queryEndpoint, apiKey, videoId, model });
    if (isVideoTerminal(value.status)) return value;
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(
        `视频生成超时（超过 ${budget}ms，任务仍处于 ${value.status === "" ? "unknown" : value.status}）——任务仍在平台侧运行，可用 video_id=${videoId} 稍后重新查询，不要重复提交`
      );
    }
    await sleep(Math.min(interval, remaining));
  }
}

/**
 * Build the agent tool object for `ctx.tools.register`.
 *
 * Pure wiring, exactly like `defineDrawTool`: the peer's `defineTool` factory
 * arrives as a parameter, and every side effect (key resolution, the live
 * catalog, the fetch, disposal) is injected. `lifecycle.ts` calls this only
 * when `videoEnabled` is on AND a tools service is present.
 * @param {object} options - wiring.
 * @param {Function} options.defineTool - the peer's tool factory.
 * @param {Function} options.resolveApiKey - async `() => Promise<string>`.
 * @param {Function} options.getEntries - `() => catalog entries` (sync or async), read at call time.
 * @param {object} options.settings - `{ apiBase, videoModelId, videoTimeoutMs, videoWidth, videoHeight, videoNumFrames, videoFrameRate }`.
 * @param {Function} options.fetchImpl - the fetch for the two HTTP calls.
 * @param {Function} [options.isDisposed] - `() => boolean`, true after unmount.
 * @returns {object} the tool definition for `ctx.tools.register`.
 */
export function defineVideoTool({
  defineTool,
  resolveApiKey,
  getEntries,
  settings,
  fetchImpl,
  isDisposed = () => false
}) {
  const budget = Math.max(5_000, Math.floor(num(settings?.videoTimeoutMs, VIDEO_DEFAULT_TIMEOUT_MS)));
  const defaults = {
    width: Math.floor(num(settings?.videoWidth, VIDEO_DEFAULT_WIDTH)),
    height: Math.floor(num(settings?.videoHeight, VIDEO_DEFAULT_HEIGHT)),
    numFrames: Math.floor(num(settings?.videoNumFrames, VIDEO_DEFAULT_NUM_FRAMES)),
    frameRate: num(settings?.videoFrameRate, VIDEO_DEFAULT_FRAME_RATE)
  };
  return defineTool({
    name: VIDEO_TOOL_NAME,
    description:
      "Generate a video with the Agnes Token Plan key (asynchronous: this creates a task and then polls it, so one call can take minutes). " +
      "Models are auto-discovered from this key's catalog; pass `model` only when you specifically need one. " +
      "Two parameter families exist and the tool picks the matching one per model: " +
      "V2.0 (`agnes-video-v2.0`) takes `width` / `height` / `num_frames` (8n+1, ≤ " + VIDEO_MAX_FRAMES +
      "; 81≈3s, 121≈5s, 241≈10s at " + VIDEO_DEFAULT_FRAME_RATE + "fps) / `frame_rate`; " +
      "2.5 (`agnes-video-2.5` / `agnes-video-2.5-flash`) takes the whole-second scheme instead — `seconds` (" +
      VIDEO25_SECONDS_MIN + "–" + VIDEO25_SECONDS_MAX + "), `size` (" + VIDEO25_SIZES.join("/") + ", flash is 720P only) and `aspect_ratio` " +
      "(21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16). The two families do not mix at the platform — sending V2.0 " +
      "frame fields straight to a 2.5 model is a 400, so the tool translates `num_frames` / `frame_rate` to the " +
      "nearest whole second when `seconds` is omitted, and `width` / `height` steer the aspect ratio. " +
      "The reverse mix is refused, not dropped: 2.5-only fields (`seconds` / `size` / `aspect_ratio` / " +
      "`mode` / `keyframes`) sent to a V2.0 model throw — set `model` to a 2.5 id. " +
      "Image-to-video: `image` (one URL); keyframe animation on 2.5: `keyframes` (≥2 URLs, or a single `image` " +
      "as the first frame).",
    parameters: {
      prompt: { type: "string", required: true, description: "Video content description" },
      model: { type: "string", description: "Agnes video model id; defaults to the first V2.0 model, or the first 2.5 model when the catalog holds no V2.0 one" },
      image: { type: "string", description: "Optional public HTTPS image URL for image-to-video (2.5: used as the keyframe first frame); never combined with keyframes" },
      keyframes: { type: "array", items: { type: "string" }, description: "2.5 only: keyframe image URLs, ≥2; exactly 2 becomes a first/last-frame keyframe animation, 3+ a reference set (2.5-flash: ≤5); never combined with image" },
      width: { type: "number", description: `V2.0: video width in pixels, default ${VIDEO_DEFAULT_WIDTH}; on 2.5 models it only feeds the aspect-ratio nearest-match` },
      height: { type: "number", description: `V2.0: video height in pixels, default ${VIDEO_DEFAULT_HEIGHT}; on 2.5 models it only feeds the aspect-ratio nearest-match` },
      num_frames: { type: "number", description: `V2.0: frame count, ≤ ${VIDEO_MAX_FRAMES} and 8n+1, default ${VIDEO_DEFAULT_NUM_FRAMES}; on 2.5 models it converts to the nearest whole second when seconds is omitted` },
      frame_rate: { type: "number", description: `V2.0: frames per second, ${VIDEO_MIN_FRAME_RATE}-${VIDEO_MAX_FRAME_RATE}, default ${VIDEO_DEFAULT_FRAME_RATE}; on 2.5 models it only joins the seconds conversion` },
      seconds: { type: "number", description: `2.5 only: duration in whole seconds, ${VIDEO25_SECONDS_MIN}-${VIDEO25_SECONDS_MAX}; omitted = derived from num_frames/frame_rate or the documented default ${VIDEO25_DEFAULT_SECONDS}` },
      size: { type: "string", description: `2.5 only: resolution tier ${VIDEO25_SIZES.join(" / ")}; 2.5-flash accepts ${VIDEO25_FLASH_ONLY_SIZE} only; omitted = ${VIDEO25_DEFAULT_SIZE}` },
      aspect_ratio: { type: "string", description: `2.5 only: aspect ratio ${VIDEO25_ASPECT_TABLE.map((row) => row.ratio).join(" / ")}; omitted = nearest match of width/height` },
      mode: { type: "string", description: `2.5 only: generation mode ${VIDEO25_MODES.join(" / ")}; omitted = derived from image/keyframes (none → text, one → keyframe, 2 → keyframe first/last, 3+ → reference)` },
      seed: { type: "number", description: "Integer seed for reproducible output; omit for a random one" },
      negative_prompt: { type: "string", description: "V2.0 only: content to avoid (the 2.5 system has no equivalent and it is not forwarded)" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          source: { type: "string" },
          model: { type: "string" },
          videoId: { type: "string" },
          status: { type: "string" },
          url: { type: "string" },
          seconds: { type: "string" },
          prompt: { type: "string" },
          hint: { type: "string" }
        }
      },
      // Same two-parameter render shape `defineDrawTool` uses: the renderer is
      // called with the call args first and the result second.
      render: (args, result) => [{ type: "text", text: result?.hint || "视频已生成" }]
    },
    timeoutMs: budget + 60_000,
    async execute(params) {
      if (isDisposed()) throw new Error("Agnes video tool is no longer mounted");
      const prompt = str(params?.prompt, "").trim();
      if (prompt === "") throw new Error("prompt is required");
      const apiKey = await resolveApiKey();
      if (typeof apiKey !== "string" || apiKey.trim() === "") {
        throw new Error("AGNES_TOKEN_PLAN_API_KEY 未配置：在面板「模型接入」粘贴 API Key（免费版 sk- 或 Token Plan cpk-），或设置该环境变量");
      }
      let picked;
      try {
        picked = (await getEntries?.()) ?? [];
      } catch {
        picked = [];
      }
      const entries = Array.isArray(picked) ? picked : [];
      const model = pickVideoModel(entries, params?.model, settings?.videoModelId);
      if (model === null) {
        throw new Error("catalog 中没有视频模型（`output_modalities` 字段与 `agnes-video-*` 名称判定均为空）：确认 Key 已配置、面板已至少轮询一次，且套餐含视频模型");
      }
      // Refuse the REVERSE mix instead of silently dropping it. `buildVideoBody`
      // destructures only the V2.0 fields, so a 2.5 field set addressed at a V2.0
      // model would vanish: the caller asks for a 10s 2K clip and would receive a
      // 5s 720P one, with no signal that anything was dropped. Same
      // throw-not-silent discipline as the V2.0 frame-count rule (§7.5.1) — the
      // error names the one-line fix rather than just refusing.
      if (!isVideo25Family(model)) {
        const twentyFiveOnly = VIDEO25_ONLY_FIELDS.filter((field) => params?.[field] !== undefined && params?.[field] !== null);
        if (twentyFiveOnly.length > 0) {
          throw new Error(
            `模型 ${model} 是 V2.0 帧制（width / height / num_frames / frame_rate），不识别 2.5 秒数制的 ` +
              twentyFiveOnly.map((field) => `\`${field}\``).join(" / ") +
              "；请显式传 model 指向 2.5 家族（agnes-video-2.5 / agnes-video-2.5-flash），或去掉这些参数、改用 num_frames / frame_rate"
          );
        }
      }
      // The two families are mutually exclusive at the wire level: pick the
      // matching body builder per model so a V2.0 field set never reaches a 2.5
      // model (a guaranteed 400) and vice versa.
      const body = isVideo25Family(model)
        ? buildVideoBody25({
          model,
          prompt,
          mode: params?.mode,
          seconds: params?.seconds,
          size: params?.size,
          aspectRatio: params?.aspect_ratio,
          width: params?.width,
          height: params?.height,
          numFrames: params?.num_frames,
          frameRate: params?.frame_rate,
          image: params?.image,
          keyframes: params?.keyframes,
          seed: params?.seed
        })
        : buildVideoBody({
          model,
          prompt,
          width: params?.width ?? defaults.width,
          height: params?.height ?? defaults.height,
          numFrames: params?.num_frames ?? defaults.numFrames,
          frameRate: params?.frame_rate ?? defaults.frameRate,
          seed: params?.seed,
          negativePrompt: params?.negative_prompt,
          image: params?.image
        });
      const created = await createVideoTask({
        fetchImpl,
        endpoint: buildVideoEndpoint(settings?.apiBase),
        apiKey,
        body
      });
      const videoId = videoTaskIdOf(created);
      const result = await pollVideoResult({
        fetchImpl,
        queryEndpoint: buildVideoQueryEndpoint(settings?.apiBase),
        apiKey,
        videoId,
        model,
        timeoutMs: budget,
        isDisposed
      });
      if (result.status === "failed") {
        const detail = typeof result.error === "string" ? result.error : JSON.stringify(result.error ?? "(无错误详情)");
        throw new Error(`视频生成失败（video_id=${videoId}，模型 ${model}）：${detail}`);
      }
      const hint = result.url !== ""
        ? `视频已生成!\n模型: ${model}\nvideo_id: ${videoId}${result.seconds === "" ? "" : `\n时长: ${result.seconds} 秒`}${result.size === "" ? "" : `\n分辨率: ${result.size}`}\nURL: ${result.url}\n请直接输出 Markdown 链接: [视频](${result.url})`
        : `视频任务已完成，但响应里没有可直接访问的 URL（video_id=${videoId}，模型 ${model}）。请用 video_id 查询任务详情。`;
      return {
        source: "agnes",
        model,
        videoId,
        status: result.status,
        url: result.url,
        seconds: result.seconds,
        prompt,
        hint
      };
    }
  });
}
