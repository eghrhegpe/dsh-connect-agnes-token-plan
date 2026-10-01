/**
 * The Agnes VIDEO wire protocol — endpoint building, the V2.0 request body,
 * task-response parsing and failure triage. NO fetch, NO clock, NO tool:
 * everything here is pure text-in / text-out.
 *
 * This module was extracted from the original single-file `video.ts` in the
 * 2026-10 split (the token-store playbook: behaviour frozen first —
 * `video.test.mjs` ran green against the `video.ts` compatibility barrel
 * before and after the move, unchanged). The video family now lives in:
 *
 *   - `video-protocol.ts`      — THIS module: endpoints, V2.0 body, parsing;
 *   - `video-protocol-25.ts`   — the 2.5 whole-second scheme;
 *   - `video-models.ts`        — family recognition & catalog selection;
 *   - `video-client.ts`        — the create → poll async spine (fetch/sleep);
 *   - `video.ts`               — the `agnes_video_generate` tool + barrel.
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
 * The V2.0 parameter system is `width` / `height` / `num_frames` (8n+1) /
 * `frame_rate`. The 2.5 family (`agnes-video-2.5` / `agnes-video-2.5-flash`)
 * speaks a MUTUALLY EXCLUSIVE scheme — `mode` / `seconds` / `size` /
 * `aspect_ratio` — see `video-protocol-25.ts`. Sending the V2.0 frame fields
 * straight to a 2.5 model is a 400, and the reverse is too; neither builder
 * ever emits the other family's fields.
 *
 * @module dsh-connect-agnes-token-plan/video-protocol
 */

import { str, obj } from "./util.ts";

/** How long to wait between two status queries. */
export const VIDEO_POLL_INTERVAL_MS = 5_000;

/**
 * A hard ceiling on the number of status queries in one poll loop.
 *
 * The real bound is the wall-clock budget below, and with the real `Date.now`
 * that alone terminates the loop. This exists because the clock is INJECTABLE:
 * a non-advancing one would make `remaining <= 0` unreachable and spin forever
 * — a failure mode first hit while writing the video module's own tests. 1000
 * is far above any legitimate count (a 10-minute budget at 5s intervals is
 * 120), so it can only ever fire on a broken clock.
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
export const VIDEO_IMAGE_PATTERN = /^https?:\/\//;

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
