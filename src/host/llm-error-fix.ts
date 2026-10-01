/**
 * 429 误判纠正层 —— host 侧对 peer 分类器的安全覆盖。
 *
 * 根因（见 dsh-llm-pi-ai/lib/index.js:1376 与 dsh-llm/lib/index.js:181）：
 *   `classifyPiAiError` 先跑 `isQuotaExceededError`，其命中面极宽
 *  （`out of ... budget`、`balance/credits exhausted`），凡是商汤 429 体里
 *   带上一两个 "budget/credits/limit" 字眼，就被抢判成 `QUOTA`；于是
 *   `llm-retry.ts` 的 `retryableCodes()`（刻意排除 QUOTA）对这类 429 不重试，
 *   面板又把模型按 `exhaustedModelIds` 静默下线，对用户呈现"额度耗尽"。
 *   而纯 `RATE_LIMIT` 分支（`/\b429\b|rate.?limit/`）是**死代码**——
 *   任何带 429 的体若能进 `isQuotaExceededError` 就被上一行吃了。
 *
 * 本模块在 host 侧把"看似限频却被误判为 QUOTA 的 429"纠正回 `RATE_LIMIT`，
 * 让退避重试真正生效；真配额耗尽（明确余额/积分耗尽的硬额度措辞）保留 `QUOTA`。
 *
 * 设计约束（对应 AGENTS.md 红线与并行纪律）：
 *   - 不动 vendor peer：peer 不在此插件 git 内，也不可被改。
 *   - 零 peer 依赖：纯函数 + 稳定协议字符串；peer 缺席（干净 checkout）时
 *     模块仍加载、测试仍跑，不破坏 `npm test` 离线门禁。
 *   - 只重写 `finish` chunk 的 `failure.code`，保留原始 `message` 以便排查，
 *     不触碰任何正常数据流，幂等（已是 RATE_LIMIT / 非 QUOTA 原样放行）。
 *
 * @module dsh-connect-agnes-token-plan/llm-error-fix
 */

/**
 * 与 peer 协议对齐的失败类（稳定字符串，不 import peer 也成立）。
 * `QUOTA` 来自 `@deepseek-ai/dsh-llm` 的 `QUOTA_EXCEEDED_CODE`，`RATE_LIMIT`
 * 来自 `classifyPiAiError` 的返回字面量。
 */
export const CODE = Object.freeze({
  /** 共享 Token Plan 池耗尽（peer 不重试，本层默认也不纠正）。 */
  QUOTA: "QUOTA",
  /** 账户级配额耗尽（peer 基本不产生，本层不纠正，保守）。 */
  ACCOUNT_QUOTA: "ACCOUNT_QUOTA",
  /** 瞬时限频（peer retryPolicy 默认重试，本层把误判体拉回这里）。 */
  RATE_LIMIT: "RATE_LIMIT"
});

/**
 * 一个 429 体是否"更可能是限频而非真配额耗尽"。
 *
 * 判据：消息里出现显式限频信号（429 状态码、rate limit、too many requests、
 * throttl、或中文"请求过于频繁/限流/频率"），且**没有**命中硬额度措辞
 * （balance/credits exhausted、out of credits/budget、"额度 用尽/耗尽/不足"、
 * quota exceeded/exhausted/reached）。
 *
 * 关键区分："out of **rate** budget" / "rate limit budget" 是限频体，不在硬额度
 * 措辞里，所以仍判为限频——这正是本次误判的核心。
 * @param {string} message - 平台错误文本（可能含状态码与 JSON）。
 * @returns {boolean} true 表示应纠正为 RATE_LIMIT。
 */
export function looksLikeRateLimit(message) {
  if (typeof message !== "string" || message.length === 0) return false;
  const m = message.toLowerCase();

  // 显式限频信号：任意一个即够。rpm/tpm 是商汤速率上限（requests/tokens per
  // minute），不是 token 配额（配额耗尽会说 quota/credit/balance/额度）。
  const hasRateSignal =
    /\b429\b/.test(m) ||
    /rate[_\s-]?limit/i.test(m) ||
    /too many requests?/i.test(m) ||
    /requests?\s+(?:per|rate|freq)/i.test(m) ||
    /\b(?:rpm|tpm)\b/.test(m) ||
    /throttl/i.test(m) ||
    /请求过于频繁|限流|频率/.test(m);
  if (!hasRateSignal) return false;

  // 硬额度措辞：命中则相信是配额，不纠正（避免把真耗尽也拉去重试）。
  const hardQuota =
    /\b(?:balance|credits?)\s+(?:exhausted|depleted)\b/i.test(m) ||
    /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(m) ||
    /额度\s*(?:已)?\s*(?:用尽|耗尽|不足)/.test(m) ||
    /quota\s*(?:exceeded|exhausted|reached)/i.test(m);
  return !hardQuota;
}

/**
 * 从错误文本里抽出商汤结构化 `type` 字段（如 `"type":"quota_exceeded_error"`）。
 *
 * peer 把整条错误 JSON 拼进 `failure.message`，所以这里能从文本回捞结构信号，
 * 而不依赖 peer 是否单独透传了 `type`。抓不到返回 null。
 * @param {string} message
 * @returns {string|null}
 */
export function extractStructuredType(message) {
  if (typeof message !== "string" || message.length === 0) return null;
  const match = /"type"\s*:\s*"([^"]+)"/i.exec(message);
  return match ? match[1] : null;
}

/**
 * 一个被 peer 判为 QUOTA 的失败，是否其实是限频、应纠正为 RATE_LIMIT。
 *
 * 这是修正 v1（纯文本启发）漏判的核心：`{"message":"rpm exhausted",
 * "type":"quota_exceeded_error","code":"8"}` 这种体——商汤把**请求速率上限**
 * 复用 `quota_exceeded_error` 这个名字，纯文本里没有 "rate limit" 字样，v1 的
 * `looksLikeRateLimit` 既没命中限频信号也没命中硬额度，于是留在 QUOTA、不重试、
 * 直接失败。本函数改读结构化 `type`：
 *
 *   - `type` 含 `rate_limit` → 本就是限频（peer 多数已判 RATE_LIMIT，这里是防御）。
 *   - `type` 含 `quota` 但仍带 rpm/tpm/rate-limit/per-minute/限流/频率 字样 →
 *     是"被错命名为 quota 的速率上限"，纠正为 RATE_LIMIT。
 *   - `type` 含 `quota` 且无任何速率字样（token/credit/balance 真耗尽）→ 保留 QUOTA。
 *   - 无结构化 `type` → 退回 v1 的纯文本启发 `looksLikeRateLimit`。
 *
 * 不纠正真配额耗尽：那是共享 Token Plan 池的硬耗尽，重试只会延长冷却窗口
 * （ROADMAP §1 纪律），所以宁可快失败。
 * @param {{code?: string, message?: string}} failure
 * @returns {boolean} true 表示应纠正为 RATE_LIMIT。
 */
export function shouldReclassifyQuotaToRate(failure) {
  if (!failure || failure.code !== CODE.QUOTA) return false;
  const message = typeof failure.message === "string" ? failure.message : "";
  const type = extractStructuredType(message);

  if (type) {
    const t = type.toLowerCase();
    if (/rate[_\s-]?limit/.test(t)) return true; // 防御：已是限频类型
    if (/quota/.test(t)) {
      // quota_exceeded_error 但带速率上限字样 → 错命名，纠正。
      const rateCapWords = /\brpm\b|\btpm\b|rate[_\s-]?limit|per[\s_-]?(?:min|minute|sec|second)|too many|限流|频率|请求过于频繁/i;
      return rateCapWords.test(message);
    }
    return false; // 其它非 quota 类型，保守不纠正
  }

  // 无结构化 type：退回纯文本启发。
  return looksLikeRateLimit(message);
}

/**
 * 把单个流 chunk 里的失败码在误判时纠正。
 *
 * 非 finish、非 error 终止、非 QUOTA，或已判为限频的，一律原样返回（新对象
 * 仅在确有纠正时创建，保持调用方对引用相等的预期）。
 * @param {object} chunk - harness 流协议 chunk。
 * @returns {object} 原 chunk 或 code 被纠正后的新 chunk。
 */
export function reclassifyFinish(chunk) {
  if (chunk === null || typeof chunk !== "object") return chunk;
  if (chunk.type !== "finish") return chunk;
  const reason = chunk.reason;
  if (reason === null || typeof reason !== "object" || reason.kind !== "error" || !reason.failure) {
    return chunk;
  }
  const failure = reason.failure;
  if (failure.code !== CODE.QUOTA) return chunk;
  if (!shouldReclassifyQuotaToRate(failure)) return chunk;
  // 纠正为 RATE_LIMIT：保留 message，仅改 code 以驱动 peer 的退避重试。
  return {
    ...chunk,
    reason: {
      ...reason,
      failure: { ...failure, code: CODE.RATE_LIMIT }
    }
  };
}

/**
 * 包裹一个 adapter 的 async iterator 流：对每个 finish chunk 做重判。
 * @param {AsyncIterableIterator<object>} source - 内层 adapter 的流。
 * @returns {AsyncGenerator<object>} 纠正后的流。
 */
export async function* reclassifyStream(source) {
  for await (const chunk of source) {
    yield reclassifyFinish(chunk);
  }
}
