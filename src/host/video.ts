/**
 * The Agnes VIDEO tool definition — `agnes_video_generate` — and the
 * compatibility barrel of the whole video family.
 *
 * Sibling of `draw.ts`, and deliberately NOT a copy of it: the two protocols
 * differ in the one way that decides the whole shape of the code. `draw.ts` is
 * a single request/response (`drawOnce`); video is an ASYNCHRONOUS TASK — you
 * POST to create, then poll until the task reaches a terminal state. The
 * spine and its no-cooldown rationale live in `video-client.ts`.
 *
 * 2026-10 split (the token-store playbook: behaviour frozen first, then moved
 * — `video.test.mjs` ran green against THIS file, unchanged, before and after
 * the split). The family now reads:
 *
 *   - `video-protocol.ts`      — endpoints (the host trap, the `/v1` vs
 *                                `/agnesapi` asymmetry), the V2.0 frame body,
 *                                task-response parsing, failure triage;
 *   - `video-protocol-25.ts`   — the 2.5 whole-second body (mutually exclusive
 *                                with V2.0 at the wire level; `isVideo25Family`
 *                                dispatches between the two builders);
 *   - `video-models.ts`        — catalog roster: which entries are video,
 *                                which family each speaks, and the pick;
 *   - `video-client.ts`        — the create → poll async client (fetch, sleep,
 *                                clock, disposal — all injectable);
 *   - `video.ts` (THIS module) — {@link defineVideoTool} wiring + the barrel
 *                                below, which re-exports the pre-split surface
 *                                verbatim so `import ... from "./video.ts"`
 *                                keeps working unchanged.
 *
 * @module dsh-connect-agnes-token-plan/video
 */

import { str, num, redactSecrets } from "./util.ts";
import { isVideo25Family, pickVideoModel } from "./video-models.ts";
import {
  VIDEO_DEFAULT_TIMEOUT_MS,
  VIDEO_MAX_FRAMES,
  VIDEO_MIN_FRAME_RATE,
  VIDEO_MAX_FRAME_RATE,
  VIDEO_DEFAULT_WIDTH,
  VIDEO_DEFAULT_HEIGHT,
  VIDEO_DEFAULT_NUM_FRAMES,
  VIDEO_DEFAULT_FRAME_RATE,
  buildVideoEndpoint,
  buildVideoQueryEndpoint,
  buildVideoBody,
  videoTaskIdOf,
  VIDEO_REQUEST_TIMEOUT_MS
} from "./video-protocol.ts";
import {
  VIDEO25_SECONDS_MIN,
  VIDEO25_SECONDS_MAX,
  VIDEO25_SIZES,
  VIDEO25_FLASH_ONLY_SIZE,
  VIDEO25_DEFAULT_SECONDS,
  VIDEO25_DEFAULT_SIZE,
  VIDEO25_ASPECT_TABLE,
  VIDEO25_MODES,
  VIDEO25_ONLY_FIELDS,
  buildVideoBody25
} from "./video-protocol-25.ts";
import { createVideoTask, pollVideoResult } from "./video-client.ts";

/** The agent tool name. Prefixed like `agnes_draw_image` so it cannot collide with another plugin's tool. */
export const VIDEO_TOOL_NAME = "agnes_video_generate";

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
      render: (_args, result) => [{ type: "text", text: result?.hint || "视频已生成" }]
    },
    // Tool deadline = poll budget + the create call's own deadline. A fixed
    // 60s margin undershot the worst case: create alone can run
    // VIDEO_REQUEST_TIMEOUT_MS (120s), so `budget + 60s` let the tool die
    // while create+poll were still legitimate — the agent then lost the
    // video_id of a task still running server-side, with no way to re-query
    // it. Covering the create deadline closes that gap (2026-10-03, review P2-1).
    timeoutMs: budget + VIDEO_REQUEST_TIMEOUT_MS,
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
        // The detail is the platform's own error object, spliced into a message
        // that lands in the AGENT conversation (not just a panel line). A 4xx
        // body may echo the API key it was sent with, so it is redacted before
        // embedding — the same red line `redactSecrets` guards on the provider /
        // desktop-upstream / route surfaces, and the same treatment
        // `describeDrawFailure` (draw.ts) and `describeVideoFailure`
        // (video-protocol.ts) already give their own paths (PITFALLS §15).
        const raw = typeof result.error === "string" ? result.error : JSON.stringify(result.error ?? "(无错误详情)");
        const detail = redactSecrets(str(raw, ""));
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

/* ------------------------------------------------------------------------
 * The compatibility barrel. Everything the pre-split `video.ts` exported is
 * re-exported here under its original name — the test surface and the
 * in-repo importers moved nothing. `VIDEO_IMAGE_PATTERN` was private before
 * the split (it now lives in `video-protocol.ts` as an inter-module export)
 * and stays OUT of this surface on purpose.
 * ---------------------------------------------------------------------- */

export {
  VIDEO_POLL_INTERVAL_MS,
  VIDEO_MAX_POLLS,
  VIDEO_DEFAULT_TIMEOUT_MS,
  VIDEO_REQUEST_TIMEOUT_MS,
  VIDEO_MAX_FRAMES,
  VIDEO_MIN_FRAME_RATE,
  VIDEO_MAX_FRAME_RATE,
  VIDEO_DEFAULT_WIDTH,
  VIDEO_DEFAULT_HEIGHT,
  VIDEO_DEFAULT_NUM_FRAMES,
  VIDEO_DEFAULT_FRAME_RATE,
  VIDEO_COMMON_FRAME_COUNTS,
  VIDEO_TERMINAL_STATUSES,
  buildVideoEndpoint,
  buildVideoQueryEndpoint,
  isValidFrameCount,
  nearestFrameCount,
  buildVideoBody,
  parseVideoTask,
  videoTaskIdOf,
  parseVideoQuery,
  isVideoTerminal,
  describeVideoFailure
} from "./video-protocol.ts";

export {
  VIDEO_DEFAULT_MODEL,
  isVideo25Family,
  isVideo25Flash,
  videoGenModelIds,
  videoV2ModelIds,
  video25ModelIds,
  pickVideoModel
} from "./video-models.ts";

export {
  VIDEO25_SIZES,
  VIDEO25_FLASH_ONLY_SIZE,
  VIDEO25_SECONDS_MIN,
  VIDEO25_SECONDS_MAX,
  VIDEO25_FLASH_REFERENCE_LIMIT,
  VIDEO25_ASPECT_TABLE,
  VIDEO25_MODES,
  VIDEO25_DEFAULT_SECONDS,
  VIDEO25_DEFAULT_SIZE,
  VIDEO25_ONLY_FIELDS,
  VIDEO25_DEFAULT_ASPECT,
  video25ErrorContext,
  resolveVideo25Size,
  nearestAspect25,
  secondsFromFrameTiming,
  buildVideoBody25
} from "./video-protocol-25.ts";

export {
  createVideoTask,
  queryVideoTask,
  pollVideoResult
} from "./video-client.ts";
