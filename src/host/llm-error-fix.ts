/**
 * 429 误判纠正层 —— host 侧对 peer 分类器的安全覆盖。
 *
 * 根因（见 dsh-llm-pi-ai/lib/index.js:1376 与 dsh-llm/lib/index.js:181）：
 *   `classifyPiAiError` 先跑 `isQuotaExceededError`，其命中面极宽
 *  （`out of ... budget`、`balance/credits exhausted`），凡是 429 体里
 *   带上一两个 "budget/credits/limit" 字眼，就被抢判成 `QUOTA`；于是
 *   `llm-retry.ts` 的 `retryableCodes()`（刻意排除 QUOTA）对这类 429 不重试，
 *   用户侧还可能被呈现成"额度耗尽"。（当年商汤线的面板确实会按借尽模型集静默下线模型；
 *   迁到 Agnes 后那条推导已随 per-model 配额一起删除，见 `test/retry.test.mjs` 的说明——
 *   这里保留的是**误判本身**的根因，不是那条已不存在的下线路径。）
 *   而纯 `RATE_LIMIT` 分支（`/\b429\b|rate.?limit/`）是**死代码**——
 *   任何带 429 的体若能进 `isQuotaExceededError` 就被上一行吃了。
 *
 * 这个误判最初在**商汤线**上观测到，但 Agnes 的官方错误码表已经把它钉死
 * （docs/AGNES-API.md §7.3.1，抓存官方 FAQ）：**Agnes 没有 `quota_exceeded_error`
 * 这个错误码名**（那是商汤时代的东西）；**429 = RPM 限频，应退避重试**（官方明说
 * 「等待 1 分钟后重试」）；**402 = Token Plan 配额不足，不应重试**。所以本模块把
 * "被 peer 误判为 QUOTA 的限频 429" 纠正回 `RATE_LIMIT`，方向与官方一致。
 * 同时官方 FAQ 也明说 **429 可能表示「超过订阅配额」**，所以 `hardQuota` 保留
 * 「订阅/套餐配额耗尽」判据（`subscription quota` / `Token Plan quota` / `订阅配额` /
 * `Token Plan 配额`），命中即保留 QUOTA——退避重试对一个配额耗尽没有意义。
 *
 * 判据刻意写成**方言无关**（状态码、rate limit、too many requests、限流/频率 +
 * rpm/tpm），不依赖商汤码值；Agnes 是否透传结构化 `type` 字段仍**待实测**，
 * 缺失时结构化分支不命中，自然退回纯文本启发，行为与没有结构化信号时一致。
 *
 * 本模块在 host 侧把"看似限频却被误判为 QUOTA 的 429"纠正回 `RATE_LIMIT`，
 * 让退避重试真正生效；真配额耗尽（余额/积分/订阅配额耗尽的硬额度措辞）保留 `QUOTA`。
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
 * 硬额度措辞：命中即相信是配额，不纠正（避免把真耗尽也拉去重试）。
 *
 * 注意这里**刻意不含** `quota exceeded / exhausted / reached` 这个泛化措辞。
 * Agnes 官方 FAQ 明说 429 = RPM 限频（「等待 1 分钟后重试」），而官方给出的 429
 * 限频体文本恰恰是 "quota exceeded, please wait 1 minute"——把这条也算硬额度，
 * 本层就在它**最主要**的触发体上不生效（2026-10-18 修复前确实如此：`hardQuota`
 * 命中该体 → `looksLikeRateLimit` 返回 false → 429 限频被留在 QUOTA 不重试）。
 * 429 里真正要保留 QUOTA 的只有：**订阅/套餐配额**，以及**明确的余额/积分耗尽**
 * 措辞（balance/credits exhausted、out of credits/budget、no credits left、
 * "额度 用尽/耗尽/不足"）。
 * @param {string} message - 平台错误文本（小写化由调用方完成）。
 * @returns {boolean} true 表示文本里出现硬额度措辞。
 */
function hasHardQuotaWording(message: string): boolean {
  return (
    /\b(?:balance|credits?)\s+(?:exhausted|depleted)\b/i.test(message) ||
    /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(message) ||
    /\bno\s+(?:more\s+)?(?:credits?|balance)\b/i.test(message) ||
    /额度\s*(?:已)?\s*(?:用尽|耗尽|不足)/.test(message) ||
    // Agnes 官方 FAQ 明说 429 也可能是「超过订阅配额」（Token Plan 配额用尽）：
    // 命中订阅/套餐配额措辞必须保留 QUOTA，否则会被误判成限频去退避重试
    // （docs/AGNES-API.md §7.3.1 结论 2 指出的演进点）。
    /(?:subscription|token[\s_-]?plan)[\s_-]*(?:quota|credit)|订阅配额|套餐配额|Token[\s_-]?Plan\s*(?:配额|额度)/i.test(message)
  );
}

/**
 * 一个 429 体是否"更可能是限频而非真配额耗尽"。
 *
 * 判据：消息里出现显式限频信号（429 状态码、rate limit、too many requests、
 * throttl、或中文"请求过于频繁/限流/频率"），且**没有**命中硬额度措辞
 * （balance/credits exhausted、out of credits/budget、no credits left、
 * "额度 用尽/耗尽/不足"、订阅/套餐配额——见 `hasHardQuotaWording`）。
 *
 * 关键区分："out of **rate** budget" / "rate limit budget" 是限频体，不在硬额度
 * 措辞里，所以仍判为限频——这正是本次误判的核心。反之，泛化的 "quota exceeded"
 * **也不在**硬额度措辞里：Agnes 的 429 限频体就是这句话（见 `hasHardQuotaWording`
 * 头注），把它算硬额度会漏掉最主要触发体。
 * @param {string} message - 平台错误文本（可能含状态码与 JSON）。
 * @returns {boolean} true 表示应纠正为 RATE_LIMIT。
 */
export function looksLikeRateLimit(message: string) {
  if (typeof message !== "string" || message.length === 0) return false;
  const m = message.toLowerCase();

  // 显式限频信号：任意一个即够。rpm/tpm 是速率上限（requests/tokens per
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

  return !hasHardQuotaWording(m);
}

/**
 * 从错误文本里抽出平台结构化 `type` 字段（形如 `"type":"quota_exceeded_error"`）。
 *
 * 该 `type` / `code` 词汇最初在**商汤线**观测到并记入夹具；判据本身读的是
 * `type` **字段名**与消息词，不依赖特定平台码值（`code:"8"`/`429003` 只出现在
 * 注释与测试夹具里，未进判定逻辑）。Agnes 网关是否透传 `type` 待实测，缺失时
 * 调用方退回 `looksLikeRateLimit` 的纯文本启发。
 *
 * peer 把整条错误 JSON 拼进 `failure.message`，所以这里能从文本回捞结构信号，
 * 而不依赖 peer 是否单独透传了 `type`。抓不到返回 null。
 * @param {string} message
 * @returns {string|null}
 */
export function extractStructuredType(message: string) {
  if (typeof message !== "string" || message.length === 0) return null;
  const match = /"type"\s*:\s*"([^"]+)"/i.exec(message);
  return match ? match[1] : null;
}

/**
 * 一个被 peer 判为 QUOTA 的失败，是否其实是限频、应纠正为 RATE_LIMIT。
 *
 * 这是修正 v1（纯文本启发）漏判的核心：`{"message":"rpm exhausted",
 * "type":"quota_exceeded_error","code":"8"}` 这种体——有的平台把**请求速率上限**
 * 复用 `quota_exceeded_error` 这个名字，纯文本里没有 "rate limit" 字样，v1 的
 * `looksLikeRateLimit` 既没命中限频信号也没命中硬额度，于是留在 QUOTA、不重试、
 * 直接失败。本函数改读结构化 `type`：
 *
 *   - `type` 含 `rate_limit` → 本就是限频（peer 多数已判 RATE_LIMIT，这里是防御）。
 *   - `type` 含 `quota` 但仍带 rpm/tpm/rate-limit/per-minute/限流/频率 字样 →
 *     是"被错命名为 quota 的速率上限"，纠正为 RATE_LIMIT。
 *   - `type` 含 `quota` 且无任何速率字样（token/credit/balance 真耗尽）→ 保留 QUOTA；
 *     若文本同时命中 `hasHardQuotaWording`（余额/积分/订阅套餐耗尽），即使带了
 *     retry/wait 字样也保留 QUOTA——硬额度判据优先于速率字样。
 *   - 无结构化 `type` → 退回 v1 的纯文本启发 `looksLikeRateLimit`。
 *
 * 不纠正真配额耗尽：那是共享 Token Plan 池的硬耗尽，重试只会延长冷却窗口
 * （ROADMAP §1 纪律），所以宁可快失败。
 * @param {{code?: string, message?: string}} failure
 * @returns {boolean} true 表示应纠正为 RATE_LIMIT。
 */
export function shouldReclassifyQuotaToRate(failure: { code?: string; message?: string }) {
  if (!failure || failure.code !== CODE.QUOTA) return false;
  const message = typeof failure.message === "string" ? failure.message : "";
  const type = extractStructuredType(message);

  if (type) {
    const t = type.toLowerCase();
    if (/rate[_\s-]?limit/.test(t)) return true; // 防御：已是限频类型
    if (/quota/.test(t)) {
      // 真配额耗尽不纠正：余额/积分/订阅套餐措辞命中时，即使句子同时带了
      // retry/wait 字样也保留 QUOTA——退避重试对一个余额耗尽没有意义，所以
      // 硬额度判据先于速率上限字样。
      if (hasHardQuotaWording(message)) return false;
      // quota_exceeded_error 但带速率上限字样 → 错命名，纠正。Agnes 官方给出的
      // 429 限频体是 "quota exceeded, please wait 1 minute"，所以 wait/retry/
      // "稍后重试" 也算速率信号，否则这类体在结构化分支同样漏判。
      const rateCapWords = /\brpm\b|\btpm\b|rate[_\s-]?limit|per[\s_-]?(?:min|minute|sec|second)|too many|\bwait\b|\bretry|限流|频率|请求过于频繁|稍后|重试|等待|秒|分钟/i;
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
export function reclassifyFinish(chunk: any) {
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
 *
 * `onFinish` 是**可选观察者**，只对 `finish` chunk 触发（数据 chunk 不触发，
 * 一次正常回答可能上千个 token，逐 chunk 回调既无意义也不该发生）。它收到
 * 的是**纠正后**的 chunk，所以既能看到"peer 原本就判为 RATE_LIMIT"的命中，
 * 也能看到"被本层从 QUOTA 纠正回 RATE_LIMIT"的命中——两者的共同含义是
 * "这一请求撞上了限频"，正是限流记录要数的东西。观察者不改变任何数据流，
 * 不 import 状态存储，只是把每个失败结论递出去；记不记、记在哪由调用方决定，
 * 本模块保持纯函数。
 *
 * `onUsage` 是**第二个可选观察者**，只对 `usage` chunk 触发。它与 `onFinish`
 * 是**两条独立的通道**，不是同一 chunk 的两种看法：pi-ai 的适配器在每次
 * `finish` **之前**单独下发一个 `{type:"usage", usage:{...}}` chunk（成功路径
 * `done` 与失败路径 `error` 都发，见 dsh-llm-pi-ai/lib/index.js 的 mapUsage），
 * 而 `onFinish` 只在 `finish` 上触发，永远看不到那个 usage chunk。所以要把
 * 每次请求的 token 用量记下来，必须另开这条 `usage`-chunk 通道——它收到的
 * 是**原样**的 usage chunk（重判层不碰 usage，只碰 finish 的 failure.code）。
 * 与 `onFinish` 同样：观察者不改变数据流，不 import 存储，记不记由调用方定。
 * @param {AsyncIterableIterator<object>} source - 内层 adapter 的流。
 * @param {(chunk: object) => void} [onFinish] - 每个 `finish` chunk 的观察回调。
 * @param {(chunk: object) => void} [onUsage] - 每个 `usage` chunk 的观察回调。
 * @returns {AsyncGenerator<object>} 纠正后的流。
 */
export async function* reclassifyStream(
  source: AsyncIterableIterator<any>,
  onFinish?: (chunk: any) => void,
  onUsage?: (chunk: any) => void
) {
  for await (const chunk of source) {
    if (onUsage !== undefined && chunk !== null && typeof chunk === "object" && chunk.type === "usage") {
      onUsage(chunk);
    }
    const out = reclassifyFinish(chunk);
    if (onFinish !== undefined && out !== null && typeof out === "object" && out.type === "finish") {
      onFinish(out);
    }
    yield out;
  }
}
