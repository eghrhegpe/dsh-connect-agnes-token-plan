/**
 * Unit checks for the video absorption module (`video.js`) — PEER-FREE, like
 * `draw.test.mjs`:
 *
 * - endpoint building, INCLUDING the one asymmetry that bites: creation lives
 *   under `/v1` and the status query does not (`{host}/agnesapi`), so the
 *   version segment has to be stripped rather than appended;
 * - V2.0 parameter validation (`num_frames` 8n+1 and ≤441, `frame_rate` 1-60,
 *   positive-integer dimensions, integer seed, public image URL);
 * - the V2.0 / 2.5 split: two mutually exclusive parameter systems, auto-pick
 *   V2.0 first and fall back to the first 2.5 model only when the catalog holds
 *   no V2.0 one; per-model body dispatch; the reverse mix (2.5-only fields
 *   addressed at a V2.0 model) is refused, not silently dropped;
 * - create-task and status-query response parsing (both `video_id` and the
 *   legacy `task_id`/`id`, `url` at the top level AND under `metadata`);
 * - failure classification (the 429 quota-vs-rate split);
 * - the async spine: `createVideoTask` then `pollVideoResult`, against a fake
 *   fetch and an injected clock/sleeper (so a 10-minute budget runs instantly);
 * - `defineVideoTool` end-to-end with a passthrough `defineTool`: hint shapes,
 *   degradation errors, per-call key resolution, disposal.
 *
 * Nothing here imports a Host peer or opens a socket.
 */
import {
  VIDEO_TOOL_NAME,
  VIDEO_DEFAULT_MODEL,
  VIDEO_MAX_FRAMES,
  buildVideoEndpoint,
  buildVideoQueryEndpoint,
  isValidFrameCount,
  nearestFrameCount,
  isVideo25Family,
  isVideo25Flash,
  videoGenModelIds,
  videoV2ModelIds,
  video25ModelIds,
  pickVideoModel,
  buildVideoBody,
  buildVideoBody25,
  VIDEO25_ONLY_FIELDS,
  nearestAspect25,
  secondsFromFrameTiming,
  parseVideoTask,
  videoTaskIdOf,
  parseVideoQuery,
  isVideoTerminal,
  describeVideoFailure,
  createVideoTask,
  queryVideoTask,
  pollVideoResult,
  defineVideoTool
} from "../src/host/video.ts";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root — section 3d reads source text to pin prose against behaviour. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}
async function rejects(fn) {
  try {
    await fn();
  } catch (error) {
    return String(error?.message ?? error);
  }
  return null;
}
function okResponse(json) {
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
}
function errResponse(status, text) {
  return { ok: false, status, json: async () => ({}), text: async () => text };
}

// --- 1. endpoints: creation under /v1, the query one level above -----------
{
  check("a bare /v1 base appends /videos",
    buildVideoEndpoint("https://api.agnes-ai.cn/v1") === "https://api.agnes-ai.cn/v1/videos");
  check("a trailing slash is tolerated",
    buildVideoEndpoint("https://api.agnes-ai.cn/v1/") === "https://api.agnes-ai.cn/v1/videos");
  check("a full /videos URL passes through",
    buildVideoEndpoint("https://api.agnes-ai.cn/v1/videos") === "https://api.agnes-ai.cn/v1/videos");
  check("a deeper /v1/... path is rewound to /v1",
    buildVideoEndpoint("https://api.agnes-ai.cn/v1/chat/completions") === "https://api.agnes-ai.cn/v1/videos");
  check("a host with no version gets /v1/videos",
    buildVideoEndpoint("https://api.agnes-ai.cn") === "https://api.agnes-ai.cn/v1/videos");
  check("an empty base yields an empty endpoint",
    buildVideoEndpoint("") === "" && buildVideoEndpoint(undefined) === "");

  // The asymmetry that 404s if it is got wrong: /agnesapi is NOT under /v1.
  check("the query endpoint strips /v1 rather than appending to it",
    buildVideoQueryEndpoint("https://api.agnes-ai.cn/v1") === "https://api.agnes-ai.cn/agnesapi");
  check("the query endpoint survives a deeper /v1 path",
    buildVideoQueryEndpoint("https://api.agnes-ai.cn/v1/chat/completions") === "https://api.agnes-ai.cn/agnesapi");
  check("the query endpoint tolerates a bare host",
    buildVideoQueryEndpoint("https://api.agnes-ai.cn") === "https://api.agnes-ai.cn/agnesapi");
  check("the query endpoint is empty for an empty base",
    buildVideoQueryEndpoint("") === "");
  check("no host is hardcoded — the configured base decides",
    buildVideoEndpoint("https://example.test/v1").startsWith("https://example.test/"));
}

// --- 2. frame count / frame rate rules --------------------------------------
{
  check("8n+1 within bounds is valid",
    isValidFrameCount(81) && isValidFrameCount(121) && isValidFrameCount(441));
  check("1 is valid (8*0+1)", isValidFrameCount(1));
  check("a non-8n+1 value is rejected",
    isValidFrameCount(100) === false && isValidFrameCount(120) === false);
  check("over the ceiling is rejected", isValidFrameCount(449) === false);
  check("non-integers and junk are rejected",
    isValidFrameCount(81.5) === false && isValidFrameCount("81") === false && isValidFrameCount(NaN) === false);
  check("the hint names the nearest legal neighbour",
    nearestFrameCount(100) === 121 && nearestFrameCount(130) === 161 && nearestFrameCount(500) === VIDEO_MAX_FRAMES);
}

// --- 3. the V2.0 / 2.5 split ------------------------------------------------
{
  check("the 2.5 family is recognised by name",
    isVideo25Family("agnes-video-2.5") && isVideo25Family("agnes-video-2.5-flash"));
  check("V2.0 is not the 2.5 family",
    isVideo25Family("agnes-video-v2.0") === false && isVideo25Family(VIDEO_DEFAULT_MODEL) === false);
  check("the flash variant is recognised inside the 2.5 family",
    isVideo25Flash("agnes-video-2.5-flash") && isVideo25Flash("agnes-video-2.5") === false &&
    isVideo25Flash("agnes-video-v2.0") === false);

  const live = [
    { id: "agnes-2.0-flash" },
    { id: "agnes-image-2.5-flash" },
    { id: "agnes-video-2.5" },
    { id: "agnes-video-2.5-flash" },
    { id: "agnes-video-v2.0" }
  ];
  check("video models are found through the shared modality resolver",
    JSON.stringify(videoGenModelIds(live)) === JSON.stringify(["agnes-video-2.5", "agnes-video-2.5-flash", "agnes-video-v2.0"]),
    JSON.stringify(videoGenModelIds(live)));
  check("only the V2.0 family is addressable by the V2.0 helper",
    JSON.stringify(videoV2ModelIds(live)) === JSON.stringify(["agnes-video-v2.0"]),
    JSON.stringify(videoV2ModelIds(live)));
  check("the 2.5 subset is reported separately",
    JSON.stringify(video25ModelIds(live)) === JSON.stringify(["agnes-video-2.5", "agnes-video-2.5-flash"]),
    JSON.stringify(video25ModelIds(live)));

  check("an explicit request wins even when unlisted (manual override)",
    pickVideoModel(live, "custom-video", "") === "custom-video");
  check("auto-pick prefers V2.0 when both families are present",
    pickVideoModel(live, "", "") === "agnes-video-v2.0");
  check("a configured preference is honoured when the catalog confirms it",
    pickVideoModel(live, "", "agnes-video-v2.0") === "agnes-video-v2.0");
  check("a 2.5 preference is honoured — the tool drives both families now",
    pickVideoModel(live, "", "agnes-video-2.5-flash") === "agnes-video-2.5-flash");
  check("a 2.5 request is honoured through the tool call",
    pickVideoModel(live, "agnes-video-2.5", "") === "agnes-video-2.5");
  check("a stale preference outside the catalog falls back to auto-pick",
    pickVideoModel(live, "", "not-a-model") === "agnes-video-v2.0");
  check("a 2.5-only catalog falls back to the first 2.5 model",
    pickVideoModel([{ id: "agnes-video-2.5" }, { id: "agnes-video-2.5-flash" }], "", "") === "agnes-video-2.5");
  check("an empty catalog picks nothing", pickVideoModel([], "", "") === null);
}

// --- 3d. the auto-pick rule is restated in prose in four other places ------
// `pickVideoModel` is the source of truth, and 3a above already pins its
// behaviour branch by branch. What nothing pinned is the SENTENCE: the rule
// ("prefer one family, fall back to the other") is written out again in
//   * `host-config.ts` — the `videoModelId` doc comment,
//   * `video.ts`      — the tool's `model` parameter description (what the
//                       model itself reads when deciding what to pass),
//   * `i18n.ts`       — `video.autoOption`, zh AND en (what the user reads),
// plus this suite's own header. Five copies of one rule, none derived from the
// code that implements it.
//
// Two ways to write this fence badly, both rejected:
//   * Asserting each sentence contains "V2.0" — that is a sixth copy of the
//     rule wearing a test's clothes, and it stays green if the implementation
//     flips to 2.5-first.
//   * Requiring the preferred family's NAME to come first — this was the first
//     version, and it is spelling, not meaning. English states the same rule
//     both ways and both are correct: "the first V2.0 model, or the first 2.5
//     model when the catalog holds no V2.0 one" and "falling back to the first
//     2.5 model when the catalog holds no V2.0 one". Only the first shape
//     passed, so the fence was red on correct prose.
//
// What is actually invariant: the sentence names BOTH families, and it marks
// exactly one of them as the conditional fallback. The preferred family and the
// fallback marker are both DERIVED — the family from the function's own
// behaviour, the marker vocabulary from the rule's meaning — so flipping the
// implementation makes the prose, not the fence, the thing that must change.
{
  /** Which family the auto-pick actually reaches for first. */
  const bothFamilies = [{ id: "agnes-video-2.5" }, { id: "agnes-video-v2.0" }];
  const winner = pickVideoModel(bothFamilies, "", "");
  const preferred = winner === "agnes-video-v2.0" ? "V2.0" : "2.5";
  const fallback = preferred === "V2.0" ? "2.5" : "V2.0";

  // The anchor that keeps this honest: the derivation only means something if
  // the function really did prefer one family over the other. An empty or
  // unexpected pick would make every assertion below vacuous.
  check("the auto-pick's preferred family is derivable from the function",
    winner === "agnes-video-v2.0" || winner === "agnes-video-2.5",
    `pickVideoModel(both families) === ${JSON.stringify(winner)}`);

  const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

  /**
   * The CONDITION half of the rule — "when the catalog holds no V2.0 one",
   * 「无 V2.0 时」. Only this kind is read, because it is the half that names
   * what the rule is an exception TO.
   *
   * The bound is a WORD COUNT, not a punctuation class: an earlier version cut
   * clauses at `.`, which silently truncated every one of them at the dot in
   * "V2.0" — the clause read "when the catalogue has no V2", matched no family,
   * and the check reported "no exception clause names a family" on correct
   * prose. Family names contain dots; a clause delimiter cannot.
   */
  const CONDITION = /(?:when|if)\s+(?:\S+\s+){0,10}|无\s*(?:\S+\s*){0,10}?时/gi;

  /**
   * Does this text state the rule, with the DERIVED preference?
   *
   * Three designs were rejected before this one, all recorded because each
   * looked reasonable and each was wrong in a way only a negative test showed:
   *   * "does the sentence contain the family name" — a sixth copy of the rule
   *     in a test's clothes; green after the implementation flips.
   *   * "is an exception marker NEAR the fallback family" — green on sentences
   *     meaning the opposite (measured against a flipped implementation).
   *   * "does the exception clause name the FALLBACK family" — red on all four
   *     correct sentences. This is the one that taught the actual grammar.
   *
   * Every phrasing in this repo writes the rule the same way: the CONDITION
   * clause names the PREFERRED family as the thing that may be absent, and the
   * family that appears as the consequence is what you take instead —
   *   "…first 2.5 model when the catalog holds no V2.0 one"      (video.ts)
   *   "…falling back to the first 2.5 model when the catalog
   *      holds no V2.0 one"                                      (host-config.ts)
   *   「无 V2.0 时取第一个 2.5」                                     (i18n zh)
   *   "…(first 2.5 when the catalogue has no V2.0 one)"           (i18n en)
   * That is not a style choice: a condition clause has to name what it is a
   * condition ON. So the test reads the family inside the condition and
   * requires it to be the DERIVED preferred one. A sentence privileged the
   * other way names that other family in the condition instead, and fails.
   *
   * Reading only `when`/`if`/「…时」 and not the consequence phrase ("falling
   * back to 2.5") matters: host-config.ts carries both, so a test that accepted
   * any clause naming either family rejected that sentence — the clearest of
   * the four — because it saw the fallback named in the consequence.
   * @param {string} text
   * @returns {{ok: boolean, why: string}}
   */
  const statesRule = (text) => {
    // Flatten doc-comment line wraps; keep a space so words stay apart.
    const flat = text.replace(/\s*\n\s*\*?\s*/g, " ");

    let sawPreferred = false;
    let sawFallback = false;
    let bestWhy = "";
    for (let at = flat.indexOf(preferred); at >= 0; at = flat.indexOf(preferred, at + 1)) {
      sawPreferred = true;
      const near = flat.slice(Math.max(0, at - 120), at + 120);
      if (!near.includes(fallback)) continue;
      sawFallback = true;

      // The condition clause governing the rule, found either side of the
      // mention (it may precede or follow the family it qualifies).
      const window = flat.slice(Math.max(0, at - 130), at + 130);
      CONDITION.lastIndex = 0;
      const clauses = [...window.matchAll(CONDITION)].map((m) => m[0]);
      if (clauses.length === 0) {
        bestWhy = `no condition clause near the rule (${preferred} at ${at})`;
        continue;
      }

      // The condition names the family that may be ABSENT — the preferred one.
      // A sentence whose condition names the fallback family instead says the
      // opposite rule ("2.5 by default, V2.0 when there is no 2.5").
      const namesPreferred = clauses.some((c) => c.includes(preferred));
      const namesFallback = clauses.some((c) => c.includes(fallback));
      if (namesPreferred && !namesFallback) return { ok: true, why: "" };
      bestWhy = namesFallback && !namesPreferred
        ? `the condition names ${fallback}, so the sentence treats ${fallback} as the default — the code prefers ${preferred}`
        : `the condition names both families or neither: ${clauses.map((c) => JSON.stringify(c)).join(", ")}`;
    }
    if (!sawPreferred) return { ok: false, why: `never names ${preferred}` };
    if (!sawFallback) return { ok: false, why: `names ${preferred} but never the ${fallback} fallback nearby` };
    return { ok: false, why: bestWhy };
  };

  /**
   * The HEADER comment of a source file — everything before its first line of
   * real code.
   *
   * This matters for the self-check below: that site reads THIS file, and the
   * fence's own comments discuss the rule in both directions (including the
   * deliberately backwards example). Scanning the whole file let the suite
   * satisfy its own assertion from its own explanation — it passed against a
   * flipped implementation, at an offset inside `statesRule`'s docstring.
   * Confining each site to the text that actually documents it removes both
   * that self-reference and any unrelated aside.
   * @param {string} text
   * @returns {string}
   */
  const headerOf = (text) => {
    const lines = text.split(/\r?\n/);
    const out = [];
    for (const line of lines) {
      const t = line.trim();
      // Comment and blank lines belong to the header; the first code line ends it.
      if (t === "" || t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*/")) out.push(line);
      else break;
    }
    return out.join("\n");
  };

  /**
   * The text this site uses to document the rule. Narrower than the whole file
   * on purpose: a doc comment, a parameter description, a dictionary line, a
   * file header. Everything else is other people's prose.
   */
  const PROSE = [
    {
      name: "host-config.ts videoModelId doc",
      text: (() => {
        const src = read(join("src", "host", "host-config.ts"));
        // Anchor on the declaration, then take the doc block immediately above
        // it — the comment's own opening line is not a stable anchor (it may be
        // `/** text` or `/**` followed by `* text`).
        const decl = src.indexOf("videoModelId:");
        if (decl < 0) return "";
        const open = src.lastIndexOf("/**", decl);
        const close = src.indexOf("*/", open);
        return open < 0 || close < 0 || close > decl ? "" : src.slice(open, close + 2);
      })()
    },
    {
      name: "video.ts model parameter doc",
      text: (() => {
        const m = read(join("src", "host", "video.ts")).match(/model: \{ type: "string", description: "((?:[^"\\]|\\.)*)"/);
        return m?.[1] ?? "";
      })()
    },
    { name: "this suite's header", text: headerOf(read(join("test", "video.test.mjs"))) }
  ];

  for (const site of PROSE) {
    // A site that yields no text is a broken extraction, not a passing rule —
    // say so, rather than letting an empty string read as "names no family".
    const verdict = site.text.trim() === ""
      ? { ok: false, why: "could not extract this site's text (has the declaration moved?)" }
      : statesRule(site.text);
    check(`${site.name} states the auto-pick rule (prefers ${preferred}, ${fallback} as fallback)`,
      verdict.ok, verdict.why);
  }

  const options = [...read(join("src", "client", "i18n.ts"))
    .matchAll(/"video\.autoOption":\s*"([^"]*)"/g)].map((m) => m[1]);
  check("both dictionaries carry a video.autoOption line", options.length === 2, JSON.stringify(options));
  for (const [i, text] of options.entries()) {
    const verdict = statesRule(text);
    check(`video.autoOption [${i === 0 ? "zh" : "en"}] states the auto-pick rule`,
      verdict.ok, verdict.why || text);
  }
}

// --- 3b. 2.5 helpers: seconds conversion, size resolution, aspect match -----
{
  check("frame timing converts to whole seconds, clamped to 4-12",
    secondsFromFrameTiming(81, 24) === 4 &&
    secondsFromFrameTiming(121, 24) === 5 &&
    secondsFromFrameTiming(241, 24) === 10 &&
    secondsFromFrameTiming(441, 24) === 12,
    JSON.stringify({
      a: secondsFromFrameTiming(81, 24), b: secondsFromFrameTiming(121, 24),
      c: secondsFromFrameTiming(241, 24), d: secondsFromFrameTiming(441, 24)
    }));
  check("junk frame timing falls back to the documented 5s",
    secondsFromFrameTiming(undefined, undefined) === 5 && secondsFromFrameTiming("x", 0) === 5);

  check("aspect nearest-match picks the closest whitelisted ratio (landscape on a tie)",
    nearestAspect25(1152, 768) === "4:3" && nearestAspect25(768, 1152) === "3:4" &&
    nearestAspect25(1024, 1024) === "1:1" && nearestAspect25(1280, 960) === "4:3",
    JSON.stringify({ a: nearestAspect25(1152, 768), b: nearestAspect25(768, 1152), c: nearestAspect25(1024, 1024), d: nearestAspect25(1280, 960) }));
  check("invalid dimensions fall back to the documented 16:9 default",
    nearestAspect25(undefined, undefined) === "16:9" && nearestAspect25(0, 768) === "16:9" &&
    nearestAspect25("x", 768) === "16:9",
    JSON.stringify({ a: nearestAspect25(undefined, undefined), b: nearestAspect25(0, 768), c: nearestAspect25("x", 768) }));
}

// --- 3c. buildVideoBody25: the seconds scheme, mode/media, flash limits -----
// Note: the 2.5 wire body carries `first_frame` / `last_frame` / `images`
// media fields, never `image` — the image URL is mapped INTO the media slot,
// not sent as a top-level key.
//
// Aspect default: with no width/height the target ratio is exactly 16/9, and
// the aspect table stores 16:9 as a whitelisted value — so a minimal call
// lands on 16:9 (an EXACT table entry, not the nearest neighbour 4:3 which
// `nearestAspect25(1152, 768)` would resolve to).
//
// The builder emits the V2.0 fields FIRST (`model`, `prompt`), then the 2.5
// system fields (`mode`, `seconds`, `size`, `aspect_ratio`), and media/seed
// last — so the key-set check below is ORDER-INSENSITIVE (uses a Set), while
// the individual value checks pin each field's exact value.
{
  const text = buildVideoBody25({ model: "agnes-video-2.5-flash", prompt: "a cat" });
  const textKeys = new Set(Object.keys(text));
  check("a minimal 2.5 call is text mode, 5s, flash-pinned 720P, default 16:9 aspect",
    text.mode === "text" && text.seconds === "5" && text.size === "720P" &&
    text.aspect_ratio === "16:9" && textKeys.size === 6 &&
    textKeys.has("model") && textKeys.has("prompt") && textKeys.has("mode") &&
    textKeys.has("seconds") && textKeys.has("size") && textKeys.has("aspect_ratio") &&
    !textKeys.has("first_frame") && !textKeys.has("last_frame") &&
    !textKeys.has("images") && !textKeys.has("image") && !textKeys.has("negative_prompt") &&
    !textKeys.has("width") && !textKeys.has("height") &&
    !textKeys.has("num_frames") && !textKeys.has("frame_rate"),
    JSON.stringify(text));

  const full = buildVideoBody25({
    model: "agnes-video-2.5",
    prompt: "p",
    mode: "reference",
    seconds: 8,
    size: "960P",
    aspectRatio: "9:16",
    keyframes: ["https://img/a.png", "https://img/b.png", "https://img/c.png"],
    seed: 3
  });
  check("explicit 2.5 fields travel (seed included, reference media from keyframes)",
    full.seconds === "8" && full.size === "960P" && full.aspect_ratio === "9:16" &&
    full.mode === "reference" && JSON.stringify(full.images) ===
    JSON.stringify(["https://img/a.png", "https://img/b.png", "https://img/c.png"]) && full.seed === 3,
    JSON.stringify(full));

  check("an explicit seconds is submitted as a string",
    buildVideoBody25({ model: "agnes-video-2.5", prompt: "p", seconds: 12 }).seconds === "12");

  check("num_frames/frame_rate convert to seconds when seconds is omitted",
    buildVideoBody25({ model: "agnes-video-2.5", prompt: "p", numFrames: 241, frameRate: 24 }).seconds === "10");

  check("width/height steer the aspect nearest-match on 2.5",
    buildVideoBody25({ model: "agnes-video-2.5", prompt: "p", width: 768, height: 1365 }).aspect_ratio === "9:16");

  check("a single image maps to keyframe first_frame (aspect resolves to the 16:9 default)",
    JSON.stringify(buildVideoBody25({ model: "agnes-video-2.5", prompt: "p", image: "https://img/a.png" })) ===
    JSON.stringify({ model: "agnes-video-2.5", prompt: "p", mode: "keyframe", seconds: "5", size: "720P", aspect_ratio: "16:9", first_frame: "https://img/a.png" }));

  check("exactly two keyframes map to keyframe first/last (the mode derives even when one is forced)",
    (() => {
      const a = buildVideoBody25({ model: "agnes-video-2.5", prompt: "p", keyframes: ["https://a/1.png", "https://b/2.png"] });
      const b = buildVideoBody25({ model: "agnes-video-2.5", prompt: "p", keyframes: ["https://a/1.png", "https://b/2.png"], mode: "keyframe" });
      const expected = (body) => body.mode === "keyframe" &&
        body.first_frame === "https://a/1.png" && body.last_frame === "https://b/2.png" &&
        !("images" in body);
      return expected(a) && expected(b);
    })());

  // throw-not-clamp for the explicit 2.5 values:
  check("an out-of-range seconds throws",
    (await rejects(() => buildVideoBody25({ model: "agnes-video-2.5", prompt: "p", seconds: 3 }))) !== null);
  check("a non-whitelisted size throws",
    (await rejects(() => buildVideoBody25({ model: "agnes-video-2.5", prompt: "p", size: "480P" }))) !== null);
  check("a non-whitelisted aspect_ratio throws",
    (await rejects(() => buildVideoBody25({ model: "agnes-video-2.5", prompt: "p", aspectRatio: "5:4" }))) !== null);

  check("an illegal mode string throws",
    (await rejects(() => buildVideoBody25({ model: "agnes-video-2.5", prompt: "p", mode: "video" }))) !== null);

  check("an explicit valid mode is honoured even when media would derive a different one",
    buildVideoBody25({ model: "agnes-video-2.5", prompt: "p", mode: "reference", image: "https://img/a.png" }).mode === "reference");

  check("a non-integer seed throws",
    (await rejects(() => buildVideoBody25({ model: "agnes-video-2.5", prompt: "p", seed: 1.5 }))) !== null);
  check("image and keyframes together throw",
    (await rejects(() => buildVideoBody25({ model: "agnes-video-2.5", prompt: "p", image: "https://i/1.png", keyframes: ["https://i/1.png"] }))) !== null);
  check("a non-URL reference image throws",
    (await rejects(() => buildVideoBody25({ model: "agnes-video-2.5", prompt: "p", image: "local.png" }))) !== null);

  // the flash variant is pinned to 720P and capped at 5 reference images:
  check("flash accepts 720P and rejects a higher tier",
    buildVideoBody25({ model: "agnes-video-2.5-flash", prompt: "p", size: "720P" }).size === "720P" &&
    (await rejects(() => buildVideoBody25({ model: "agnes-video-2.5-flash", prompt: "p", size: "2K" }))) !== null);
  check("flash caps reference images at 5",
    (await rejects(() => buildVideoBody25({
      model: "agnes-video-2.5-flash", prompt: "p",
      keyframes: ["https://1/x.png", "https://2/x.png", "https://3/x.png", "https://4/x.png", "https://5/x.png", "https://6/x.png"]
    }))) !== null &&
    buildVideoBody25({
      model: "agnes-video-2.5-flash", prompt: "p",
      keyframes: ["https://1/x.png", "https://2/x.png", "https://3/x.png", "https://4/x.png", "https://5/x.png"]
    }).images !== undefined);

  // Every 2.5 error must name the model that was actually addressed, not just a
  // family — that is what lets the agent self-correct without reading the
  // catalog. Asserted on the message, because a regression to "2.5 系列" would
  // otherwise be invisible to the throw-only checks above.
  {
    const secondsErr = await rejects(() => buildVideoBody25({ model: "agnes-video-2.5-flash", prompt: "p", seconds: 3 }));
    const sizeErr = await rejects(() => buildVideoBody25({ model: "agnes-video-2.5-flash", prompt: "p", size: "2K" }));
    const aspectErr = await rejects(() => buildVideoBody25({ model: "agnes-video-2.5", prompt: "p", aspectRatio: "5:4" }));
    const modeErr = await rejects(() => buildVideoBody25({ model: "agnes-video-2.5", prompt: "p", mode: "video" }));
    const seedErr = await rejects(() => buildVideoBody25({ model: "agnes-video-2.5", prompt: "p", seed: 1.5 }));
    const conflictErr = await rejects(() => buildVideoBody25({
      model: "agnes-video-2.5", prompt: "p", image: "https://i/1.png", keyframes: ["https://i/1.png"]
    }));
    const contextErr = await rejects(() => buildVideoBody25({ model: "", prompt: "p", seconds: 3 }));
    check("every 2.5 error names the actual model and its parameter system",
      [secondsErr, sizeErr, aspectErr, modeErr, seedErr, conflictErr].every(
        (message) => /模型 agnes-video-2\.5[^（]*（2\.5 秒数制）：/.test(message ?? ""),
      ),
      JSON.stringify([secondsErr, sizeErr, aspectErr, modeErr, seedErr, conflictErr]));
    check("a missing model id is named as missing rather than dropped",
      /模型 \(未指定模型\)（2\.5 秒数制）：/.test(contextErr ?? ""), contextErr);
    check("the flash tier limit is stated for the flash model",
      /仅支持 720P/.test(sizeErr ?? ""), sizeErr);
    check("the seconds range is restated on the seconds error",
      /4–12/.test(secondsErr ?? ""), secondsErr);
  }
}

// --- 4. buildVideoBody: valid shapes and the throw-not-clamp rule -----------
{
  const full = buildVideoBody({
    model: "agnes-video-v2.0",
    prompt: "a cat",
    width: 1152,
    height: 768,
    numFrames: 121,
    frameRate: 24,
    seed: 7,
    negativePrompt: "blurry",
    image: "https://img/a.png"
  });
  check("every V2.0 field travels",
    full.model === "agnes-video-v2.0" && full.prompt === "a cat" && full.width === 1152 &&
    full.height === 768 && full.num_frames === 121 && full.frame_rate === 24 &&
    full.seed === 7 && full.negative_prompt === "blurry" && full.image === "https://img/a.png");

  const minimal = buildVideoBody({ model: "m", prompt: "p" });
  check("omitted optional fields are absent, not zeroed",
    JSON.stringify(Object.keys(minimal).sort()) === JSON.stringify(["model", "prompt"]));

  check("an empty negative_prompt is omitted",
    buildVideoBody({ model: "m", prompt: "p", negativePrompt: "   " }).negative_prompt === undefined);

  // A clamped frame count would silently change the video's DURATION after
  // minutes of generation, so these throw instead of being overruled.
  const badFrames = await rejects(() => buildVideoBody({ model: "m", prompt: "p", numFrames: 100 }));
  check("an illegal num_frames throws with the 8n+1 rule and a suggestion",
    /8n\+1/.test(badFrames ?? "") && /121/.test(badFrames ?? ""), badFrames);
  check("a num_frames over 441 throws",
    (await rejects(() => buildVideoBody({ model: "m", prompt: "p", numFrames: 449 }))) !== null);
  check("a frame_rate below 1 throws",
    (await rejects(() => buildVideoBody({ model: "m", prompt: "p", frameRate: 0 }))) !== null);
  check("a frame_rate above 60 throws",
    (await rejects(() => buildVideoBody({ model: "m", prompt: "p", frameRate: 61 }))) !== null);
  check("a zero width throws",
    (await rejects(() => buildVideoBody({ model: "m", prompt: "p", width: 0 }))) !== null);
  check("a fractional height throws",
    (await rejects(() => buildVideoBody({ model: "m", prompt: "p", height: 768.5 }))) !== null);
  check("a non-integer seed throws",
    (await rejects(() => buildVideoBody({ model: "m", prompt: "p", seed: 1.5 }))) !== null);
  check("a non-URL image throws",
    (await rejects(() => buildVideoBody({ model: "m", prompt: "p", image: "a.png" }))) !== null);
  check("an http (not https) image is accepted — the rule is public-fetchable, not TLS",
    buildVideoBody({ model: "m", prompt: "p", image: "http://img/a.png" }).image === "http://img/a.png");
}

// --- 5. create-task response parsing ----------------------------------------
{
  const preferred = parseVideoTask({ video_id: "v-1", task_id: "t-1", status: "queued" });
  check("video_id and task_id are both read",
    preferred.videoId === "v-1" && preferred.taskId === "t-1" && preferred.status === "queued");
  check("video_id is the identifier a poll addresses",
    videoTaskIdOf(preferred) === "v-1");
  check("task_id is the fallback",
    videoTaskIdOf(parseVideoTask({ task_id: "t-2" })) === "t-2");
  check("the legacy `id` spelling is the same field",
    videoTaskIdOf(parseVideoTask({ id: "t-3" })) === "t-3");
  check("junk reads as no identifier",
    videoTaskIdOf(parseVideoTask(null)) === "" && videoTaskIdOf(parseVideoTask("x")) === "");
}

// --- 6. status-query response parsing ---------------------------------------
{
  const done = parseVideoQuery({
    video_id: "v-1", status: "COMPLETED", progress: 100,
    seconds: "5", size: "1152x768", url: "https://cdn/v.mp4"
  });
  check("a terminal state is lowercased for comparison",
    done.status === "completed" && isVideoTerminal(done.status));
  check("url, seconds and size are read",
    done.url === "https://cdn/v.mp4" && done.seconds === "5" && done.size === "1152x768");

  check("url falls back to metadata.url (the two-layer compatibility)",
    parseVideoQuery({ status: "completed", metadata: { url: "https://cdn/m.mp4" } }).url === "https://cdn/m.mp4");
  check("the top-level url outranks metadata.url",
    parseVideoQuery({ url: "https://cdn/top.mp4", metadata: { url: "https://cdn/meta.mp4" } }).url === "https://cdn/top.mp4");
  check("a numeric seconds value is stringified",
    parseVideoQuery({ status: "completed", seconds: 5 }).seconds === "5");

  // num() insists on a POSITIVE value, which would erase a legitimate 0%.
  check("progress 0 stays 0 rather than reading as absent",
    parseVideoQuery({ status: "in_progress", progress: 0 }).progress === 0);
  check("a missing progress reads as 0",
    parseVideoQuery({ status: "queued" }).progress === 0);

  check("terminal states are completed and failed only",
    isVideoTerminal("completed") && isVideoTerminal("failed") &&
    isVideoTerminal("queued") === false && isVideoTerminal("in_progress") === false &&
    isVideoTerminal("") === false);
  check("the error payload survives for the failure message",
    parseVideoQuery({ status: "failed", error: "nsfw" }).error === "nsfw");
}

// --- 7. describeVideoFailure: the quota-vs-rate split -----------------------
{
  const q = describeVideoFailure(429, '{"code":"insufficient_quota"}');
  check("a quota 429 says so (do not retry blind)", /配额不足/.test(q), q);
  const r = describeVideoFailure(429, "rate limit exceeded");
  check("a rate-limit 429 names the shared create+poll pool", /5 RPM/.test(r) && /共用/.test(r), r);
  check("auth failures point at the key, not the endpoint",
    /AGNES_TOKEN_PLAN_API_KEY/.test(describeVideoFailure(401, "")));
  const nf = describeVideoFailure(404, "");
  check("a 404 names both endpoint shapes", /\/videos/.test(nf) && /agnesapi/.test(nf), nf);
  check("other statuses carry the raw body (truncated)",
    describeVideoFailure(500, "x".repeat(500)).length < 400);
}

// --- 8. createVideoTask / queryVideoTask against a fake fetch ---------------
{
  const endpoint = "https://api.agnes-ai.cn/v1/videos";
  const queryEndpoint = "https://api.agnes-ai.cn/agnesapi";
  let seen;
  const fetchOk = async (url, options) => {
    seen = { url, options };
    return okResponse({ video_id: "v-9", task_id: "t-9", status: "queued" });
  };
  try {
    const task = await createVideoTask({
      fetchImpl: fetchOk,
      endpoint,
      apiKey: "sk-test",
      body: buildVideoBody({ model: "agnes-video-v2.0", prompt: "a cat" })
    });
    check("create returns the task identifiers", task.videoId === "v-9");
    check("create POSTs to the create endpoint", seen.url === endpoint && seen.options.method === "POST");
    check("the bearer key travels in the header",
      seen.options.headers.Authorization === "Bearer sk-test");
    check("the body is JSON-encoded", JSON.parse(seen.options.body).model === "agnes-video-v2.0");
  } catch (error) {
    fail("createVideoTask success path", error);
  }

  {
    const message = await rejects(() => createVideoTask({
      fetchImpl: async () => errResponse(429, '{"code":"insufficient_quota"}'),
      endpoint, apiKey: "sk-test", body: {}
    }));
    check("a refused create is classified, not raw", /配额不足/.test(message ?? ""), message);
  }
  {
    const message = await rejects(() => createVideoTask({
      fetchImpl: async () => okResponse({ status: "queued" }),
      endpoint, apiKey: "sk-test", body: {}
    }));
    check("a create with no task identifier fails loudly instead of polling nothing",
      /未返回 video_id/.test(message ?? ""), message);
  }

  {
    let seenQuery;
    const value = await queryVideoTask({
      fetchImpl: async (url, options) => {
        seenQuery = { url, options };
        return okResponse({ status: "in_progress", progress: 40 });
      },
      queryEndpoint, apiKey: "sk-test", videoId: "v-9", model: "agnes-video-v2.0"
    });
    check("query uses GET", seenQuery.options.method === "GET");
    check("query hits the agnesapi endpoint, not /v1",
      seenQuery.url.startsWith("https://api.agnes-ai.cn/agnesapi?") && !seenQuery.url.includes("/v1/"), seenQuery.url);
    check("video_id and model_name travel as query parameters",
      seenQuery.url.includes("video_id=v-9") && seenQuery.url.includes("model_name=agnes-video-v2.0"), seenQuery.url);
    check("an in-progress answer is parsed", value.status === "in_progress" && value.progress === 40);
  }
}

// --- 9. pollVideoResult: the async spine -----------------------------------
{
  const base = {
    fetchImpl: async () => okResponse({ status: "completed", url: "https://cdn/v.mp4" }),
    queryEndpoint: "https://api.agnes-ai.cn/agnesapi",
    apiKey: "sk-test",
    videoId: "v-1",
    sleep: async () => {},
    now: () => 0
  };

  try {
    const done = await pollVideoResult(base);
    check("a completed task returns immediately", done.status === "completed" && done.url === "https://cdn/v.mp4");
  } catch (error) {
    fail("pollVideoResult completed path", error);
  }

  {
    const states = ["queued", "in_progress", "completed"];
    let index = 0;
    const value = await pollVideoResult({
      ...base,
      fetchImpl: async () => okResponse({ status: states[Math.min(index++, states.length - 1)] })
    });
    check("a queued task is polled again until it terminates",
      value.status === "completed" && index === 3, `queries=${index}`);
  }
  {
    const value = await pollVideoResult({
      ...base,
      fetchImpl: async () => okResponse({ status: "failed", error: "nsfw content" })
    });
    check("a failed task ends the loop (the tool turns it into an error)", value.status === "failed");
  }
  {
    // The clock advances past the budget, so the loop must stop rather than
    // query forever. The timeout carries the video_id, because the task keeps
    // running server-side.
    let clock = 0;
    const message = await rejects(() => pollVideoResult({
      ...base,
      fetchImpl: async () => okResponse({ status: "in_progress" }),
      timeoutMs: 10_000,
      now: () => (clock += 6_000)
    }));
    check("the budget is wall-clock and the timeout names the video_id",
      /超时/.test(message ?? "") && /video_id=v-1/.test(message ?? ""), message);
    check("the timeout tells the agent not to re-submit",
      /不要重复提交/.test(message ?? ""), message);
  }
  {
    const message = await rejects(() => pollVideoResult({ ...base, isDisposed: () => true }));
    check("a disposed plugin stops polling", /no longer mounted/.test(message ?? ""), message);
  }
  {
    let waited = [];
    let calls = 0;
    const value = await pollVideoResult({
      ...base,
      fetchImpl: async () => okResponse({ status: ++calls < 3 ? "queued" : "completed", url: "https://cdn/v.mp4" }),
      pollIntervalMs: 5_000,
      sleep: async (ms) => { waited.push(ms); },
      // A frozen clock never reaches the deadline, so this case also pins the
      // poll-count ceiling: without it the loop would spin forever.
      now: () => 0
    });
    check("the poll interval is honoured between queries",
      value.status === "completed" && waited.length === 2 && waited[0] === 5_000, JSON.stringify(waited));
  }
  {
    // The injected clock never advances and the task never terminates: the
    // loop must still stop, on the poll-count ceiling.
    const message = await rejects(() => pollVideoResult({
      ...base,
      fetchImpl: async () => okResponse({ status: "queued" }),
      sleep: async () => {},
      now: () => 0
    }));
    check("a non-advancing clock cannot make the poll loop spin forever",
      /轮询超过/.test(message ?? "") && /video_id=v-1/.test(message ?? ""), message);
  }
  {
    // A REFUSED query is not a terminal task — the platform still holds the job.
    // The failure must therefore name the video_id, as the timeout and
    // over-poll paths already do, instead of leaving the agent with a bare
    // "video failed: HTTP 429 …" and no way to come back for a task that is
    // still running.
    let refusedCalls = 0;
    const message = await rejects(() => pollVideoResult({
      ...base,
      fetchImpl: async () => { refusedCalls += 1; return errResponse(429, "rate limit exceeded"); },
      queryRetries: 1,
      sleep: async () => {},
      now: () => 0
    }));
    check("a refused query retries then names the video_id",
      /视频生成查询被拒/.test(message ?? "") && /video_id=v-1/.test(message ?? ""), message);
    // The counter closes the loop the message alone could not: without it the
    // check above would also pass if the retry were dead and the loop threw on
    // the first refusal. `retries=1` means one re-query, i.e. two fetch calls.
    check("the exhausted path really did retry before throwing",
      refusedCalls === 2, `calls=${refusedCalls}`);
    check("the query-refused error keeps the platform's own words",
      /rate limit exceeded/.test(message ?? ""), message);
    check("the query-refused error tells the agent not to re-submit",
      /不要重复提交/.test(message ?? ""), message);
  }
  {
    // `queryRetries=0` is the lower bound of the retry parameter: NO re-query,
    // the task id is handed back on the first refusal. `Math.max(0, …)` clamps
    // a negative override to this same shape, so the zero case is the whole
    // "carry the id, never retry" behaviour and must not drift.
    const message = await rejects(() => pollVideoResult({
      ...base,
      fetchImpl: async () => errResponse(429, "rate limit exceeded"),
      queryRetries: 0,
      sleep: async () => {},
      now: () => 0
    }));
    check("queryRetries=0 refuses to re-query yet still names the video_id",
      /视频生成查询被拒/.test(message ?? "") && /video_id=v-1/.test(message ?? ""), message);
  }
  {
    // A transient 429 on the query endpoint must not cost the agent the task:
    // the loop retries a bounded number of times and, when the platform
    // answers, returns the result rather than failing.
    let calls = 0;
    const value = await pollVideoResult({
      ...base,
      fetchImpl: async () => {
        calls += 1;
        return calls < 3 ? errResponse(429, "rate limit exceeded") : okResponse({ status: "completed", url: "https://cdn/v.mp4" });
      },
      queryRetries: 2,
      sleep: async () => {},
      now: () => 0
    });
    check("a transient query refusal is retried into a result",
      value.status === "completed" && calls === 3, `calls=${calls}`);
  }
}

// --- 10. defineVideoTool end-to-end ----------------------------------------
{
  const passthrough = (definition) => definition;
  const liveCatalog = [
    { id: "agnes-2.5-flash" },
    { id: "agnes-image-2.5-flash" },
    { id: "agnes-video-2.5-flash" },
    { id: "agnes-video-v2.0" }
  ];
  const makeTool = (overrides = {}) => defineVideoTool({
    defineTool: passthrough,
    resolveApiKey: async () => "sk-test",
    getEntries: async () => liveCatalog,
    settings: {
      apiBase: "https://api.agnes-ai.cn/v1",
      videoModelId: "",
      videoTimeoutMs: 600_000,
      videoWidth: 1152,
      videoHeight: 768,
      videoNumFrames: 121,
      videoFrameRate: 24
    },
    fetchImpl: async (url) => {
      if (url.includes("/agnesapi")) return okResponse({ status: "completed", url: "https://cdn/v.mp4", seconds: "5", size: "1152x768" });
      return okResponse({ video_id: "v-42", status: "queued" });
    },
    ...overrides
  });

  check("the tool is named as expected", makeTool().name === VIDEO_TOOL_NAME);

  try {
    const result = await makeTool().execute({ prompt: "a cat on a beach" });
    check("a full run returns the url, model and video_id",
      result.url === "https://cdn/v.mp4" && result.model === "agnes-video-v2.0" && result.videoId === "v-42",
      JSON.stringify(result));
    check("the hint carries a Markdown link for the agent",
      /\[视频\]\(https:\/\/cdn\/v\.mp4\)/.test(result.hint ?? ""), result.hint);
    check("the hint reports duration and resolution",
      /时长: 5 秒/.test(result.hint ?? "") && /分辨率: 1152x768/.test(result.hint ?? ""), result.hint);
  } catch (error) {
    fail("defineVideoTool full run", error);
  }

  {
    const message = await rejects(() => makeTool().execute({ prompt: "" }));
    check("an empty prompt is refused", /prompt is required/.test(message ?? ""), message);
  }
  {
    const message = await rejects(() => makeTool({ resolveApiKey: async () => "" }).execute({ prompt: "x" }));
    check("a missing key points at the panel", /AGNES_TOKEN_PLAN_API_KEY/.test(message ?? ""), message);
  }
  {
    const message = await rejects(() => makeTool({ getEntries: async () => [] }).execute({ prompt: "x" }));
    check("an empty catalog degrades with the catalog hint", /没有视频模型/.test(message ?? ""), message);
  }
  {
    // A 2.5-only catalog now DISPATCHES through the 2.5 body builder (whole
    // seconds / 720P / 16:9 / text mode) instead of explaining the gap.
    let seenBody;
    const tool25 = makeTool({
      getEntries: async () => [{ id: "agnes-video-2.5-flash" }],
      fetchImpl: async (url, options) => {
        if (url.includes("/agnesapi")) return okResponse({ status: "completed", url: "https://cdn/v.mp4", seconds: "5" });
        seenBody = JSON.parse(options.body);
        return okResponse({ video_id: "v-25", status: "queued" });
      }
    });
    const result25 = await tool25.execute({ prompt: "x" });
    check("a 2.5-only catalog addresses the 2.5 model, not an error",
      result25.model === "agnes-video-2.5-flash" && result25.url === "https://cdn/v.mp4",
      JSON.stringify(result25));
    check("the 2.5 body is the seconds scheme with no V2.0 fields",
      seenBody?.mode === "text" && seenBody?.seconds === "5" && seenBody?.size === "720P" &&
      seenBody?.aspect_ratio === "16:9" && seenBody?.model === "agnes-video-2.5-flash" &&
      !("width" in seenBody) && !("num_frames" in seenBody) && !("frame_rate" in seenBody) &&
      !("height" in seenBody),
      JSON.stringify(seenBody));
  }
  {
    // V2.0 keeps its own body when explicitly selected from a mixed catalog;
    // 2.5-style frame timing on a 2.5 model converts to seconds.
    let seenBody;
    const toolBoth = makeTool({
      fetchImpl: async (url, options) => {
        if (url.includes("/agnesapi")) return okResponse({ status: "completed", url: "https://cdn/v.mp4" });
        seenBody = JSON.parse(options.body);
        return okResponse({ video_id: "v-25", status: "queued" });
      }
    });
    await toolBoth.execute({ prompt: "x", model: "agnes-video-v2.0", num_frames: 121, frame_rate: 24, width: 1152, height: 768 });
    check("a V2.0 model still gets the V2.0 frame fields, never the 2.5 scheme",
      seenBody?.num_frames === 121 && seenBody?.frame_rate === 24 && seenBody?.width === 1152 &&
      seenBody?.height === 768 && !("seconds" in seenBody) && !("mode" in seenBody) &&
      !("aspect_ratio" in seenBody) && seenBody?.model === "agnes-video-v2.0",
      JSON.stringify(seenBody));

    seenBody = null;
    await toolBoth.execute({ prompt: "x", model: "agnes-video-2.5-flash", num_frames: 81, frame_rate: 24, width: 768, height: 1365 });
    check("num_frames/frame_rate on a 2.5 model convert to seconds, width/height to aspect",
      seenBody?.seconds === "4" && seenBody?.aspect_ratio === "9:16" &&
      !("num_frames" in seenBody) && !("frame_rate" in seenBody) &&
      !("width" in seenBody) && !("height" in seenBody),
      JSON.stringify(seenBody));

    let v2Err;
    try {
      await makeTool().execute({ prompt: "x", model: "agnes-video-v2.0", num_frames: 100 });
    } catch (error) {
      v2Err = error?.message ?? String(error);
    }
    check("an illegal V2.0 frame count still throws before any request on a V2.0 model",
      /8n\+1/.test(v2Err ?? ""), String(v2Err));
  }
  {
    // The REVERSE mix: 2.5-only fields addressed at a V2.0 model. buildVideoBody
    // destructures only the V2.0 fields, so they used to vanish silently — the
    // agent asks for a 10s 2K clip and receives a 5s 720P one, with no signal.
    const errSeconds = await rejects(() => makeTool().execute({ prompt: "x", seconds: 10, size: "2K" }));
    check("2.5-only fields on a V2.0 model are refused, not silently dropped",
      /模型 agnes-video-v2\.0 是 V2\.0 帧制/.test(errSeconds ?? "") && /`seconds`/.test(errSeconds ?? "") &&
        /`size`/.test(errSeconds ?? ""),
      errSeconds);
    check("the refusal names the fix: address a 2.5 model or use frame fields",
      /agnes-video-2\.5/.test(errSeconds ?? "") && /改用 num_frames \/ frame_rate/.test(errSeconds ?? ""), errSeconds);

    const errAll = await rejects(() => makeTool().execute({
      prompt: "x", model: "agnes-video-v2.0", seconds: 8, size: "960P", aspect_ratio: "9:16",
      mode: "reference", keyframes: ["https://a/1.png", "https://b/2.png"]
    }));
    check("every 2.5-only field is named in the refusal",
      VIDEO25_ONLY_FIELDS.every((field) => new RegExp("\\`" + field + "\\`").test(errAll ?? "")),
      errAll);
    check("the refusal lists exactly the 2.5-only field set",
      JSON.stringify([...(errAll ?? "").matchAll(/\`([a-z_]+)\`/g)].map((match) => match[1]))
        === JSON.stringify(VIDEO25_ONLY_FIELDS),
      errAll);

    // A V2.0-native call must not trip the guard: negative_prompt / image / seed
    // are shared or V2.0-native, so the guard only reaches for 2.5-only fields.
    let v2Body;
    const toolV2 = makeTool({
      fetchImpl: async (url, options) => {
        if (url.includes("/agnesapi")) return okResponse({ status: "completed", url: "https://cdn/v.mp4" });
        v2Body = JSON.parse(options.body);
        return okResponse({ video_id: "v-v2", status: "queued" });
      }
    });
    const v2Result = await toolV2.execute({ prompt: "x", negative_prompt: "blurry", image: "https://i/1.png", seed: 7 });
    check("a V2.0-native call (negative_prompt / image / seed) still dispatches",
      v2Result.url === "https://cdn/v.mp4" && v2Result.model === "agnes-video-v2.0" &&
        v2Body?.negative_prompt === "blurry" && v2Body?.seed === 7 && v2Body?.image === "https://i/1.png" &&
        !("keyframes" in v2Body) && !("seconds" in v2Body) && !("mode" in v2Body),
      JSON.stringify(v2Body));
  }
  {
    // The create call must still succeed here — only the QUERY reports failure.
    const message = await rejects(() => makeTool({
      fetchImpl: async (url) => (url.includes("/agnesapi")
        ? okResponse({ status: "failed", error: "nsfw content" })
        : okResponse({ video_id: "v-42", status: "queued" }))
    }).execute({ prompt: "x" }));
    check("a failed task becomes an actionable error carrying the video_id",
      /视频生成失败/.test(message ?? "") && /v-42/.test(message ?? "") && /nsfw/.test(message ?? ""), message);
  }
  {
    // Red line 1, fourth surface: this message lands in the AGENT conversation,
    // and the detail is the platform's own error object — a 4xx body may echo
    // the API key it was sent with. `draw.ts` redacts its equivalent string
    // (describeDrawFailure) and `video-protocol.ts` redacts describeVideoFailure;
    // this task-failure path hand-rolled the same shape and used to skip it.
    const LEAK = "sk-should-never-reach-the-agent";
    const message = await rejects(() => makeTool({
      fetchImpl: async (url) => (url.includes("/agnesapi")
        ? okResponse({ status: "failed", error: `upstream rejected: key ${LEAK} is not authorized` })
        : okResponse({ video_id: "v-43", status: "queued" }))
    }).execute({ prompt: "x" }));
    check("a failed task REDACTS an API key echoed back by the platform",
      !String(message ?? "").includes(LEAK), message);
    check("that redaction keeps the diagnostic (video_id + the rest of the detail)",
      /视频生成失败/.test(message ?? "") && /v-43/.test(message ?? "") && /not authorized/.test(message ?? ""), message);
  }
  {
    const message = await rejects(() => makeTool({ isDisposed: () => true }).execute({ prompt: "x" }));
    check("a disposed plugin refuses video generation", /no longer mounted/.test(message ?? ""), message);
  }
  {
    // The key is resolved per call, so rotating the panel-saved reference takes
    // effect on the next generation without re-registration.
    let key = "sk-first";
    let seenAuth = [];
    const tool = makeTool({
      resolveApiKey: async () => key,
      fetchImpl: async (url, options) => {
        seenAuth.push(options.headers.Authorization);
        if (url.includes("/agnesapi")) return okResponse({ status: "completed", url: "https://cdn/v.mp4" });
        return okResponse({ video_id: "v-1" });
      }
    });
    await tool.execute({ prompt: "one" });
    key = "sk-second";
    await tool.execute({ prompt: "two" });
    check("the key is resolved per call, not cached at registration",
      seenAuth.includes("Bearer sk-first") && seenAuth.includes("Bearer sk-second"), JSON.stringify(seenAuth));
  }
  {
    const result = await makeTool().execute({ prompt: "x", model: "custom-vid", num_frames: 81, frame_rate: 24 });
    check("an explicit model overrides the catalog pick", result.model === "custom-vid");
  }
  {
    const message = await rejects(() => makeTool().execute({ prompt: "x", num_frames: 100 }));
    check("an illegal parameter surfaces before any request is sent",
      /8n\+1/.test(message ?? ""), message);
  }
}

console.log(JSON.stringify(results, null, 2));
const failedChecks = results.filter((r) => !r.pass);
if (failedChecks.length > 0) {
  console.error(`\n${failedChecks.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
