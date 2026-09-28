# 路线图（Roadmap）

> 本文承接 [ARCHITECTURE.md](./ARCHITECTURE.md) §5「大统一」定位变更，是**执行层面的时间序列与优先级**，不是重复定位。§5 负责「我们是谁、边界在哪」，本文负责「下一步做什么、按什么顺序、侵入性如何、门禁怎么过」。
> 依据：[AGENTS.md](../AGENTS.md)（验证裁剪、红线）、[TESTING.md](./TESTING.md)（docs.test.mjs 防孤儿文件 / 防跨文件重复表）、[PITFALLS.md](./PITFALLS.md)。

## 0. 已锁死的前提（来自 §5，这里不复制其表）

- **三条不变量**：每个新模块 opt-in 默认关；凭据红线不动；只吸与商汤 Key / 账号线强相关的能力。
- **实测事实**：本插件已是双 profile（`desktop` / `web`）的 `agent-default-model`——即这台机器的**默认推理通道**，故障域已从「侧边栏面板」升级为「推理可用性」。
- **角色**：从「只下发信息」升级为「信息 + 执行」，但每块执行都挂在三条不变量下。

## 1. 对 §5 的一处纠偏：429 不做多 Key 池

§5 原写「429 自愈 + 多 Key 池进插件」。经查证需要修正：

- **事实**：SenseNova Token Plan 是**同一账号共享额度池**，换 Key 不换池 → 多 Key 轮换对该路线是**伪解**（这也是 §5 早已写「不碰 `st-rotator` 多 Key」的同源理由）。
- **决策**：吸收 `st-rotator` 的两条纪律——① 先分诊「限频（可退避）vs 配额不足（别空转）」；② 降速退避而非继续冲——但**不吸收多 Key 池化**。
- §5 的「拟吸收」行已据本文件改为「429 自愈（退避 + 分诊），不做多 Key 池」。

## 2. 旗舰刀口：429 自愈（全局级，低侵入）✅ 已实现

### 2.1 配置粒度结论（已查证代码）

| 检查点 | 结论 |
|---|---|
| `retryPolicy` 落点 | `llm-adapter.js:127` 唯一 `profiles` 条目（`LLM_PROVIDER_ID`），**provider 全局级**，非 model 级 |
| descriptor 是否带 per-model retry | `llm-models.js` `toPiDescriptor` 无 retry/quota 字段，全局策略即全 model 一刀切 |
| quota 数据源粒度 | `parsers.js` `parsePools` 每个 pool 带 `modelIds`，额度是 **pool 级归组**，model 级差异化无数据支撑 |
| 推论 | 保持**全局** retry 策略（最低侵入）+ **per-model 可用性标记**（descriptor 重建时按 pool 耗尽打标） |

per-model 可用性标记即用户要的「清单自带识别」——但它是 **availability 信号**，不是 retry 配置，不碰 peer 钩子，随 `publishProvider` 重建即生效。

### 2.2 落地分层（peer-free 与 peer 依赖分离）

> spike 已查实：429 的「配额超限 vs 限频」**分类已由 peer 完成**，不需要我们重写。
> `dsh-llm-pi-ai/lib/index.js:1376` 的 `classifyPiAiError` 把 429 消息分成
> `QUOTA_EXCEEDED_CODE`（`isQuotaExceededError`）与 `RATE_LIMIT`（正则 `\b429\b|rate.?limit`）。
> 因此我们的工作只剩两件：**(a) 决定这两类错误的重试策略**；**(b) 把 pool 状态转成模型可用性**。

- **重试策略（全局，1 行 peer 改动）— 已实现**：`llm-retry.js` 导出 peer-free 的
  `buildRetryPolicyConfig()`（显式 `mode:"normal"`、`retryableCodes` 排除 `QUOTA`/`ACCOUNT_QUOTA`、保留
  `RATE_LIMIT` 并略调 backoff 对共享池更温和），`llm-adapter.js:127` 改为
  `resolveRetryPolicy(buildRetryPolicyConfig(), ...)`。peer 已默认对 `RATE_LIMIT` 退避、对 `QUOTA` 快速失败，本改动是把意图固定下来并防未来 peer 默认漂移。
- **quota→provider 桥 — 已实现**：快照处理器用 `exhaustedModelIds(pools)`（`llm-models.js`）算出借尽池覆盖的模型集，经 `publishProvider(entries, enabledIds, unavailableModelIds)` 透传给 `createSensenovaAdapter`，由 `buildDescriptors` 在 picker 侧排除（避免发出必 429 的请求）；另以 `quotaSignature`（`index.js`）去抖，仅在额度跨越零点时触发一次重注册（memoize 约束下唯一生效路径）。
- **per-model 可用性（「清单自带识别」）— 已实现**：`buildDescriptors`（`llm-models.js`）按 `pool.remaining<=0` 在 picker 侧排除借尽模型；面板则通过 `rosterWithAvailability(entries, pools)` 列出全部 chat 模型并附 `available`/`quotaExhausted` 标记（始终可见、灰色显示原因）。不依赖 peer 钩子，随 `publishProvider` 重建即生效。

### 2.3 spike 结论（已查证）：memoize → 走 re-registration

`PiAiAdapter.current()`（`dsh-llm-pi-ai/lib/index.js:1759`）用
`if (this.snapshot?.profiles === profiles) return this.snapshot;` 做记忆化，**key 是
profiles Map 的引用身份，不是内容**。本插件的 `profiles: () => profiles` 每次返回同一引用，
所以 retryPolicy 在首次构建后被冻结——**运行时改 Map 内的字段不会被拾取**，必须让 Map 引用变化。

因此「池耗尽即降级」走 **B 路（spike 前已预判的真实分支）**：在 quota 状态变化时触发一次
`publishProvider`，复用现有 catalog 签名去抖思路、加 `quota-signature` 即可整体重建 adapter、
重算 `resolveRetryPolicy`。这同时驱动 §2.2 的 per-model 可用性标记（本就走 `publishProvider`），
**两个能力共用一个重注册信号，全局、低侵入**。

**已排除的 C 路（精确窗口退避）**：peer 的 `dsh-llm-retry` 在 `failure.providerRetryAfterMs`
存在时会用它做精确退避（`dsh-llm-retry/lib/index.js:171`），且 `LlmFailure` 支持该字段。但 grep
`dsh-llm-pi-ai` 未发现它在 SenseNova 429 路径上提取 HTTP `Retry-After` 并附到 `LlmError`——
即默认 `RATE_LIMIT` 走的是通用指数退避，而非按平台窗口。要把「按 `resetAt` 精确退避」做出来，需要
推理侧响应钩子把 `Retry-After` 转成 `providerRetryAfterMs`，而该钩子面本次未在 peer 中查证到公开
入口。**C 路非必需**（默认已对 `RATE_LIMIT` 退避），列为 deferred，不阻塞主线。

### 2.4 测试（按域裁剪，禁全量）

- `test/retry.test.mjs` 已落地（peer-free）：断言 `buildRetryPolicyConfig` 形状（排除 QUOTA/ACCOUNT_QUOTA、保留 RATE_LIMIT）、`exhaustedModelIds`、`buildDescriptors` 排除借尽模型、`rosterWithAvailability` 标记；peer 可达时额外断言 `resolveRetryPolicy` 解析结果。
- 验证只跑 `parsers` / `provider` / `auth` 相关 + 新增 `retry`；**不跑全量**（`AGENTS.md` 并行纪律：禁连跑全量 vitest 卡死用户机）。

## 3. 文档精炼：吸知识、清重复

`docs/SenseNova AI API does/*.txt`（约 116K，与 `upstream/` 逐字节相同，已入 git 但不在 `files`）属「资料重复沉淀」：

- **待办**：先将其可引用字段提炼回 [SENSENOVA-API.md](./SENSENOVA-API.md)，确认无外部引用点后再 `git rm` 移出仓库，保留 `upstream/` 作对照。
- 不做「把 `upstream/` 拉进库」的反向操作（`upstream/` 仍 gitignored、独立历史）。

## 4. P1：CLI `doctor --json`

- 零平台依赖，降最长登录链路排障成本；workbuddy 侧独有缺口。
- 离线可测，归入 `config` / `parsers` 套件验证。

## 5. 明确不做（边界，写死防止漂移）

- **多 Key 池化**：同池无效，已纠偏（§1）。
- **签到 / 每日领取**：先证商汤有端点，否则不吸。
- **不再往 `upstream/` 拉新项目**，除非同时定义「提炼出口」（吸知识不吸代码）。
- **跨 provider 通用聚合**：不吸收 `dsh-provider-quota` / `dsh-musage` 的泛化定位（见 §5.3）。

## 6. 优先级与时间盒

| 优先级 | 项 | 侵入性 | 门禁 |
|---|---|---|---|
| **P0 ✅** | 429 spike + 配额联动（全局策略 `llm-retry.js` + per-model 可用性 `llm-models.js` + `index.js` quota 重注册） | 低（1 行 peer + peer-free 分类器 + 状态文件桥） | `e2e-gate`（dsh CLI 在则实跑）；`test/retry.test.mjs` 已落地 |
| **P0 文档** | §5 纠偏 + 本文入库 | 无（仅 doc） | `docs.test.mjs` |
| **P1** | `doctor --json` | 低 | `config` / `parsers` 套件 |
| 待办 | §3 文档精炼（提炼后 `git rm`） | 中（内容搬运） | `docs.test.mjs` + 引用点 grep |
| 明确不做 | 多 Key / 签到 / 跨 provider 聚合 | — | — |

## 7. 关联文档

- [ARCHITECTURE.md](./ARCHITECTURE.md) §5 — 定位与边界（本文承接，不复制其表）
- [AGENTS.md](../AGENTS.md) — 验证裁剪、红线
- [TESTING.md](./TESTING.md) — `docs.test.mjs` 孤儿文件 / 跨文件重复表规则
- [SENSENOVA-API.md](./SENSENOVA-API.md) — 商汤接口全集（§3 提炼目标）
- [PITFALLS.md](./PITFALLS.md) — 改代码前避坑（§16 peer 解析、§6 凭据事故）
