/**
 * The Agnes VIDEO async client — the create → poll spine.
 *
 * Part of the 2026-10 split of `video.ts` (see that file's header for the
 * family map; behaviour was frozen by `video.test.mjs` before and after).
 *
 * This is the half that is deliberately NOT shaped like `draw.ts`: the draw
 * protocol is a single request/response (`drawOnce`), video is an
 * ASYNCHRONOUS TASK — you POST to create, then poll until the task reaches a
 * terminal state. So the spine here is {@link createVideoTask} →
 * {@link pollVideoResult}, everything is injectable (`fetchImpl`, `sleep`,
 * `now`, `isDisposed`) so the whole loop runs offline against fakes, and a
 * 10-minute wall-clock budget is testable in milliseconds.
 *
 * WHY NO COOLDOWN GATE, unlike `draw.ts`: that gate exists to stop an agent
 * hammering a drained pool with attempts that cost seconds each. One video
 * attempt costs MINUTES (create + poll) and draws on the same shared video
 * rate-limit pool — on the token-plan tier, 5 RPM. The protocol's own latency
 * spaces retries far wider than the 30s gate would, so a gate here would be
 * dead code that merely looks protective. Recorded as a decision, not an
 * omission.
 *
 * @module dsh-connect-agnes-token-plan/video-client
 */

import { str, num } from "./util.ts";
import {
  VIDEO_REQUEST_TIMEOUT_MS,
  VIDEO_DEFAULT_TIMEOUT_MS,
  VIDEO_POLL_INTERVAL_MS,
  VIDEO_MAX_POLLS,
  parseVideoTask,
  videoTaskIdOf,
  parseVideoQuery,
  isVideoTerminal,
  describeVideoFailure
} from "./video-protocol.ts";

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
