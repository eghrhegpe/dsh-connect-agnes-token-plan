/**
 * The Agnes image-generation module ("draw absorption", ARCHITECTURE §5.4
 * route B) — the PEER-FREE half.
 *
 * Like `llm-models.ts` this module imports no runtime peer: it maps catalog
 * entries, builds wire bodies and classifies failures as plain functions, so
 * every decision here is testable on a clean checkout. The peer-dependent
 * half lives in `index.ts`: the `@deepseek-ai/dsh-tools` import and the
 * `ctx.tools` registration are loaded lazily and only when the `drawEnabled`
 * opt-in is on — a Host without the tools service simply never sees the tool,
 * exactly like the provider degrades without an `llm` service.
 *
 * Two design facts are load-bearing rather than cosmetic:
 *
 * 1. Model identification is delegated to `modality.ts` — the ONE resolver
 *    this tool shares with the chat roster, so the two lists can never
 *    disagree about what exists. ARCHITECTURE §5.4 originally had this module
 *    read the catalog's own `output_modalities` field directly, to beat
 *    `dsh-draw-router`'s name patterns (they miss `Agnes-u1.5-lite` outright).
 *    That field does not exist on the Agnes gateway — its `/v1/models` entries
 *    carry no modality metadata at all (live-verified 2026-10-01) — so the
 *    strict reading left this tool unable to pick ANY model while the catalog
 *    was full of image models. `modality.ts` keeps the declared field as the
 *    first choice and falls back to the platform's own family segment; its
 *    header carries the full record of the reversal.
 * 2. The key is resolved per call (`resolveApiKey`), never cached: rotating
 *    the panel-saved `AGNES_TOKEN_PLAN_API_KEY` reference takes effect on the next
 *    draw without re-registration, mirroring the LLM adapter.
 *
 * @module dsh-connect-agnes-token-plan/draw
 */

import { str, num, redactSecrets, resolveToolInputs, mergedSignal, isAbortError } from "./util.ts";
import { isImageGenModel } from "./modality.ts";
import type { DrawRequest } from "./types.ts";

// Re-exported so the draw module still reads as one self-contained surface for
// its callers and tests. The definition lives in `modality.ts` because the
// chat roster must resolve modalities through the SAME function — see the
// module header, design fact 1.
export { isImageGenModel };

/** The agent tool name. Scoped so it cannot collide with `dsh-draw-router`'s `draw_image`. */
export const DRAW_TOOL_NAME = "agnes_draw_image";

/** How long after a failed draw the next attempt is refused. Borrowed from dsh-draw-router (its probe cooldown). */
export const DRAW_COOLDOWN_MS = 30_000;

/** Default deadline for one image request; image models are slow, chat deadlines do not apply. */
export const DRAW_DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Build the `images/generations` endpoint from the OpenAI-compatible base.
 *
 * Mirrors `dsh-draw-router`'s `buildEndpoint` (upstream line 72-79) so every
 * operator spelling of `apiBase` lands on the same URL:
 * `…/v1` → `…/v1/images/generations`; an URL already ending in
 * `/images/generations` passes through; a deeper `/v1/<something>` is rewound
 * to `/v1`; anything else gets `/v1/images/generations` appended.
 * @param {string} apiBase - the configured base (default `https://token.Agnes.cn/v1`).
 * @returns {string} the full draw endpoint.
 */
export function buildDrawEndpoint(apiBase) {
  const trimmed = str(apiBase, "").trim().replace(/\/+$/, "");
  if (trimmed === "") return "";
  if (/\/images\/generations$/.test(trimmed)) return trimmed;
  if (/\/v1$/.test(trimmed)) return `${trimmed}/images/generations`;
  if (/\/v1\//.test(trimmed)) return trimmed.replace(/\/v1\/.*$/, "/v1/images/generations");
  return `${trimmed}/v1/images/generations`;
}

/**
 * The draw-capable model ids of one catalog, de-duplicated in first-seen order.
 *
 * The ids are unique in first-seen order — a `Set` is all this needs. At the
 * id level there is no "which row survived" question the way `rosterOf` /
 * `buildDescriptors` / `catalog-store.normalizeEntries` have (they keep the
 * LAST row for an id, at its first-seen position), so the draw list and the
 * chat roster agree about which ids exist without sharing that row-level rule.
 * It WAS copied here, and the duplicate branch re-assigned the same id back to
 * its own slot — dead code that implied an ordering rule this function cannot
 * express.
 * @param {object[]} entries - the normalized catalog entries.
 * @returns {string[]}
 */
export function imageGenModelIds(entries) {
  const ids = new Set<string>();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isImageGenModel(entry)) continue;
    const id = str(entry?.id, "");
    if (id !== "") ids.add(id);
  }
  return [...ids];
}

/**
 * Choose the model one draw call addresses.
 *
 * Precedence: an explicitly requested id wins even when the catalog does not
 * list it (a manual override, like `dsh-draw-router`; the platform answers
 * the error itself if the id is wrong) — but an empty catalog with nothing
 * requested yields `null`, and the caller turns that into the actionable
 * "no draw models" error rather than sending a doomed request.
 * @param {object[]} entries - the normalized catalog entries.
 * @param {string} [requested] - the tool call's `model` parameter.
 * @param {string} [preferred] - the configured default (`drawModelId`).
 * @returns {string|null} the chosen id, or `null` when nothing can be picked.
 */
export function pickDrawModel(entries, requested, preferred) {
  const want = str(requested, "").trim();
  if (want !== "") return want;
  const ids = imageGenModelIds(entries);
  if (ids.length === 0) return null;
  const config = str(preferred, "").trim();
  if (config !== "" && ids.includes(config)) return config;
  return ids[0];
}

/**
 * The size tiers the image endpoint documents (official Agnes Image 2.5/2.1
 * Flash request tables).
 */
export const DRAW_SIZE_TIERS: readonly string[] = Object.freeze(["1K", "2K", "3K", "4K"]);

/** The aspect ratios the image endpoint documents (official request table). */
export const DRAW_ASPECT_RATIOS: readonly string[] = Object.freeze(["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"]);

/**
 * ratio → the four tier cells, verbatim from the official 输出尺寸参考 table
 * (docs/AGNES-API-docs/Agnes Image 2.5 Flash.md §尺寸与宽高比; 2.1 Flash carries
 * the same table). This is the ONLY set of exact WIDTHxHEIGHT values the tool
 * accepts: any other exact size is "compatible syntax" the platform silently
 * STANDARDIZES (the docs' own example: 1920x1080 → 16:9 1K = 1312x736), and a
 * silent rewrite is exactly the shape where the plugin promised an exact pixel
 * size it never honored. So the table ships as data and the gate reads it —
 * reject locally, never let the platform quietly decide the output.
 */
export const DRAW_OUTPUT_SIZES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "1:1": Object.freeze(["1024x1024", "2048x2048", "3072x3072", "4096x4096"]),
  "3:4": Object.freeze(["864x1152", "1728x2304", "2592x3456", "3456x4608"]),
  "4:3": Object.freeze(["1152x864", "2304x1728", "3456x2592", "4608x3456"]),
  "16:9": Object.freeze(["1312x736", "2624x1472", "3936x2208", "5248x2944"]),
  "9:16": Object.freeze(["736x1312", "1472x2624", "2208x3936", "2944x5248"]),
  "2:3": Object.freeze(["832x1248", "1664x2496", "2496x3744", "3328x4992"]),
  "3:2": Object.freeze(["1248x832", "2496x1664", "3744x2496", "4992x3328"]),
  "21:9": Object.freeze(["1568x672", "3136x1344", "4704x2016", "6272x2688"])
});

/**
 * The tool-call fields the draw endpoint understands. The host projects
 * `parameters` as-is and validates nothing at runtime — an unknown key
 * (`count: 2`, a leftover `aspect_ratio`) would otherwise sail past the schema
 * and be silently ignored, letting the agent believe it had taken effect.
 */
const DRAW_ALLOWED_ARGS: readonly string[] = Object.freeze(["prompt", "model", "size", "ratio", "image", "return_base64", "n"]);

/** Prefix every pre-send rejection with the two facts the agent must know. */
function drawArgsError(message: string): Error {
  return new Error(`出图参数错误（请求未发出：不消耗额度，也不会触发冷却）：${message}`);
}

function typeNameOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Total indexed read for the closed frozen tables below. Under
 * `noUncheckedIndexedAccess` every `a[i]` is `T | undefined`; these tables are
 * compile-time literals with fixed shapes, so an out-of-range read is
 * unreachable — throw rather than sprinkle `!`, so a future table edit that
 * breaks an invariant fails loudly at the call instead of silently typing as
 * undefined downstream.
 */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`internal: index ${index} out of table range`);
  return value;
}

/** Total record read for DRAW_OUTPUT_SIZES (keys come from the frozen table itself). */
function rowOf(ratio: string): readonly string[] {
  const row = DRAW_OUTPUT_SIZES[ratio];
  if (row === undefined) throw new Error(`internal: no output row for ratio ${ratio}`);
  return row;
}

/** Split a "WxH" / "W:H" literal into two numbers, total under strict mode. */
function splitPair(text: string, sep: string): [number, number] {
  const parts = text.split(sep);
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`internal: malformed pair ${text}`);
  return [a, b];
}

/** Exact-dimension spelling: digits, ONE x/X/× separator, no spaces, no "*", no units. */
const DRAW_EXACT_DIMS = /^(\d+)[xX×](\d+)$/;

/**
 * Reverse-look an exact WIDTHxHEIGHT through the official table.
 * @param {string} dims - e.g. "2624x1472" (already trimmed).
 * @returns {{tier: string, ratio: string}|null} the cell's tier+ratio, or null.
 */
export function drawSizeToTierRatio(dims: string): { tier: string; ratio: string } | null {
  const m = DRAW_EXACT_DIMS.exec(dims);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  for (const [ratio, cells] of Object.entries(DRAW_OUTPUT_SIZES)) {
    for (let i = 0; i < cells.length; i += 1) {
      const [cw, ch] = splitPair(at(cells, i), "x");
      if (cw === w && ch === h) return { tier: at(DRAW_SIZE_TIERS, i), ratio };
    }
  }
  return null;
}

/**
 * The nearest native tier+ratio suggestion for a rejected exact size.
 *
 * Ratio = the whitelisted aspect closest to w/h; tier = the smallest cell of
 * that ratio whose long edge covers the requested long edge (the docs' own
 * recipe: ask the native cell, crop/scale downstream). 1920x1080 → 16:9 2K =
 * 2624x1472; 360x720 → 9:16 1K = 736x1312. The TOOL does this arithmetic so
 * the suggestion is guaranteed valid — a hand-rounded agent guess often names
 * a size that fails the very next gate.
 * @param {number} width - requested width (positive finite).
 * @param {number} height - requested height (positive finite).
 * @returns {{size: string, ratio: string, output: string}}
 */
export function suggestDrawSize(width: number, height: number): { size: string; ratio: string; output: string } {
  const target = width / height;
  let bestRatio = at(DRAW_ASPECT_RATIOS, 0);
  let bestErr = Infinity;
  for (const r of DRAW_ASPECT_RATIOS) {
    const [rw, rh] = splitPair(r, ":");
    const err = Math.abs(rw / rh - target);
    if (err < bestErr) { bestErr = err; bestRatio = r; }
  }
  const cells = rowOf(bestRatio);
  const maxEdge = Math.max(width, height);
  let idx = cells.length - 1;
  for (let i = 0; i < cells.length; i += 1) {
    const [cw, ch] = splitPair(at(cells, i), "x");
    if (Math.max(cw, ch) >= maxEdge) { idx = i; break; }
  }
  return { size: at(DRAW_SIZE_TIERS, idx), ratio: bestRatio, output: at(cells, idx) };
}

/**
 * The output cell one ACCEPTED (post-gate) size resolves to, for the success
 * hint. An exact cell echoes itself; a tier resolves through the ratio (default
 * 1:1 — the documented default). "" when nothing can be said.
 * @param {string} size - the validated size.
 * @param {string} [ratio] - the validated ratio, if any.
 * @returns {string} e.g. "2624x1472".
 */
export function expectedDrawOutputSize(size: string, ratio?: string): string {
  if (drawSizeToTierRatio(size)) return size;
  const ti = DRAW_SIZE_TIERS.indexOf(size.toUpperCase());
  if (ti < 0) return "";
  const key = ratio && DRAW_ASPECT_RATIOS.includes(ratio) ? ratio : "1:1";
  return DRAW_OUTPUT_SIZES[key]?.[ti] ?? "";
}

/** The normalized, wire-ready argument set `validateDrawArgs` produces. */
export interface ValidatedDrawArgs {
  prompt: string;
  model?: string;
  size?: string;
  ratio?: string;
  image?: string[];
  returnBase64: boolean;
}

/**
 * The pre-send gate for one `agnes_draw_image` call: validate and normalize
 * EVERY argument, or throw a message that names every accepted form.
 *
 * Discipline ported from the sibling workbuddy plugin (strict input, plugin
 * owns the math, reject loudly): the plugin cannot force the model to spell
 * things right, but every WRONG spelling it accepts becomes the plugin's lie —
 * a silently-ignored `ratio`, a standardized size presented as "exact", an
 * array-valued `model` quietly falling back to the default while spending
 * quota. So:
 * - unknown keys are refused (the schema is advisory; the host validates nothing);
 * - wrong types are refused, never coerced (`str()` fallbacks hide them);
 * - `size` is tier constant or an exact cell of the official table — the only
 *   spellings whose output the plugin can PREDICT;
 * - `image` must be a non-empty array of http(s)/data strings (a bare string or
 *   `[]` says "wrap it" / "omit it", not a silent t2i fallback);
 * - `return_base64` + `image` refuse each other (the docs scope return_base64
 *   to text2img; sending both would silently drop one);
 * - `n` must be exactly 1 (the platform 400s anything else — refuse locally for free).
 * Omission is not a wrong spelling: absent/`null`/`""` mean "not given"
 * (size stays optional here — omitting it is documented default behavior,
 * unlike workbuddy where the upstream hard-requires it).
 * Runs BEFORE cooldown.blocked() and before resolveToolInputs, so a rejected
 * call costs no key read, no catalogue read, no quota, no cooldown window.
 * @param {Record<string, unknown>} params - the raw tool-call arguments.
 * @returns {ValidatedDrawArgs} normalized values safe to forward.
 * @throws {Error} on the first violation, prefixed with the no-cost facts.
 */
export function validateDrawArgs(params: Record<string, unknown>): ValidatedDrawArgs {
  const source = params ?? {};
  const unknownKeys = Object.keys(source).filter((key) => !DRAW_ALLOWED_ARGS.includes(key));
  if (unknownKeys.length > 0) {
    throw drawArgsError(`不认识参数 ${unknownKeys.map((k) => `\`${k}\``).join(" / ")}；本工具只接受 ${DRAW_ALLOWED_ARGS.map((k) => `\`${k}\``).join(" / ")}，schema 的 additionalProperties 不设防，未知键会被平台静默忽略——你以为生效的比例其实从未发出`);
  }

  // prompt: the one message that keeps its old wording (video tool spells it
  // the same; tests and traces grep on it).
  const rawPrompt = source.prompt;
  if (rawPrompt !== undefined && rawPrompt !== null && typeof rawPrompt !== "string") {
    throw drawArgsError(`prompt 必须是字符串，收到 ${typeNameOf(rawPrompt)}`);
  }
  const prompt = typeof rawPrompt === "string" ? rawPrompt.trim() : "";
  if (prompt === "") throw new Error("prompt is required");

  const out: ValidatedDrawArgs = { prompt, returnBase64: false };

  const model = source.model;
  if (model !== undefined && model !== null && typeof model !== "string") {
    throw drawArgsError(`model 必须是字符串，收到 ${typeNameOf(model)}；不要传 ["id"] 这样的数组——它会静默落回目录默认模型并照常消耗额度`);
  }
  const wantedModel = typeof model === "string" ? model.trim() : "";
  if (wantedModel !== "") out.model = wantedModel;

  // --- size: tier constant or exact table cell, nothing else ------------------
  let sizeKind: "tier" | "exact" | null = null;
  const size = source.size;
  if (size !== undefined && size !== null && typeof size !== "string") {
    throw drawArgsError(`size 必须是字符串，收到 ${typeNameOf(size)}`);
  }
  const dims = typeof size === "string" ? size.trim() : "";
  if (dims !== "") {
    const tierIdx = DRAW_SIZE_TIERS.indexOf(dims.toUpperCase());
    if (tierIdx >= 0) {
      sizeKind = "tier";
      out.size = at(DRAW_SIZE_TIERS, tierIdx);
    } else {
      const exact = drawSizeToTierRatio(dims);
      if (exact) {
        sizeKind = "exact";
        // Canonical spelling: DRAW_EXACT_DIMS already proved the shape, so
        // "2624X1472 " / "2624x1472" all leave as the table's own "2624x1472".
        const dm = DRAW_EXACT_DIMS.exec(dims)!;
        out.size = `${Number(dm[1])}x${Number(dm[2])}`;
      } else {
        // The full-cases sentence, then the arithmetic the plugin owes the
        // caller: for anything WxH-shaped, name the nearest native cell.
        let hint = "";
        const m = DRAW_EXACT_DIMS.exec(dims);
        if (m) {
          const sug = suggestDrawSize(Number(m[1]), Number(m[2]));
          hint = `。\`${dims}\` 不是表内原生尺寸，平台会把它静默标准化（官方示例：1920x1080 → 16:9 1K = 1312x736），结果不可预期。按你的宽高比，最接近的原生组合是 size:"${sug.size}" + ratio:"${sug.ratio}"（输出 ${sug.output}），下游再裁剪；请改用该组合，或直接写表内精确尺寸`;
        } else {
          hint = `。"${dims}" 的写法本身不合法（精确尺寸须是 "宽x高"：数字 + 一个 x/X/× + 数字，无空格、无 "*"、无单位）`;
        }
        throw drawArgsError(`size "${dims}" 不被接受；合法写法只有两种——档位常量 ${DRAW_SIZE_TIERS.join(" / ")}（配合 ratio）或官方档位表内的精确尺寸（如 1024x1024、2624x1472、736x1312）${hint}`);
      }
    }
  }

  // --- ratio: whitelist only; pairs with a tier, contradicts an exact cell ----
  const ratio = source.ratio;
  if (ratio !== undefined && ratio !== null && typeof ratio !== "string") {
    throw drawArgsError(`ratio 必须是字符串，收到 ${typeNameOf(ratio)}`);
  }
  const ar = typeof ratio === "string" ? ratio.trim() : "";
  if (ar !== "") {
    if (!DRAW_ASPECT_RATIOS.includes(ar)) {
      throw drawArgsError(`ratio "${ar}" 不在支持列表：只有 ${DRAW_ASPECT_RATIOS.join(" / ")}（默认 1:1）`);
    }
    if (sizeKind === "exact") {
      const cell = drawSizeToTierRatio(dims)!;
      if (cell.ratio !== ar) {
        throw drawArgsError(`size "${dims}" 与 ratio "${ar}" 矛盾：精确尺寸已自带宽高比（该尺寸是 ${cell.ratio} 的 ${cell.tier} 格）。二选一：去掉 ratio，或改传 size:"${cell.tier}" + ratio:"${ar}"`);
      }
      // Same intent stated twice — the exact cell carries it; do not send a
      // redundant ratio the dialect might reinterpret.
    } else {
      out.ratio = ar;
    }
  }

  // --- image: non-empty ARRAY of fetchable strings ----------------------------
  const image = source.image;
  if (image !== undefined && image !== null) {
    if (!Array.isArray(image)) {
      throw drawArgsError(`image 必须是字符串数组，收到 ${typeNameOf(image)}；单张参考图也要包一层：["..."]`);
    }
    if (image.length === 0) {
      throw drawArgsError("image 不能是空数组；纯文生图请把 image 字段整个省略，不要传 []");
    }
    const list: string[] = [];
    for (let i = 0; i < image.length; i += 1) {
      const item = image[i];
      if (typeof item !== "string" || item.trim() === "") {
        throw drawArgsError(`image[${i}] 必须是非空字符串，收到 ${typeNameOf(item)}`);
      }
      const ref = item.trim();
      if (!/^(https?:\/\/|data:)/i.test(ref)) {
        throw drawArgsError(`image[${i}] 必须是公共 http(s) URL 或 data: URI，收到 "${ref.slice(0, 80)}"；平台无法抓取本机路径，先把它变成可访问的 URL`);
      }
      list.push(ref);
    }
    out.image = list;
  }

  // --- n: the platform hard-requires 1; refuse anything else locally ----------
  if (source.n !== undefined && source.n !== null && source.n !== 1) {
    throw drawArgsError(`n 只能是 1（平台对 n:2 直接 400「n 必须为 1」），收到 ${JSON.stringify(source.n)}；每次调用出一张图`);
  }

  // --- return_base64: strict boolean, and it cannot coexist with image ---------
  const rb = source.return_base64;
  if (rb !== undefined && rb !== null && typeof rb !== "boolean") {
    throw drawArgsError(`return_base64 必须是布尔值，收到 ${typeNameOf(rb)}；字符串 "true" 不会被当真`);
  }
  if (rb === true) {
    if (out.image) {
      throw drawArgsError("return_base64 与 image 互斥：官方文档把 return_base64 限定在文生图，图生图的 Base64 输出要走 extra_body.response_format（本工具未接通该通路）；请去掉 return_base64（改收 URL），或去掉 image");
    }
    out.returnBase64 = true;
  }

  return out;
}

/**
 * Build the `images/generations` request body.
 *
 * Only the fields the endpoint actually consumes travel: `n` is clamped to a
 * sane range (a fraction floors, junk and out-of-range values fall back to 1)
 * and `response_format` defaults to `url` — the panel/agent-facing shape that
 * renders as a Markdown image without the client having to handle base64.
 * @param {object} options - `{ model, prompt, n, size, responseFormat }`.
 * @returns {object} the wire body.
 */
export function buildDrawBody(options: Partial<DrawRequest> = {}) {
  const { model, prompt, size, ratio, image, returnBase64, responseFormat } = options;
  const body: Record<string, unknown> = {
    model: str(model, ""),
    prompt: str(prompt, ""),
    // The platform hard-requires n=1 ;
    // a larger value is a 400, so only 1 is ever forwarded.
    n: 1,
    response_format: str(responseFormat, "url") || "url"
  };
  const dims = str(size, "").trim();
  if (dims !== "") body.size = dims;
  // ratio, image, and return_base64 are Agnes gateway dialect fields,
  // forwarded under extra_body (the OpenAI-compatible extension channel).
  // `response_format` is already a top-level OpenAI standard field and is
  // verified by live probe to work at top level (AGNES-API §7.5 point ③),
  // so it stays top-level — do not migrate it.
  const ar = str(ratio, "").trim();
  const imgs = Array.isArray(image)
    ? image.map((x) => str(x, "")).filter((x) => x !== "")
    : [];
  const extra: Record<string, unknown> = {};
  if (ar !== "") extra.ratio = ar;
  if (imgs.length > 0) extra.image = imgs;
  if (returnBase64 === true) extra.return_base64 = true;
  if (Object.keys(extra).length > 0) body.extra_body = extra;
  return body;
}

/**
 * Extract the first image out of an `images/generations` response.
 * @param {object} data - the parsed response JSON.
 * @returns {{url: string, b64Json: string, revisedPrompt: string}}
 * @throws {Error} when the response carries no `data[0]` at all.
 */
export function parseDrawResponse(data) {
  const item = data?.data?.[0];
  if (item === null || typeof item !== "object") {
    throw new Error("draw: unexpected response, missing data[0]");
  }
  return {
    url: str(item.url, ""),
    b64Json: str(item.b64_json, ""),
    revisedPrompt: str(item.revised_prompt, "")
  };
}

/**
 * Turn a failed HTTP answer into the message the agent (and the trace) reads.
 *
 * The split mirrors the 429 discipline already fixed for chat (ROADMAP §1-2):
 * "insufficient/quota" in a 429 means the shared pool is drained — retrying
 * the same request is waste — while any other 429 is a rate limit and a plain
 * wait helps. Auth failures point at the panel's key area instead of at
 * "the endpoint is broken".
 * @param {number} status - the HTTP status code.
 * @param {string} bodyText - the raw body (best effort, may be empty).
 * @returns {string} the panel/agent-facing message.
 */
export function describeDrawFailure(status, bodyText) {
  // The slice is redacted before embedding: a 4xx body may echo the API key
  // it was sent with, and this message lands in the agent conversation, not
  // just a panel line — the same red line `redactSecrets` guards on the
  // provider / desktop-upstream / route surfaces (PITFALLS §15).
  const text = redactSecrets(str(bodyText, "").slice(0, 300));
  if (status === 401 || status === 403) {
    return `draw failed: HTTP ${status} — the AGNES_TOKEN_PLAN_API_KEY is missing, invalid or not authorized for this model. Set it in the panel's 模型接入 area${text === "" ? "" : `; body: ${text}`}`;
  }
  if (status === 429) {
    if (/insufficient|quota/i.test(text)) {
      return `draw failed: HTTP 429 — 配额不足（共享池已耗尽或该出图模型不在套餐内），稍后或换模型再试; body: ${text}`;
    }
    return `draw failed: HTTP 429 — 限频，请稍等重试; body: ${text}`;
  }
  if (status === 404) {
    return `draw failed: HTTP 404 — 模型不存在或 endpoint 不对（检查 apiBase 与模型 id）${text === "" ? "" : `; body: ${text}`}`;
  }
  return `draw failed: HTTP ${status}${text === "" ? "" : ` ${text}`}`;
}

/**
 * Fire one draw request and parse the answer.
 *
 * The deadline aborts through an `AbortController` (the `AbortSignal.timeout`
 * spelling would do, but the controller also cancels the in-flight body read
 * and keeps the whole flow injectable for tests). A non-2xx answer never
 * reaches JSON parsing: its classified message is thrown with the REDACTED
 * body slice attached, so the agent sees WHY, not just that it failed,
 * without a credential the platform may have echoed back.
 * @param {object} options - wiring.
 * @param {Function} options.fetchImpl - the fetch to use (injected; the real
 *   `globalThis.fetch` arrives from `index.ts`).
 * @param {string} options.endpoint - the full `images/generations` URL.
 * @param {string} options.apiKey - the resolved `sk-` key.
 * @param {object} options.body - the wire body (`buildDrawBody`).
 * @param {number} [options.timeoutMs] - the deadline.
 * @param {AbortSignal} [options.signal] - the caller's cancellation signal
 *   (`exec.signal`); merged onto the deadline so a cancelled call stops here
 *   instead of running to its full budget.
 * @returns {Promise<{url: string, b64Json: string, revisedPrompt: string, model: string}>}
 */
export async function drawOnce({ fetchImpl, endpoint, apiKey, body, timeoutMs = DRAW_DEFAULT_TIMEOUT_MS, signal }) {
  if (typeof fetchImpl !== "function") throw new Error("drawOnce: fetchImpl is required");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`draw timeout after ${timeoutMs}ms`)), Math.max(1_000, timeoutMs));
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: mergedSignal(controller, signal)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(describeDrawFailure(response.status, text));
    }
    const data = await response.json().catch(() => {
      throw new Error("draw: response is not valid JSON");
    });
    return { ...parseDrawResponse(data), model: str(body?.model, "") };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The failed-draw cooldown gate.
 *
 * Borrowed from `dsh-draw-router` (its probe failure cooldown, upstream line
 * 196): after one failed draw the next attempt is refused for a window, so a
 * drained pool does not get hammered by an agent retrying in a loop. The
 * clock is wall-time, so the gate reopens by itself when the window passes —
 * deliberately NO success-side reset: a tripped gate blocks the execute entry
 * itself, so a success can only ever happen on an open gate and a reset call
 * there would be dead code.
 * @param {number} [cooldownMs] - the window.
 * @returns {{blocked: Function, trip: Function, remainingMs: Function}}
 */
export function createDrawCooldown(cooldownMs = DRAW_COOLDOWN_MS) {
  let until = 0;
  return {
    blocked: (now = Date.now()) => now < until,
    trip: (now = Date.now()) => { until = now + cooldownMs; },
    remainingMs: (now = Date.now()) => Math.max(0, until - now)
  };
}

/**
 * Build the agent tool object for `ctx.tools.register`.
 *
 * Pure wiring: the peer's `defineTool` factory arrives as a parameter (so this
 * module stays importable without the peer), and every side effect the tool
 * needs — key resolution, the live catalog, the fetch, disposal — is injected.
 * `index.ts` calls this only when `drawEnabled` is on AND a tools service is
 * present; every failure inside `execute` throws so the agent reads the
 * reason, and the panel is never involved (no snapshot key, no route).
 * @param {object} options - wiring.
 * @param {Function} options.defineTool - the peer's tool factory.
 * @param {Function} options.resolveApiKey - async `() => Promise<string>`, the
 *   live `AGNES_TOKEN_PLAN_API_KEY` value (empty when unset).
 * @param {Function} options.getEntries - `() => catalog entries` (sync or
 *   async), read at call time so a catalog refresh is picked up without
 *   re-registration. The caller (`index.ts`) hands the FULL persisted catalog,
 *   not the picker's allow-list-filtered offer — the curation binds the picker,
 *   never the agent's tools.
 * @param {object} options.settings - `{ apiBase, drawModelId, drawTimeoutMs }`.
 * @param {Function} options.fetchImpl - the fetch for `drawOnce`.
 * @param {object} [options.cooldown] - a `createDrawCooldown()` gate.
 * @param {Function} [options.isDisposed] - `() => boolean`, true after unmount.
 * @returns {object} the tool definition for `ctx.tools.register`.
 */
export function defineDrawTool({
  defineTool,
  resolveApiKey,
  getEntries,
  settings,
  fetchImpl,
  cooldown = createDrawCooldown(),
  isDisposed = () => false
}) {
  const timeoutMs = Math.max(5_000, Math.floor(num(settings?.drawTimeoutMs, DRAW_DEFAULT_TIMEOUT_MS)));
  return defineTool({
    name: DRAW_TOOL_NAME,
    description:
      "Generate an image with the Agnes Token Plan key. " +
      "Omit `model` to use the operator's configured draw model (else the catalog's first image model); pass `model` only when you need a particular one — successful results list the available image model ids whenever the catalog is loaded. A passed `model` is forwarded VERBATIM (the local gate does not check ids against the catalog): an unknown id costs a real call and trips the 30 s failure cooldown, so copy an id from the list instead of inventing one. " +
      "`image` takes an ARRAY of reference images (public http(s) URLs or data: URIs) for img2img — multiple references are supported and ALL are forwarded as extra_body.image in the given order, unmodified. The platform reads each reference's ROLE from the prompt, so name the roles there (first image = main character, second = product reference, …) rather than relying on position alone. " +
      "Keep the prompt short and prioritized (state what must be preserved FIRST, then what to change), and supply pre-cropped references — this tool cannot crop: unrelated elements in a reference (a character's hair, a prop, a background) tend to leak into the result and overwrite the same attribute on the target. " +
      "Input is validated strictly and WRONG spellings are refused outright (unknown keys, non-string types, sizes outside the official tier table) with the request never sent — no quota spent, no cooldown tripped; each rejection names the violated rule plus the accepted forms or the nearest legal substitute, so follow it exactly instead of guessing again. This local wall covers spellings only — see the `model` note above for the one field NOT caught before sending.",
    parameters: {
      prompt: { type: "string", required: true, description: "Image generation prompt. Keep it concise and prioritized: state what must be preserved first (layout, pose, style), then what to change. Long multi-requirement prompts are only partially followed — the model tends to regenerate instead of preserving." },
      model: { type: "string", description: "Agnes image model id; defaults to the configured draw model, else the first catalog image model. Unknown ids are forwarded verbatim — they cost a real call and trip the failure cooldown" },
      size: { type: "string", description: "Image size — ONLY these two spellings: a tier constant '1K' / '2K' / '3K' / '4K' (pair with ratio; e.g. 2K + 16:9 = 2624x1472) or an EXACT cell of the official tier×ratio table (1024x1024, 2048x2048, 3072x3072, 4096x4096; 864x1152…3456x4608; 1152x864…4608x3456; 1312x736, 2624x1472, 3936x2208, 5248x2944; 736x1312, 1472x2624, 2208x3936, 2944x5248; 832x1248…3328x4992; 1248x832…4992x3328; 1568x672…6272x2688). Anything else (360x720, 1920x1080) is rejected BEFORE the request is sent — the platform silently standardizes unsupported exact sizes, and the tool will not let a promise of exact pixels hide that rewrite. Omit for the platform default. When you pass a size, the URL result hint echoes the cell it maps to (base64 results and size-less calls echo nothing)." },
      ratio: { type: "string", description: "Aspect ratio: 1:1, 3:4, 4:3, 16:9, 9:16, 2:3, 3:2, 21:9 (default 1:1); forwarded as extra_body.ratio. Pair it with a tier size; a ratio with no size is still forwarded, but that combination is unprobed on the platform and the hint will echo nothing. Contradicts an exact size (which carries its own ratio) and is rejected." },
      image: { type: "array", items: { type: "string" }, description: "Reference image URL(s) / Data URIs for img2img — an ARRAY: pass multiple references and ALL are forwarded as extra_body.image in the given order, unmodified; declare each reference's role in the prompt instead of relying on position. Supply pre-cropped references (this tool cannot crop): unrelated elements in a reference (hair, props, background) tend to bleed into the result and override the same attribute on the target. data: URIs are sent as-is with NO local size check — keep each small; a multi-MB body becomes an upstream error that trips the cooldown." },
      return_base64: { type: "boolean", description: "Request Base64 output instead of a URL (text2img only — img2img has no inline-Base64 path in this tool, URL only there); forwarded as extra_body.return_base64. The bytes come back in the result's `url` field as a data: URI, which means they enter the conversation context — a 2K PNG is several MB of text. Leave it off unless you specifically need the bytes inline." },
      // The sentence states the platform's limit in words; `buildDrawBody`
      // hard-codes `n: 1` rather than reading it from here. That used to be
      // backed by an exported `DRAW_MAX_IMAGES` constant — which no longer had a
      // reader, because this description had been hand-written all along
      // (PITFALLS §38: an export kept for a consumer that does not exist). If
      // the platform ever accepts more, change both lines together.
      n: { type: "number", description: "Image count; the platform currently requires exactly 1 (default 1)" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          source: { type: "string" },
          model: { type: "string" },
          url: { type: "string" },
          prompt: { type: "string" },
          hint: { type: "string" }
        }
      },
      // Two parameters + array return: the shape dsh-draw-router had to fix
      // (its upstream "Bug 1+2") — keep both, the renderer is called with the
      // call args first and the result second.
      render: (_args, result) => [{ type: "text", text: result?.hint || "图片已生成" }]
    },
    timeoutMs: timeoutMs + 10_000,
    async execute(params, exec) {
      if (isDisposed()) throw new Error("Agnes draw tool is no longer mounted");
      // The caller's cancellation signal, forwarded into the request so an
      // aborted call settles at once instead of running to its full budget
      // (the tools peer reads the `timeoutMs` declaration as an assertion that
      // the body forwards `exec.signal`). The tests invoke `execute(params)`
      // with one argument, so `exec` is optional and everything below
      // tolerates its absence.
      const signal = exec?.signal;
      // Strict input gate runs BEFORE cooldown.blocked() and before the key +
      // catalogue reads: a malformed call is the agent's mistake, not the
      // platform's — refusing it must cost no quota and no 30 s cooldown
      // window, and the rejection must enumerate the accepted forms (see
      // validateDrawArgs). Everything below works on the normalized values.
      const args = validateDrawArgs(params ?? {});
      if (cooldown.blocked()) {
        throw new Error(`draw cooldown: 上一次出图失败，${Math.ceil(cooldown.remainingMs() / 1000)}s 后再试`);
      }
      // Key + catalogue through the shared tool preamble: the key is validated
      // before the catalogue is touched, so an unconfigured deployment costs no
      // read. The cooldown gate above stays draw-only (video has no cooldown).
      const { apiKey, entries } = await resolveToolInputs({ resolveApiKey, getEntries });
      if (signal?.throwIfAborted) signal.throwIfAborted();
      const model = pickDrawModel(entries, args.model, settings?.drawModelId);
      if (model === null || model === undefined) {
        throw new Error(
          "catalog 中没有出图模型（`output_modalities` 字段与 `agnes-image-*` 名称判定均为空）：确认 Key 已配置、面板已至少轮询一次，且套餐含出图模型"
        );
      }
      // Conditional spreads, not `size: args.size`: under
      // exactOptionalPropertyTypes an optional property may be ABSENT but never
      // explicitly `undefined`, and buildDrawBody's `str()` fallbacks treat both
      // the same anyway — absent is the honest spelling of "not given".
      const body = buildDrawBody({
        model,
        prompt: args.prompt,
        returnBase64: args.returnBase64,
        ...(args.size === undefined ? {} : { size: args.size }),
        ...(args.ratio === undefined ? {} : { ratio: args.ratio }),
        ...(args.image === undefined ? {} : { image: args.image })
      });
      let result;
      try {
        result = await drawOnce({
          fetchImpl,
          endpoint: buildDrawEndpoint(settings?.apiBase),
          apiKey,
          body,
          timeoutMs,
          signal
        });
      } catch (error) {
        // A cancelled call is not a failed draw: tripping the cooldown would
        // punish the next attempt for a stop the agent asked for.
        if (!isAbortError(error)) cooldown.trip();
        throw error;
      }
      const ids = imageGenModelIds(entries);
      const modelList = ids.length > 0 ? `\n可用出图模型: ${ids.join(", ")}` : "";
      // State the size the request resolves to (exact cell echoes itself; a
      // tier maps through ratio, default 1:1). Only when the caller gave a
      // size — the platform's own default is not something we can name.
      const sizeNote = args.size ? expectedDrawOutputSize(args.size, args.ratio) : "";
      // The base64 branch used to say "render this as a data URI" while the
      // payload stayed in `b64Json` and never reached the result: the agent was
      // told to display bytes it had never been given (and `parseDrawResponse`
      // extracting them made the parser suite green, which is where the false
      // confidence came from). The bytes now ride in `url` as a data URI — the
      // one field the result has — so "asked for base64" means "got base64".
      const inline = result.b64Json !== "" ? `data:image/png;base64,${result.b64Json}` : "";
      const source = result.url !== "" ? result.url : inline;
      const hint = result.url !== ""
        ? `图片已生成!\n模型: ${result.model}${sizeNote ? `\n尺寸: ${sizeNote}` : ""}\nURL: ${result.url}\n请直接输出 Markdown: ![图](${result.url})${modelList}`
        : inline !== ""
          ? `图片已生成!\n模型: ${result.model}\n平台按 return_base64 返回了 base64，已放进结果的 url 字段（data URI）。它已经在上下文里，不要再整段贴回对话；要落盘就写入文件，要展示就直接引用该字段。${modelList}`
          : `图片已生成，但平台既没返回 url 也没返回 b64_json——模型: ${result.model}；重试时去掉 return_base64。${modelList}`;
      return {
        source: "agnes",
        model: result.model,
        url: source,
        prompt: args.prompt,
        hint
      };
    }
  });
}

