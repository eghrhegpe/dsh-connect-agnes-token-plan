/**
 * 429 误判纠正层（llm-error-fix.js）的离线检查。
 *
 * 不 import 任何 Host peer，纯函数 + 稳定协议字符串即可覆盖：
 *   - `looksLikeRateLimit`：哪些 429 体被认作限频、哪些硬额度被放行；
 *   - `reclassifyFinish`：把误判 QUOTA 的 finish 改回 RATE_LIMIT、且幂等；
 *   - `reclassifyStream`：对整条流逐 chunk 纠正，非 finish / 真 QUOTA 原样过。
 *
 * 这些与 peer 缺席与否无关——干净 checkout 也能跑（符合 npm test 离线门禁）。
 */
import { looksLikeRateLimit, reclassifyFinish, reclassifyStream, CODE } from "../llm-error-fix.js";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail: String(detail ?? "") });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

// --- 1. looksLikeRateLimit: 误判核心用例 ----------------------------------
{
  // 商汤限频体，带的 "rate limit budget" 措辞不应被 isQuotaExceededError 吃下。
  const rateCases = [
    "HTTP 429: requests rate limit exceeded, please retry after 1s",
    "429 Too Many Requests — out of rate budget, retry later",
    "请求过于频繁，请稍后再试 (429)",
    "rate.limit: request frequency limited, throttle",
    "Error 429: too many requests per minute"
  ];
  for (const msg of rateCases) {
    check(`looksLikeRateLimit true: ${msg.slice(0, 40)}`, looksLikeRateLimit(msg) === true);
  }
}
{
  // 真配额耗尽：必须判定为 false（不纠正，保留 QUOTA 不重试的保守行为）。
  const quotaCases = [
    "quota exceeded: your monthly credits are exhausted",
    "insufficient balance: out of credits",
    "额度已用尽，请升级套餐",
    "balance depleted — no remaining quota",
    "QUOTA: usage limit reached for this billing period"
  ];
  for (const msg of quotaCases) {
    check(`looksLikeRateLimit false (hard quota): ${msg.slice(0, 40)}`, looksLikeRateLimit(msg) === false);
  }
}
{
  // 非 429、无限频信号：不纠正。
  check("looksLikeRateLimit false on 5xx", looksLikeRateLimit("HTTP 500 internal error") === false);
  check("looksLikeRateLimit false on empty", looksLikeRateLimit("") === false);
  check("looksLikeRateLimit false on non-string", looksLikeRateLimit(undefined) === false);
}

// --- 2. reclassifyFinish: 只动误判 QUOTA，幂等于其它 -----------------------
{
  // 误判 QUOTA 的限频体 -> RATE_LIMIT，且 message 保留。
  const chunk = {
    type: "finish",
    reason: { kind: "error", failure: { code: CODE.QUOTA, message: "429 out of rate budget" } }
  };
  const out = reclassifyFinish(chunk);
  check("reclassifyFinish flips misjudged QUOTA -> RATE_LIMIT",
    out !== chunk && out.reason.failure.code === CODE.RATE_LIMIT, JSON.stringify(out?.reason?.failure));
  check("reclassifyFinish keeps original message",
    out.reason.failure.message === "429 out of rate budget");
  check("reclassifyFinish returns a NEW object (no mutation)",
    out !== chunk && chunk.reason.failure.code === CODE.QUOTA);

  // 真 QUOTA（硬额度措辞）原样放行。
  const hard = {
    type: "finish",
    reason: { kind: "error", failure: { code: CODE.QUOTA, message: "额度已用尽" } }
  };
  check("reclassifyFinish leaves hard-quota QUOTA alone",
    reclassifyFinish(hard) === hard);

  // 已是 RATE_LIMIT 原样放行。
  const rate = {
    type: "finish",
    reason: { kind: "error", failure: { code: CODE.RATE_LIMIT, message: "429" } }
  };
  check("reclassifyFinish idempotent on RATE_LIMIT", reclassifyFinish(rate) === rate);

  // 非 finish chunk 原样放行。
  const text = { type: "text-delta", text: "hi" };
  check("reclassifyFinish passes through non-finish chunks", reclassifyFinish(text) === text);

  // aborted / non-error finish 原样放行。
  const aborted = { type: "finish", reason: { kind: "aborted", failure: { code: "ABORTED" } } };
  check("reclassifyFinish leaves aborted finish alone", reclassifyFinish(aborted) === aborted);

  // 非对象 / null 安全。
  check("reclassifyFinish safe on null", reclassifyFinish(null) === null);
}

// --- 3. reclassifyStream: 整条流逐 chunk 纠正 ------------------------------
{
  async function run() {
    async function* source() {
      yield { type: "text-delta", text: "a" };
      yield { type: "finish", reason: { kind: "error", failure: { code: CODE.QUOTA, message: "429 rate limit" } } };
      yield { type: "finish", reason: { kind: "error", failure: { code: CODE.QUOTA, message: "额度已用尽" } } };
    }
    const seen = [];
    for await (const c of reclassifyStream(source())) seen.push(c);
    return seen;
  }
  try {
    const seen = await run();
    check("reclassifyStream keeps non-finish chunk", seen[0] && seen[0].type === "text-delta");
    check("reclassifyStream corrects the rate-limit QUOTA",
      seen[1].reason.failure.code === CODE.RATE_LIMIT, JSON.stringify(seen[1]?.reason?.failure));
    check("reclassifyStream preserves the hard-quota QUOTA",
      seen[2].reason.failure.code === CODE.QUOTA, JSON.stringify(seen[2]?.reason?.failure));
  } catch (error) {
    fail("reclassifyStream", error);
  }
}

console.log(JSON.stringify(results, null, 2));
const failedChecks = results.filter((r) => !r.pass);
if (failedChecks.length > 0) {
  console.error(`\n${failedChecks.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
