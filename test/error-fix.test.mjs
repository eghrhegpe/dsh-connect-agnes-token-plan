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
import { looksLikeRateLimit, extractStructuredType, shouldReclassifyQuotaToRate, reclassifyFinish, reclassifyStream, CODE } from "../src/host/llm-error-fix.ts";

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

// --- 4. 商汤线格式（方言样本）：quota_exceeded_error 误命名速率上限 ----------
// 线上实际打出的两条体（见会话日志，商汤线观测）：code:8 是"rpm exhausted"——
// 请求速率上限，却被复用 quota_exceeded_error 这个名字；code:429003 是
// rate_limit_error，peer 已判 RATE_LIMIT。v1 纯文本启发漏判了 code:8，本层靠
// 结构化 type 纠正。这些是**方言样本**——Agnes 网关是否透传 `type` 字段待实测。
{
  const bodies = [
    // 请求速率上限，错命名为 quota_exceeded_error：必须纠正为 RATE_LIMIT。
    { code: CODE.QUOTA, message: '429: {"message":"rpm exhausted","type":"quota_exceeded_error","code":"8"}' },
    // 仅内层 message 带 rpm（无完整 JSON）：纯文本启发也要接住。
    { code: CODE.QUOTA, message: "rpm exhausted" },
    // tpm/rpm 速率上限的另一种措辞。
    { code: CODE.QUOTA, message: '{"message":"inference exceeds tpm/rpm limit","type":"quota_exceeded_error","code":"8"}' }
  ];
  for (const failure of bodies) {
    check(`shouldReclassifyQuotaToRate true for ${failure.message.slice(0, 46)}`,
      shouldReclassifyQuotaToRate(failure) === true);
  }

  // 已是 rate_limit_error 类型（peer 多数已判 RATE_LIMIT，这里防御性确认）。
  const alreadyRate = { code: CODE.QUOTA, message: '429: {"message":"inference exceeds tpm/rpm limit","type":"rate_limit_error","code":"429003"}' };
  check("extractStructuredType pulls rate_limit_error", extractStructuredType(alreadyRate.message) === "rate_limit_error");
  check("shouldReclassifyQuotaToRate true for rate_limit_error type", shouldReclassifyQuotaToRate(alreadyRate) === true);

  // 真配额耗尽（token/credit/balance），即使 type 是 quota_exceeded_error 也保留 QUOTA。
  const realQuota = [
    { code: CODE.QUOTA, message: '{"message":"token quota exceeded","type":"quota_exceeded_error","code":"8"}' },
    { code: CODE.QUOTA, message: '{"message":"月额度已用尽","type":"quota_exceeded_error","code":"8"}' }
  ];
  for (const failure of realQuota) {
    check(`shouldReclassifyQuotaToRate false (true quota): ${failure.message.slice(0, 40)}`,
      shouldReclassifyQuotaToRate(failure) === false);
  }

  // Agnes 平台无关路径：网关不保证透传结构化 `type`。这类体必须仍被纯文本
  // 启发接住——否则 Agnes 上「被错命名为 quota 的限频」会退回 v1 的漏判，
  // 而那不是 bug，是我们唯一没实测过的一面。
  const agnesNoType = [
    { code: CODE.QUOTA, message: "HTTP 429: requests rate limit exceeded, please retry after 1s" },
    { code: CODE.QUOTA, message: "429 请求过于频繁，请稍后再试" },
    { code: CODE.QUOTA, message: '429: {"message":"inference exceeds tpm/rpm limit"}' }
  ];
  for (const failure of agnesNoType) {
    check(`Agnes no-type fallback → RATE_LIMIT: ${failure.message.slice(0, 40)}`,
      shouldReclassifyQuotaToRate(failure) === true);
  }

  // Agnes 官方 FAQ 明说 429 也可能是「超过订阅配额」（docs/AGNES-API.md §7.3.1）。
  // 命中订阅/套餐配额措辞必须保留 QUOTA——退避重试对一个配额耗尽没有意义。
  const agnesSubscriptionQuota = [
    { code: CODE.QUOTA, message: '429: {"message":"subscription quota exceeded, please upgrade your Token Plan"}' },
    { code: CODE.QUOTA, message: "429 Token Plan quota exhausted, top up or upgrade" },
    { code: CODE.QUOTA, message: "429 订阅配额已用尽，请升级套餐" }
  ];
  for (const failure of agnesSubscriptionQuota) {
    check(`Agnes subscription quota stays QUOTA: ${failure.message.slice(0, 40)}`,
      shouldReclassifyQuotaToRate(failure) === false);
  }

  // 端到端：整条流里 code:8/rpm 的 finish 被纠正为 RATE_LIMIT。
  async function* src() {
    yield { type: "finish", reason: { kind: "error", failure: { code: CODE.QUOTA, message: '429: {"message":"rpm exhausted","type":"quota_exceeded_error","code":"8"}' } } };
  }
  const seen = [];
  for await (const c of reclassifyStream(src())) seen.push(c);
  check("stream corrects code:8 rpm-exhausted to RATE_LIMIT",
    seen[0]?.reason?.failure?.code === CODE.RATE_LIMIT, JSON.stringify(seen[0]?.reason?.failure));
}

// --- 5. 退出证的离线半边：删除面 + 删除条件 ------------------------------
// 这层是对**不可改的 peer** 打的补丁，所以它是有到期日的债。到期日分两级，
// 缺任何一级它都会变成永久债（docs/IMPROVEMENTS.md §3.3④）：
//
//   - 退化闹钟（peer 门控）：`test/peer-contract.test.mjs` §E 执行 peer 自己的
//     `classifyPiAiError`，问"peer 会不会自己判对"。它只在真实 peer 可达时跑，
//     且**不是删除信号**——peer 范围仍跨 bug 版，本机修好不等于用户的修好。
//   - 删除闹钟（本段，永远跑）：真正的删除条件是 **peer 下界收紧到修后版本**，
//     那时老 Host 不再被支持，这层兜底才失去存在理由。下界一动这里就红。
//
// 这里钉的是第二级的两件事：删除面（挂钩点名单）与删除条件（下界）。
{
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");

  // (a) 删除面：挂钩点必须始终是这两处，好让删除清单不会漏第三个。
  const hostDir = join(import.meta.dirname, "..", "src", "host");
  const hooked = readdirSync(hostDir)
    .filter((f) => f.endsWith(".ts") && f !== "llm-error-fix.ts")
    .filter((f) => /from "\.\/llm-error-fix\.ts"/.test(readFileSync(join(hostDir, f), "utf8")))
    .sort();
  check(
    "纠正层的挂钩点恰为 llm-adapter 与 agnescode-llm-adapter 两处",
    hooked.length === 2 &&
      hooked[0] === "agnescode-llm-adapter.ts" &&
      hooked[1] === "llm-adapter.ts",
    `实到 [${hooked.join(", ")}]。若新增了挂钩点，同步更新 test/peer-contract.test.mjs §E 的删除清单`
  );

  // (b) 删除条件：只要下界仍是 0.1.5，本层就仍是"老 Host + bug 版 peer"的承重
  // 兜底，不得删。下界一旦抬高（§3.3③ 收紧到修后版本），这里转红 → 整层删除。
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")
  );
  const PEER_LLMS = ["@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-llm-pi-ai"];
  const ranges = PEER_LLMS.map((name) => pkg.peerDependencies?.[name] ?? "");
  const floors = ranges.map((r) => /^>=([0-9]+\.[0-9]+\.[0-9]+)/.exec(r)?.[1] ?? null);
  check(
    "peer 下界仍为 0.1.5 —— 本层仍是老 Host 的承重兜底，不得删（下界抬高 = 删除闹钟）",
    floors.every((f) => f === "0.1.5"),
    floors.every((f) => f === "0.1.5")
      ? ""
      : [
          `实到下界 ${PEER_LLMS.map((n, i) => `${n}=${ranges[i]}`).join(" / ")}。`,
          "下界已抬高：老 Host 不再被支持，本层失去存在理由 —— 现在可以整层删除：",
          "  1. src/host/llm-error-fix.ts",
          "  2. 挂钩点两处：src/host/llm-adapter.ts 与 src/host/agnescode-llm-adapter.ts",
          "  3. 本套件与 test/peer-contract.test.mjs 的 A/B/C/E 段（随之作废）",
          "  4. docs/IMPROVEMENTS.md §3.3、§5 表格与 docs/AGNES-API.md §7.3.1 改为「上游已修复」"
        ].join("\n")
  );
}

console.log(JSON.stringify(results, null, 2));
const failedChecks = results.filter((r) => !r.pass);
if (failedChecks.length > 0) {
  console.error(`\n${failedChecks.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
