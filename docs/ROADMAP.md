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

## 3. 官方文档保真：不提炼、不 git rm、保留逐字原文

`docs/sensenova-api-reference/*.md`（12 个，商汤**官方一手信源**，已由 `.txt` 改名 `.md`）的处理原则已据评审纠偏——**原「提炼回 SENSENOVA-API.md 后 git rm」方案作废**，理由：

- **权威性问题**：这些是逐字引用才有意义的一手信源（错误码 `429 quota_exceeded_error`、参数名 `reasoning_effort`/`supported_features`、模型实测能力表）。转述会漂，且 `codes.js`/`parsePools` 的判据靠 grep 原文兜底，丢原文即丢依据。
- **git rm 前提错误**：`upstream/SenseNova AI API does/` 与 `docs/sensenova-api-reference/` 那份**逐字节相同，但 upstream 那份 0 文件进 git**（是参考应用 checkout，不在本插件版本控制）。`docs/sensenova-api-reference/` 那份是**唯一受版本控制的官方副本**——`git rm` 不是去重，是删除唯一受控信源。
- **无实际问题需解**：这 12 个 txt **不在 `package.json` 的 `files`** → 不进发布包；位于 `docs/` 子目录 → 不触发 `docs.test.mjs` 孤儿文件规则；`SENSENOVA-API.md` 本就是独立的「实测注释层」（开篇即声明「官方文档多处不符，以实测为准」），揉进原文反而搅乱它已维护的「官方 vs 实测」边界。

**正确做法（天花板 = 改名，不越界）**：

- **保留官方原文逐字**，作为只读一手信源。
- **最多改名**：`.txt` → `.md`（纯内容保留、零权威损失，仅换扩展名让查看器渲染更好）；顺手把误译残留目录名 `SenseNova AI API does` 改为 `sensenova-api-reference`。
- **[SENSENOVA-API.md](./SENSENOVA-API.md) 保持「实测注释层」身份**，改为**链接**到官方原文（如「官方模型列表见 `sensenova-api-reference/11、模型列表.md`」），而非抄录——形成「官方一手信源（逐字，只读）+ 插件实测注释（我们维护）」两层互不污染。
- **不做**：提炼/转述、把官方原文合并进 SENSENOVA-API.md、`git rm` 官方副本。
- **不做**「把 `upstream/` 拉进库」的反向操作（`upstream/` 仍 gitignored、独立历史）。

## 4. P1：CLI `doctor --json`

- 零平台依赖，降最长登录链路排障成本；workbuddy 侧独有缺口。
- 离线可测，归入 `config` / `parsers` 套件验证。

## 5. 明确不做（边界，写死防止漂移）

- **多 Key 池化**：同池无效，已纠偏（§1）。
- **签到 / 每日领取**：先证商汤有端点，否则不吸。
- **不再往 `upstream/` 拉新项目**，除非同时定义「提炼出口」（吸知识不吸代码）。
- **跨 provider 通用聚合**：不吸收 `dsh-provider-quota` / `dsh-musage` 的泛化定位（见 §5.3）。

## 5.1 竞品参照：raccoon 的机制点（可选模式范本）

> 仅作**机制参考，不抄代码**。参照对象：`liudapeng0311/dsh-raccoon-work`（DSH 小浣熊 Connect，接入商汤小浣熊桌面 App 模型）。
> 关键事实：它接的是**小浣熊桌面 App 登录态网关**（`xiaohuanxiong.com/api/web/llm/v2` + box-agent 登录态文件），**不是** Token Plan 配额池——限流宇宙与我们不同，故「它不限速」是源差异、非技术碾压。

可借鉴的机制点（纯架构，不移植实现）：

- **零配置复用桌面 App 登录态（接入模式范本）**：读 App 自维护的登录态文件，不另起 OAuth 流，账号切换自动跟随。若未来做「App 登录态直连」可选 provider 模式，这是骨架——但属合规/授权分叉，需先定方向（见 §5 边界，不默认吸收）。
- **刷新令牌单用回写（必要纪律）**：上游刷新是单用语义，会服务端轮换 refresh token，必须把轮换后的对回写 App 登录态文件，否则 App 下次撞 `refresh_conflict` 被登出；冲突时先重读 App 文件拿有效令牌再继续。任何「回读桌面凭证」模式都必须照搬，否则会卡住用户登录面（同源于 AGENTS.md 并行纪律）。
- **信封→HTTP 状态翻译（shim 范本）**：网关用 `{code, message, data}` 信封 + 业务码（积分不足 `200402`/`200429`、限频短语「频繁 / rate limit」）表达语义，插件翻译成 HTTP 状态（401/402/429）交给 pi-ai 默认重试。我们 `codes.js` 的 `RATE_LIMITED` 分诊哲学可参考其写法。
- **探测结果缓存（避免重复花费）**：推理档位需实测（网关只部分校验）、实测花积分，故按「账号 + 目录行指纹」缓存结论（有效期 14 天），上游改行即作废重测。若我们未来做推理档位实测（目前靠官方目录声明），可借鉴指纹缓存。
- **429 处理（反例，确认取舍）**：其 `retryPolicy` 传 `undefined` 用默认，所有 429 当 `soft_rate` 甩给 pi-ai 默认重试，**不做配额耗尽 vs 限频分诊**。这恰是我们 `llm-retry.js` 已做得更细之处，且印证「Token Plan 硬配额池需精细治理」是 raccoon 触及不到的维度——不要回退。

## 6. 优先级与时间盒

| 优先级 | 项 | 侵入性 | 门禁 |
|---|---|---|---|
| **P0 ✅** | 429 spike + 配额联动（全局策略 `llm-retry.js` + per-model 可用性 `llm-models.js` + `index.js` quota 重注册） | 低（1 行 peer + peer-free 分类器 + 状态文件桥） | `e2e-gate`（dsh CLI 在则实跑）；`test/retry.test.mjs` 已落地 |
| **P0 文档** | §5 纠偏 + 本文入库 | 无（仅 doc） | `docs.test.mjs` |
| **P1** | `doctor --json` | 低 | `config` / `parsers` 套件 |
| P1（可选） | §3 官方文档保真（改名/链接，不提炼不 `git rm`） | 低（仅重命名 + 链接） | `docs.test.mjs` |
| 明确不做 | 多 Key / 签到 / 跨 provider 聚合 | — | — |

## 7. 关联文档

- [ARCHITECTURE.md](./ARCHITECTURE.md) §5 — 定位与边界（本文承接，不复制其表）
- [AGENTS.md](../AGENTS.md) — 验证裁剪、红线
- [TESTING.md](./TESTING.md) — `docs.test.mjs` 孤儿文件 / 跨文件重复表规则
- [SENSENOVA-API.md](./SENSENOVA-API.md) — 商汤接口全集（§3 保真：链接官方原文，不提炼）
- [PITFALLS.md](./PITFALLS.md) — 改代码前避坑（§16 peer 解析、§6 凭据事故）
