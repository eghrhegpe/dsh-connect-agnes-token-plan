import { resolveImageAttachmentAccess } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";

//#region src/host/llm-retry.ts
/**
* The directly-registered Agnes provider's request-retry policy — the
* peer-FREE half of the 429 self-healing work.
*
* Why a separate, peer-free module: the policy is handed to the Host's
* `resolveRetryPolicy` (a peer import) inside `llm-adapter.ts`, but the
* *decision* — which failure classes this shared-pool provider should retry,
* and how gently — is pure and must stay unit-testable on a clean checkout
* where the peer is not resolvable. Keeping the config here means
* `test/retry.test.mjs` can pin its shape without importing `@deepseek-ai/dsh-llm`.
*
* The peer already classifies a Agnes 429 into two codes (verified in the
* 429 spike, `dsh-llm-pi-ai/lib/indexts` `classifyPiAiError`):
*
*   - `QUOTA` / `ACCOUNT_QUOTA` — the Token Plan pool is depleted. Retrying
*     cannot refill it, and because the pool is SHARED across every model on
*     this key, hammering it only extends the cool-down window (the same
*     lesson `st-rotator` bakes into its AIMD limiter). So we deliberately do
*     NOT retry quota exhaustion — fast-fail and let the panel say why.
*   - `RATE_LIMIT` — a transient throttle that clears on its own. The peer
*     retries this by default, and we keep doing so, with a backoff biased
*     longer than default so an immediate re-hit against the one shared pool
*     is less likely. Agnes's daytime rate ceiling (rpm/tpm) is aggressive
*     (see `llm-error-fix.ts`: a body named `quota_exceeded_error` can actually
*     be a per-minute rate cap — observed on the SenseNova line, still
*     unverified on Agnes's gateway), so we ride it out with more attempts and
*     a gentler initial step than the peer default.
*
* @module dsh-connect-agnes-token-plan/llm-retry
*/
/**
* The failure-class codes this provider reasons about, in peer-canonical
* spelling.
*
* The strings mirror the `@deepseek-ai/dsh-llm` peer's error-code constants
* (`QUOTA_EXCEEDED_CODE = "QUOTA"`, `ACCOUNT_QUOTA_EXCEEDED_CODE =
* "ACCOUNT_QUOTA"`, `EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE"`). They are stable
* protocol codes, not implementation details, so pinning them here is what the
* qoder route does too; `llm-adapter.ts` still imports the live constants from
* the peer and passes them through `resolveRetryPolicy`, so a peer rename would
* surface at the adapter, not silently drift here.
*/
const QUOTA_CODES = Object.freeze({
	/** Depleted Token Plan pool (per-pool quota). Not retried. */
	quota: "QUOTA",
	/** Depleted account-level quota. Not retried. */
	accountQuota: "ACCOUNT_QUOTA",
	/** Empty/truncated response. Retried. */
	emptyResponse: "EMPTY_RESPONSE",
	/** Transient throttle (429 rate). Retried with backoff. */
	rateLimit: "RATE_LIMIT",
	/** Upstream 5xx. Retried. */
	server: "SERVER",
	/** Request deadline exceeded. Retried. */
	timeout: "TIMEOUT",
	/** Connection-level failure. Retried. */
	transport: "TRANSPORT"
});
/**
* The failure classes this provider retries, in peer-canonical order.
*
* Excludes both quota codes on purpose: a depleted pool cannot be retried into
* health, and retrying it against a shared credit pool only prolongs the
* cool-down. `RATE_LIMIT` stays — transient throttles self-clear.
* @returns {string[]} the retryable code list (no duplicates, non-empty).
*/
function retryableCodes() {
	return [
		QUOTA_CODES.emptyResponse,
		QUOTA_CODES.rateLimit,
		QUOTA_CODES.server,
		QUOTA_CODES.timeout,
		QUOTA_CODES.transport
	];
}
/**
* Build the provider's retry-policy config.
*
* The shape is exactly what `@deepseek-ai/dsh-llm`'s `resolveRetryPolicy`
* accepts (`mode: "normal"` → `{ mode, maxRetries, retryableCodes, backoff }`).
* We pin it explicitly rather than passing `undefined` so a future change to
* the peer's default policy cannot silently alter this provider's behaviour.
*
* Tuned for Agnes's daytime rate ceiling (rpm/tpm), which the peer mislabels
* as `QUOTA` — `llm-error-fix.ts` pulls those back to `RATE_LIMIT` so they
* reach this policy. The numbers: more attempts (8) and a gentler, longer
* backoff than the peer default (initial 1.5s → cap 20s, jitter 0.25) so a
* single shared credit pool is not stampeded while the rate window refills.
* Still bounded: a genuine outage fails after ~90s of backed-off retries rather
* than spinning forever. QUOTA stays excluded (a depleted pool cannot be retried
* into health; retrying it only prolongs the cool-down — ROADMAP §1).
* @returns {{mode: "normal", maxRetries: number, retryableCodes: string[], backoff: {initialDelayMs: number, maxDelayMs: number, jitterRatio: number}}}
*/
function buildRetryPolicyConfig() {
	return {
		mode: "normal",
		maxRetries: 8,
		retryableCodes: retryableCodes(),
		backoff: {
			initialDelayMs: 1500,
			maxDelayMs: 2e4,
			jitterRatio: .25
		}
	};
}

//#endregion
//#region src/host/llm-error-fix.ts
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
const CODE = Object.freeze({
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
function looksLikeRateLimit(message) {
	if (typeof message !== "string" || message.length === 0) return false;
	const m = message.toLowerCase();
	if (!(/\b429\b/.test(m) || /rate[_\s-]?limit/i.test(m) || /too many requests?/i.test(m) || /requests?\s+(?:per|rate|freq)/i.test(m) || /\b(?:rpm|tpm)\b/.test(m) || /throttl/i.test(m) || /请求过于频繁|限流|频率/.test(m))) return false;
	return !(/\b(?:balance|credits?)\s+(?:exhausted|depleted)\b/i.test(m) || /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(m) || /额度\s*(?:已)?\s*(?:用尽|耗尽|不足)/.test(m) || /quota\s*(?:exceeded|exhausted|reached)/i.test(m) || /(?:subscription|token[\s_-]?plan)[\s_-]*(?:quota|credit)|订阅配额|套餐配额|Token[\s_-]?Plan\s*(?:配额|额度)/i.test(m));
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
function extractStructuredType(message) {
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
*   - `type` 含 `quota` 且无任何速率字样（token/credit/balance 真耗尽）→ 保留 QUOTA。
*   - 无结构化 `type` → 退回 v1 的纯文本启发 `looksLikeRateLimit`。
*
* 不纠正真配额耗尽：那是共享 Token Plan 池的硬耗尽，重试只会延长冷却窗口
* （ROADMAP §1 纪律），所以宁可快失败。
* @param {{code?: string, message?: string}} failure
* @returns {boolean} true 表示应纠正为 RATE_LIMIT。
*/
function shouldReclassifyQuotaToRate(failure) {
	if (!failure || failure.code !== CODE.QUOTA) return false;
	const message = typeof failure.message === "string" ? failure.message : "";
	const type = extractStructuredType(message);
	if (type) {
		const t = type.toLowerCase();
		if (/rate[_\s-]?limit/.test(t)) return true;
		if (/quota/.test(t)) return /\brpm\b|\btpm\b|rate[_\s-]?limit|per[\s_-]?(?:min|minute|sec|second)|too many|限流|频率|请求过于频繁/i.test(message);
		return false;
	}
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
function reclassifyFinish(chunk) {
	if (chunk === null || typeof chunk !== "object") return chunk;
	if (chunk.type !== "finish") return chunk;
	const reason = chunk.reason;
	if (reason === null || typeof reason !== "object" || reason.kind !== "error" || !reason.failure) return chunk;
	const failure = reason.failure;
	if (failure.code !== CODE.QUOTA) return chunk;
	if (!shouldReclassifyQuotaToRate(failure)) return chunk;
	return {
		...chunk,
		reason: {
			...reason,
			failure: {
				...failure,
				code: CODE.RATE_LIMIT
			}
		}
	};
}
/**
* 包裹一个 adapter 的 async iterator 流：对每个 finish chunk 做重判。
* @param {AsyncIterableIterator<object>} source - 内层 adapter 的流。
* @returns {AsyncGenerator<object>} 纠正后的流。
*/
async function* reclassifyStream(source) {
	for await (const chunk of source) yield reclassifyFinish(chunk);
}

//#endregion
//#region src/host/pi-ai-adapter-core.ts
/**
* The shared ASSEMBLY core of the two pi-ai adapter shells — the mechanism the
* Token Plan route (`llm-adapter.ts`) and the AgnesCode route
* (`agnescode-llm-adapter.ts`) both need, kept in ONE place.
*
* Why this file exists: the two shells are deliberately SEPARATE (different
* provider ids, model builders, credential resolvers, and one of them pins a
* reasoning default the other must not), but their assembly mechanism had been
* copied verbatim — the inert auth plane, the image budgets, the image hooks,
* and above all the 429-misclassification Proxy. That last one is the reason
* this is not merely tidiness: the Proxy is a patch against a peer
* (`docs/IMPROVEMENTS.md` §3.3) whose deletion is governed by an expiry date,
* and two hand-maintained copies of a patch is how one of them silently keeps
* the bug after the other is fixed. Mechanism shared, configuration separate —
* the same split `publish-core.ts` already applies to the two publishers.
*
* This is a static-peer module by design, exactly like the shells that import
* it: it is reached only through a dynamic `import()` from the lifecycle, so a
* Host without the LLM peers loses the provider module and nothing else
* (ARCHITECTURE.md §5, invariant 1).
*
* @module dsh-connect-agnes-token-plan/pi-ai-adapter-core
*/
/** Idle ceiling while one stream read is outstanding (dsh-llm-pi-ai default). */
const STREAM_IDLE_TIMEOUT_MS = 3e5;
/**
* Image budgets at the `dsh-llm-pi-ai` defaults — pinned identically for both
* Agnes upstreams so a request image is resized the same way on either route.
* They bound requests to models whose descriptor declares image input;
* text-only models never see images.
*/
const REQUEST_IMAGE_BUDGETS = Object.freeze({
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
});
/**
* Inert pi-ai auth plane.
*
* Both routes authenticate through `resolveApiKey` (a credential read per
* request from the plugin's own store), so pi-ai's credential lifecycle must
* never manufacture one: every ambient question answers "nothing stored,
* nothing set". `modify` is deliberately a no-op rather than a throw — pi-ai
* may call it as an optional "persist the latest credential" hook during a
* normal request, and an exception there would 500 a conversation that is
* otherwise working.
*/
const INERT_AUTH = Object.freeze({
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
});
/**
* The `fs` service face the image hook reads — a single host-path mapper, and
* only that. Resolved lazily through `get("fs")` because the service may be
* registered after this adapter is built.
* @typedef {object} FsService
* @property {(hostPath: string) => unknown} [processPathFromHostPath]
*/
/**
* Assemble one `PiAiAdapter` behind the shared mechanism.
*
* A fresh instance per rebuild is deliberate: `PiAiAdapter` memoizes the
* profiles snapshot internally, so the caller REPLACES the registered adapter
* when the credential or catalogue changes and emits `llm/adapters-updated`.
*
* Both IMAGE hooks are wired, not optional extras: `streamWithSnapshot` throws
* UNSUPPORTED_CONTENT whenever a message carries an image and
* `resolveAttachments()` yields undefined, and wiring the store without
* `resolveImageAccess` leaves the image unlocatable — that pair shipped broken
* once, which is why `test/agnescode.test.mjs` fences it.
*
* @param {object} options - wiring.
* @param {Map<string, object>} options.profiles - the single provider profile
*   map this adapter serves.
* @param {() => Promise<string>} options.resolveApiKey - resolves the live
*   credential per request.
* @param {(service: string) => any} [options.get] - service resolver for the
*   image hooks (`attachments`, `fs`); resolved lazily per request.
* @returns {object} the adapter, with the 429 correction layer applied.
*/
function createWrappedPiAiAdapter({ profiles, resolveApiKey, get }) {
	const inner = new PiAiAdapter({
		profiles: () => profiles,
		auth: INERT_AUTH,
		resolveApiKey,
		resolveAttachments: () => get?.("attachments"),
		resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, (hostPath) => (get?.("fs"))?.processPathFromHostPath?.(hostPath), ref)
	});
	return new Proxy(inner, { get(target, prop, receiver) {
		const value = Reflect.get(target, prop, receiver);
		if (prop === "stream") return (options) => reclassifyStream(target.stream(options));
		if (typeof value === "function" && prop === "prepareCall") return (...args) => {
			const prepared = value.apply(target, args);
			if (prepared && typeof prepared.then === "function") return prepared.then((p) => p && typeof p.stream === "function" ? {
				...p,
				stream: (o) => reclassifyStream(p.stream(o))
			} : p);
			return prepared && typeof prepared.stream === "function" ? {
				...prepared,
				stream: (o) => reclassifyStream(prepared.stream(o))
			} : prepared;
		};
		return value;
	} });
}

//#endregion
export { buildRetryPolicyConfig as i, STREAM_IDLE_TIMEOUT_MS as n, createWrappedPiAiAdapter as r, REQUEST_IMAGE_BUDGETS as t };