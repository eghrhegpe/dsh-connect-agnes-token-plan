# 路线图（Roadmap）

> 本文承接 [ARCHITECTURE.md](./ARCHITECTURE.md) §5「大统一」定位变更，是**执行层面的时间序列与优先级**，不是重复定位。§5 负责「我们是谁、边界在哪」，本文负责「下一步做什么、按什么顺序、侵入性如何、门禁怎么过」。
> 依据：[AGENTS.md](../AGENTS.md)（验证裁剪、红线）、[TESTING.md](./TESTING.md)（docs.test.mjs 防孤儿文件 / 防跨文件重复表）、[PITFALLS.md](./PITFALLS.md)。
> 研究档案：[IMPROVEMENTS.md](./IMPROVEMENTS.md) 是设计问题的**研究上游**（诊断 + 证据 + 投入/风险比）；本文只记**执行状态**——标 ✅ 章节的实施进展以本文为准，研究文件里残留的「已落地」注记只是写下当时的历史时间点，不随实现继续更新。

## 0. 已锁死的前提（来自 §5，这里不复制其表）

- **三条不变量**：每个新模块 opt-in 默认关；凭据红线不动；只吸与 Agnes Key / 账号线强相关的能力。
- **能力事实**：本插件**可**向 DSH 注册推理 provider（`agnes-token-plan`）。它是否成为某台机器的默认推理通道，由该机的 profile 与用户模型选择决定，**不随插件注册自动成立**（`agent-default-model` 是宿主的选择记录服务，见 [IMPROVEMENTS.md](./IMPROVEMENTS.md) §1.2 的撤销注记）；一旦某 profile 真的把它选作默认模型，故障域就从「Plugins 页里的只读面板」升级为「推理可用性」，这是**条件性**的爆炸半径，不是既成事实。
- **角色**：从「只下发信息」升级为「信息 + 执行」，但每块执行都挂在三条不变量下。

## 1. 对 §5 的一处纠偏：429 不做多 Key 池

§5 原写「429 自愈 + 多 Key 池进插件」。经查证需要修正：

- **事实**：Agnes Token Plan 是**同一账号共享的限流额度**（账号级四窗口，见 [AGNES-API.md](./AGNES-API.md) §4），换 Key 不换窗口 → 多 Key 轮换对该路线是**伪解**（这也是 §5 早已写「不碰 `st-rotator` 多 Key」的同源理由）。
- **决策**：吸收 `st-rotator` 的两条纪律——① 先分诊「限频（可退避）vs 配额不足（别空转）」；② 降速退避而非继续冲——但**不吸收多 Key 池化**。
- §5 的「拟吸收」行已据本文件改为「429 自愈（退避 + 分诊），不做多 Key 池」。

## 2. P0：`index.js` 控制面解耦 + 推理契约自动化回归 ✅ 已实现（2026-09）

> 来源：2026-09 锐评结论，研究论证见 [IMPROVEMENTS.md](./IMPROVEMENTS.md) §2（接线复杂度诊断的完整证据链）。两个 P0 先于任何「继续吸收」——§0 已承认本插件
> 可注册推理 provider（是否默认通道由 profile 决定），`index.js` 1187 行里同时挂着
> 5 条路由 + `providerState` 状态机 + `publishChain` 串行化 + 两个 fire-and-forget IIFE
> （catalog seed、draw 注册），复杂度已溢出：注释越解释越拆不动。再谈下一块吸收之前，
> 先把「控制面」和「契约护栏」立住，否则吸收越快、爆炸半径越大。
>
> **落地状态（本节完成时）**：§2.1 抽 `provider-publish.js` + `snapshot-aggregate.js`，
> `index.js` 从 1187 行瘦到 778 行（wiring F3 经新模块注入仍全绿）；§2.2 落
> `test/contract.test.mjs`（进 `npm test`）+ `test/baselines/sensenova-contract.json`
> （冻结 2026-09-29 实测）+ `test/live-contract.mjs`（`npm run test:live:contract`，手动档）。
> 离线全量套件 + e2e-gate 全绿。
>
> **2026-10 迁移补记**：插件整体迁到 Agnes 控制台，上段的文件名与端点是 2026-09 的落地面。
> 现行对应关系：`test/baselines/sensenova-contract.json` → `test/baselines/agnes-contract.json`、
> 商汤推理契约表 → `docs/AGNES-API.md` §7、`test/live-jwks.test.mjs`（已随 OIDC 线删除）
> → `test/live-contract.mjs`。§2.2 正文已按现行名字更新。

### 2.1 拆 `index.js`：控制面状态机独立成模块

**现状**（`index.js`，2026-09 实测）：`providerState` 8 字段 + `publishProvider` /
`publishProviderOnce` / `registerPair` / `releaseProvider` / `catalogSignature` 全内联在
`apply()` 闭包里；路由 handler 直接读写 `providerState`。`test/wiring.test.mjs` 的
F3（并发 publish「最后发起者最终注册」门控）依赖对 `index.js` 内部状态的注入，
所以拆之前必须先给状态机一个可注入的边界。

**做法**（peer-free，离线可测，与 `llm-retry.js` 同纪律）：

| 步骤 | 内容 | 门禁 |
|---|---|---|
| ① 抽模块 | 新建 `provider-publish.js`：`createProviderPublisher({ settings, panelSwitch, loadAdapterModule, getLlm, onEvent, logger })` 返回 `{ publish, release, dispose, state }`；内部持有 `publishChain` / `disposed` / `registerPair` 单点定义（PITFALLS §18/§19 语义原样迁移） | `test/wiring.test.mjs` F3 改为对新模块注入（gate 语义不变），原 F3 红→绿即完成 |
| ② 瘦 router | `index.js` 只留路由 handler + 快照组装 + 各 store 接线；`providerState` 改为 `publisher.state` 只读引用；目标 `index.js` < 700 行 | `test/routes.test.mjs` + `test/provider.test.mjs` 全绿；快照 14 键契约零改动（`docs.test.mjs` §5 门禁） |
| ③ 第二个 IIFE 收编 | draw 注册（`index.js:558-597` 的 `void (async () => {...})()`）改走 publisher 的 `onEvent` 钩子或独立 `draw-register.js`，与 ① 同批评审 | `test/draw.test.mjs` 全绿；快照契约仍零改动（工具缺席时 14 键不变） |

**不变量**：① 并发语义（`publishChain` 串行、`disposed` 闸、慢者赢修复）与 ② 回滚语义
（`registerPair` 单点、factory 结果 await + 形状校验）必须**原样**迁过去，不是重写；
`test/wiring.test.mjs` F3 是钉死并发语义的最后一道测试，拆完它必须仍红能抓同样的竞态。
**完成判据**：`index.js` 无 `providerState` 字段声明、`index.js` 行数 < 700、
wiring/routes/provider/draw 四套件全绿、e2e-gate 通过。

### 2.2 推理契约自动化回归（把 §20/§21 的实测从一次性变可复跑）

**现状**：ROADMAP §0 引用的「40+ 实测请求」与 `PITFALLS.md` §20/§21 的方言表
（thinking 形态、`reasoning_effort` 取值、采样规则、404/403 模型清单）全靠 2026-09-29
一次性手工实测维持，`docs/AGNES-API.md` §7 是注释层，**没有自动化护栏**——
平台下次改一个 400 语义就又是一轮 40 请求。本仓库的纪律是：live 档**不进 `npm test`**，
手动 `npm run test:live:contract` 才跑。

**做法**（离线骨架进门禁，live 重放手动跑）：

| 档 | 文件 | 内容 | 门禁 |
|---|---|---|---|
| 离线 | `test/contract.test.mjs`（进 `npm test`）+ `test/baselines/agnes-contract.json`（seed：逐模型的 chat / vision / thinking 档位；`test/baselines/sensenova-contract.json` 是商汤时代的历史原件，仍留在原处供对照） | 断言 `llm-models.ts` 的 `toPiDescriptor` / `identifyVisionModel` / `isChatModel` 对契约表的输出与冻结值一致；`parsers.ts` 对契约表的解析结果；`llm-retry.ts` / `codes.ts` 的 429 / quota 文案分类。契约表改动必须附「平台响应原文」证据（提交约定） | `npm test` 全绿 |
| live | `test/live-contract.mjs`（不进 `npm test`，`npm run test:live:contract`） | 对 `api.agnes-ai.cn/v1/models` 发 1 请求核对目录仍含冻结字段（模态 / context_length / max_output_length / supported_sampling_parameters）；推理端点按契约表**每格 1 请求、限流友好**（每格失败记漂移不重试），红 = 平台方言漂移，修法走 `AGNES-API.md` §7 注释层，不静默改代码 | 手动 / CI best-effort |
| 探针纪律（2026-09-30 扩） | 推理探针扩到 `reasoning_effort: low/medium`（每模型 2 请求、2s 退避）；**429 是节奏答案不是参数判读**——探针记 INDEFINITE、不计入失败、退出码 0，只有 4xx 参数拒绝才算「平台不支持」的负证据；探针结果**人工**写回冻结契约（`driftLog` 留平台响应原文），不自动改 `llm-models.ts` | 同上 |

**完成判据**：`test/contract.test.mjs` 进 `package.json` 的 `test` 脚本链；
`test/baselines/agnes-contract.json` 的字段与 `AGNES-API.md` §7 逐模型表一一对应；
live 档在 `package.json` 有 `test:live:contract` 脚本。

### 2.3 顺序约束（防漂移）

- §2.1 与 §2.2 **互不依赖，可并行**（不同文件域：§2.1 碰 `index.js`/`wiring`，
  §2.2 碰 `test/`+`package.json` 脚本）；但**都先于**任何「继续吸收」
  （§6.1 raccoon 机制点、§5 doctor、§6 明确不做清单之外的新模块）。
- §2.1 完成前，**冻结「大统一」下一块吸收**——`index.js` 还挂着 5 路由 + 2 个
  IIFE 时再加模块，会重演 PITFALLS §18「慢者赢」的并发陷阱面。
- §2.2 的 live 档失败**不是回归**（同 live 档纪律）：平台改字段时它红，
  修法是更新 `test/baselines/agnes-contract.json` + `AGNES-API.md` §7 注释，
  不是改 `llm-models.ts` 逻辑去迁就平台。
- §2.2 冻结的事实是**套餐层级相关**的（PITFALLS §20 自认部分模型 403 未实测、
  `reasoning_effort:"max"` 仅 glm 实测通过）：契约基线保的是「本机这把 Key 的世界
  没漂移」，不是「所有套餐都对」。分发到其它套餐的用户首遇方言差异时，修法走
  `AGNES-API.md` §7 注释层 + 基线增行，不静默改 `llm-models.ts`——live 档
  只在作者机器有护栏，这一层保护随大统一分发而变薄，吸收新模块前先记住这一点。

## 3. 旗舰刀口：429 自愈（全局级，低侵入）✅ 已实现

> 研究论证：[IMPROVEMENTS.md](./IMPROVEMENTS.md) §3（peer 语义耦合的诊断与契约护栏选项）。

### 3.1 配置粒度结论（已查证代码）

| 检查点 | 结论 |
|---|---|
| `retryPolicy` 落点 | `llm-adapter.js:127` 唯一 `profiles` 条目（`LLM_PROVIDER_ID`），**provider 全局级**，非 model 级 |
| descriptor 是否带 per-model retry | `llm-models.ts` `toPiDescriptor` 无 retry/quota 字段，全局策略即全 model 一刀切 |
| quota 数据源粒度 | `parsers.ts` `parsePools` 每个 pool 带 `modelIds`，额度是 **pool 级归组**，model 级差异化无数据支撑 |
| 推论 | 保持**全局** retry 策略（最低侵入）+ **per-model 可用性标记**（descriptor 重建时按 pool 耗尽打标） |

per-model 可用性标记即用户要的「清单自带识别」——但它是 **availability 信号**，不是 retry 配置，不碰 peer 钩子，随 `publishProvider` 重建即生效。

### 3.2 落地分层（peer-free 与 peer 依赖分离）

> spike 已查实：429 的「配额超限 vs 限频」**分类已由 peer 完成**，不需要我们重写。
> `dsh-llm-pi-ai/lib/index.js:1376` 的 `classifyPiAiError` 把 429 消息分成
> `QUOTA_EXCEEDED_CODE`（`isQuotaExceededError`）与 `RATE_LIMIT`（正则 `\b429\b|rate.?limit`）。
> 因此我们的工作只剩两件：**(a) 决定这两类错误的重试策略**；**(b) 把 pool 状态转成模型可用性**。

> ⚠️ **纠偏（2026-09-30 实测）**：上述 spike 假设"peer 分类正确"，但实际 `isQuotaExceededError`
> （`dsh-llm/lib/index.js:181`）命中面过宽——含 `out of ... budget`、`balance/credits exhausted`、
> `usage limit (exceeded|exhausted|reached)` 等。Agnes 限频 429 体常带 `rate limit budget` /
> `out of rate budget` 这类字眼，于是被**抢判为 `QUOTA`**（而纯 `RATE_LIMIT` 正则因排在 `isQuotaExceededError`
> 之后成了死代码）。后果：本应退避重试的限频被按"配额耗尽"快速失败、且模型被面板静默下线呈现"额度已用尽"。
> → 新增 `llm-error-fix.ts` 在 host 侧 Proxy 包裹 `PiAiAdapter` 流出口，把"误判的限频 QUOTA"纠正回
> `RATE_LIMIT`（保留 message）；真配额耗尽与已限频原样放行。即：peer 分类**仍用作主路径**，但我们加了一层
> 保守的"宁重勿杀"纠正，不重写、不依赖 peer 解析（peer-free 可测）。

- **重试策略（全局，1 行 peer 改动）— 已实现**：`llm-retry.ts` 导出 peer-free 的
  `buildRetryPolicyConfig()`（显式 `mode:"normal"`、`retryableCodes` 排除 `QUOTA`/`ACCOUNT_QUOTA`、保留
  `RATE_LIMIT` 并略调 backoff 对共享池更温和），`llm-adapter.ts:127` 改为
  `resolveRetryPolicy(buildRetryPolicyConfig(), ...)`。peer 已默认对 `RATE_LIMIT` 退避、对 `QUOTA` 快速失败，本改动是把意图固定下来并防未来 peer 默认漂移。
- **quota→provider 桥 — 机制在，实现已撤**：机制仍全通（`publishProvider(entries, enabledIds, unavailableModelIds)`
  透传给 adapter，由 `buildDescriptors` 在 picker 侧排除；`quotaSignature` 去抖，仅在额度跨越零点时触发一次
  重注册，memoize 约束下唯一生效路径）。但**推导那一半已删除**：原 `exhaustedModelIds(pools)` 从 SenseNova 的池
  载荷算借尽模型集，Agnes 不按模型分配配额（控制台只给账号级窗口与累计用量），该推导无对应事实，
  `snapshot-aggregate.ts` 的 `unavailableModelIds` 因此**恒为空数组**（红线⑦：不得计算「剩余」）。
  当前空集是**设计而非遗漏**——账号级额度不足由面板**明说**，不靠静默摘模型。留这条接线是因为第二个被吸收的
  上游可能真有 per-model 信号。契约测试在 `test/retry.test.mjs`（该套件已按新形状改写）。
- **per-model 可用性（「清单自带识别」）— 机制在，实现已撤**：picker 侧排除（`buildDescriptors` 收
  `unavailableModelIds`）与面板侧标记（`rosterWithAvailability(entries, blockedIds)` 附
  `available`/`quotaExhausted`）**两端都还在，且两端读同一份契约**，只是喂进去的集合恒为空——所以装出来的
  效果就是「什么都不排除、全部 available」。不依赖 peer 钩子，随 `publishProvider` 重建即生效。

### 3.3 spike 结论（已查证）：memoize → 走 re-registration

`PiAiAdapter.current()`（`dsh-llm-pi-ai/lib/index.js:1759`）用
`if (this.snapshot?.profiles === profiles) return this.snapshot;` 做记忆化，**key 是
profiles Map 的引用身份，不是内容**。本插件的 `profiles: () => profiles` 每次返回同一引用，
所以 retryPolicy 在首次构建后被冻结——**运行时改 Map 内的字段不会被拾取**，必须让 Map 引用变化。

因此「池耗尽即降级」走 **B 路（spike 前已预判的真实分支）**：在 quota 状态变化时触发一次
`publishProvider`，复用现有 catalog 签名去抖思路、加 `quota-signature` 即可整体重建 adapter、
重算 `resolveRetryPolicy`。这同时驱动 §3.2 的 per-model 可用性标记（本就走 `publishProvider`），
**两个能力共用一个重注册信号，全局、低侵入**。

**已排除的 C 路（精确窗口退避）**：peer 的 `dsh-llm-retry` 在 `failure.providerRetryAfterMs`
存在时会用它做精确退避（`dsh-llm-retry/lib/index.js:171`），且 `LlmFailure` 支持该字段。但 grep
`dsh-llm-pi-ai` 未发现它在 Agnes 429 路径上提取 HTTP `Retry-After` 并附到 `LlmError`——
即默认 `RATE_LIMIT` 走的是通用指数退避，而非按平台窗口。要把「按 `resetAt` 精确退避」做出来，需要
推理侧响应钩子把 `Retry-After` 转成 `providerRetryAfterMs`，而该钩子面本次未在 peer 中查证到公开
入口。**C 路非必需**（默认已对 `RATE_LIMIT` 退避），列为 deferred，不阻塞主线。

### 3.4 测试（按域裁剪，禁全量）

- `test/retry.test.mjs` 已落地（peer-free）：断言 `buildRetryPolicyConfig` 形状（排除 QUOTA/ACCOUNT_QUOTA、保留 RATE_LIMIT）、`buildDescriptors` 排除传入的 `unavailableModelIds`、`rosterWithAvailability` 的 `available`/`quotaExhausted` 标记与二者读同一份契约；peer 可达时额外断言 `resolveRetryPolicy` 解析结果。
- 验证只跑 `parsers` / `provider` / `auth` 相关 + 新增 `retry`；**不跑全量**（`AGENTS.md` 并行纪律：禁连跑全量 vitest 卡死用户机）。

## 4. 官方文档保真（历史决策存档：文件已随迁移移除）

> ⚠️ **本节所议的 `docs/sensenova-api-reference/*.md` 与 `SENSENOVA-API.md` 已于迁移到 Agnes 控制台时删除**，以下记录保留供历史回溯，**不再是现行依据**。

`docs/sensenova-api-reference/*.md`（12 个，商汤**官方一手信源**）当时曾据评审纠偏——**原「提炼回 SENSENOVA-API.md 后 git rm」方案作废**，理由：

- **权威性问题**：这些是逐字引用才有意义的一手信源（错误码 `429 quota_exceeded_error`、参数名 `reasoning_effort`/`supported_features`、模型实测能力表）。转述会漂，丢原文即丢依据。
- **git rm 前提错误**：`upstream/SenseNova AI API does/` 与 `docs/sensenova-api-reference/` 那份**逐字节相同，但 upstream 那份 0 文件进 git**（是参考应用 checkout，不在本插件版本控制）。`docs/sensenova-api-reference/` 那份是**唯一受版本控制的官方副本**——`git rm` 不是去重，是删除唯一受控信源。
- **无实际问题需解**：这 12 个 txt **不在 `package.json` 的 `files`** → 不进发布包；位于 `docs/` 子目录 → 不触发 `docs.test.mjs` 孤儿文件规则；`SENSENOVA-API.md` 本就是独立的「实测注释层」（开篇即声明「官方文档多处不符，以实测为准」），揉进原文反而搅乱它已维护的「官方 vs 实测」边界。

**当时的正确做法（天花板 = 改名，不越界）**：

- **保留官方原文逐字**，作为只读一手信源。
- **最多改名**：`.txt` → `.md`（纯内容保留、零权威损失，仅换扩展名让查看器渲染更好）；顺手把误译残留目录名 `SenseNova AI API does` 改为 `sensenova-api-reference`。
- **`SENSENOVA-API.md` 保持「实测注释层」身份**，改为**链接**到官方原文，而非抄录——形成「官方一手信源（逐字，只读）+ 插件实测注释（我们维护）」两层互不污染。
- **不做**：提炼/转述、把官方原文合并进 SENSENOVA-API.md、`git rm` 官方副本。
- **不做**「把 `upstream/` 拉进库」的反向操作（`upstream/` 仍 gitignored、独立历史）。

## 5. P1：CLI `doctor --json` ✅ 已实现

- 落地坐标：`src/host/doctor.ts`（只读巡检，经各 store 自己的解析器读，永不分歧）+ `tools/doctor.mjs`（`npm run doctor` / `npm run doctor:json`，零平台依赖）+ `test/doctor.test.mjs`（独立套件进 `npm test`，非 config/parsers 代管）。
- 降低最长登录链路排障成本；workbuddy 侧独有缺口。

## 6. 明确不做（边界，写死防止漂移）

- **多 Key 池化**：同池无效，已纠偏（§1）。
- **签到 / 每日领取**：先证平台有端点，否则不吸。
- **不再往 `upstream/` 拉新项目**，除非同时定义「提炼出口」（吸知识不吸代码）。
- **跨 provider 通用聚合**：不吸收 `dsh-provider-quota` / `dsh-musage` 的泛化定位（见 §5.3）。
- **client.js 文件级分解（2026-09-29 定界不拆；2026-09-30 tripwire 触发、决策重开并执行完毕——client 半边 TS 化 + 按功能拆文件一步到位，见 §6.2）**。
  该边界条目的「不拆」部分就此退役；「Host 半边免构建」也已随之作废（见 §6.2 末段「【当晚已被取代】」——Host 源码迁 `src/host/*.ts` 并由 tsdown 构建 `lib/`，产物不入库）。

## 6.2 构建链与 Client 拆分（2026-09-30：先干跑验证，当日决策重开并执行完毕）

原计划「拆分先行、.ts 化稳定后再说」被合并为一步（touch 每个文件一遍而非两遍），
用户拍板采纳；本节是既成事实的执行记录。

**已落地：**

- **源码布局**：`src/client/*.ts` 十五个文件，按功能拆——`index.ts`（factory +
  三世界尾巴）、`runtime.ts`（React 缝隙：factory 入口 `provideClientReact`，其余
  模块经转发的 `h`/hooks 取用，调用点与拆分前的闭包形式逐字一致）、`const.ts`
  （路由常量）、`i18n.ts`（zh/en 双语字典，`en: typeof zh` 编译期钉键集齐平）、
  `styles.ts`、`format.ts`、`models.ts`（allow-list 代数）、`snapshot.ts`（决策层
  + 三张码表）、`cards.ts`、`account-form.ts`、`provider-controls.ts`、
  `model-picker.ts`、`api-key-form.ts`、`panel-page.ts`、`apply.ts`。行为逐字转录，
  17 个离线套件 + e2e 全绿背书。
- **构建**：`tsdown.config.mjs` → 根 `client.js` 产物，`npm run build:client`。三个
  关键取值：`format: "iife"`（顶层零 import/export，三世界尾巴活在函数作用域里；
  esm 构建会被 rolldown 的 CJS 语法探测包壳改写 ABI）；`outputOptions.entryFileNames:
  "client.js"`（产物路径/文件名不变，`package.json#exports` 与 `files` 不动）；
  `clean: false`（outDir 是仓库根）。factory 参数命名 `loaderRequire` 而非
  `require`——避免裸 `require` 被打包器当模块系统语法改写；react 仍由 loader 注入
  （`deps.neverBundle` 钉住）。三世界尾巴保留在源码里，CJS require 世界照旧声明。
- **门禁**：`test/build-gate.mjs`（npm test 链尾、e2e-gate 之前；文件名不含
  `.test.`，不入 `package.test.mjs` 三方名册，同 e2e-gate 范式）——**freshness**
  （重建与产物做换行归一化的逐字节比对，**过期即红**：`src/client/` 变了没重建会被
  门禁拦住；产物 gitignore 不入库，所以红只是提示「保持产物与源码同步」，无需提交）
  + **形状**
  （无顶层 import/export、ESM 导入恰好注册一份、react-only 替身可物化、panel 测试面
  键齐全）。tsdown 缺席则醒目 SKIP 退出 0。
- **新纪律**：改 `src/client/*.ts` 后必须 `npm run build:client`，并把根 `client.js`
  与源码放进**同一个 commit**；只提交源码不提交产物 = build-gate 红。devDeps 安装需
  `--legacy-peer-deps`（peer 包不在 registry；本仓刻意无 lockfile）。
- **【当晚已被取代】「Host 半边不动」**：随后按 workbuddy 规范完成全仓归一——Host 源码迁
  `src/host/*.ts`（Host 模块），tsdown 多入口构建 `lib/`（ESM bundle + 切分 chunk）；`lib/` 与根
  `client.js` 一并 `.gitignore`，**产物彻底不入库**（上文「产物与源码同 commit」纪律随之作废），
  测试面与门禁已适配；全量套件 + build-gate + e2e + tsc 全绿，「删 lib 可重建」验收通过。
  checkJs 的 JSDoc 投入随 .ts 化自然并入类型标注。

**遗留项已闭合（2026-09-30）**：CI 离线 job 现已安装 devDeps（`npm install
--legacy-peer-deps`；setup-node 以 `package.json` 为 key 做 npm 缓存——本仓刻意无
lockfile）并实跑 `test/build-gate.mjs`，构建失败与产物缺失在 CI 即红，不再恒 SKIP。
「无构建」表述已全库同步（`DSH-PLUGIN.md` §7、`ARCHITECTURE.md` 半边表、
`TESTING.md` 链条枚举、`AGENTS.md` 验证段、`PITFALLS.md` §22）。

## 6.1 竞品参照：raccoon 的机制点（可选模式范本）

> ⚠️ **本节所涉的小浣熊第二上游已于 2026-10-01 从本插件移除**：Agnes 插件不再承载商汤小浣熊线
> （兄弟插件 `dsh-connect-sensenova-token-plan` 保留该线并继续演进）。本节保留为机制研究与
> 历史裁定记录——实现坐标（`src/host/raccoon*.ts`、`src/client/raccoon-tab.ts`、
> `test/raccoon.test.mjs`）均已删除，别再按文中的文件路径去找实现。

> 仅作**机制参考，不抄代码**。参照对象：`liudapeng0311/dsh-raccoon-work`（DSH 小浣熊 Connect，接入商汤小浣熊桌面 App 模型）。
> 关键事实：它接的是**小浣熊桌面 App 登录态网关**（`xiaohuanxiong.com/api/web/llm/v2` + box-agent 登录态文件），**不是** Token Plan 配额池——限流宇宙与我们不同，故「它不限速」是源差异、非技术碾压。

可借鉴的机制点（纯架构，不移植实现）：

- **零配置复用桌面 App 登录态（接入模式范本）**：读 App 自维护的登录态文件，不另起 OAuth 流，账号切换自动跟随。若未来做「App 登录态直连」可选 provider 模式，这是骨架——但属合规/授权分叉，需先定方向（见 §6 边界，不默认吸收）。
- **刷新令牌单用回写（必要纪律）**：上游刷新是单用语义，会服务端轮换 refresh token，必须把轮换后的对回写 App 登录态文件，否则 App 下次撞 `refresh_conflict` 被登出；冲突时先重读 App 文件拿有效令牌再继续。任何「回读桌面凭证」模式都必须照搬，否则会卡住用户登录面（同源于 AGENTS.md 并行纪律）。
- **信封→HTTP 状态翻译（shim 范本）**：网关用 `{code, message, data}` 信封 + 业务码（积分不足 `200402`/`200429`、限频短语「频繁 / rate limit」）表达语义，插件翻译成 HTTP 状态（401/402/429）交给 pi-ai 默认重试。我们 `codes.js` 的 `RATE_LIMITED` 分诊哲学可参考其写法。
- **探测结果缓存（避免重复花费）**：推理档位需实测（网关只部分校验）、实测花积分，故按「账号 + 目录行指纹」缓存结论（有效期 14 天），上游改行即作废重测。若我们未来做推理档位实测（目前靠官方目录声明），可借鉴指纹缓存。
- **429 处理（反例，确认取舍）**：其 `retryPolicy` 传 `undefined` 用默认，所有 429 当 `soft_rate` 甩给 pi-ai 默认重试，**不做配额耗尽 vs 限频分诊**。这恰是我们 `llm-retry.js` 已做得更细之处，且印证「Token Plan 硬配额池需精细治理」是 raccoon 触及不到的维度——不要回退。

### 6.1.1 桌面端登录态作为「第二条登录路径」：已实测否决，实施延后

> **状态（2026-09-30 第二次复测：仍判死）**：**不做**，但**保留原理与复测判据**。方向上是「最终仍想融」，
> 因此这里只钉结论与前置门禁——**实施统一推迟到本体稳定之后**，本块不阻塞任何主线。

**结论**：小浣熊桌面端的登录态**不能**作为本插件的第二条登录路径。
原因不是权限没开，而是**两个独立认证域**。

> **探针端点注记（2026-10）**：下表两次复测打的都是**当时**的 Token Plan 控制台
> （`platform.sensenova.cn/lite/console/v1/tokenplan/pool-usage`）。Token Plan 已迁到 Agnes，
> 所以**现在的复测判据要打 Agnes 的额度路由**（见本节末「复测判据」）。两次记录的结论不受影响——
> 它们证明的是「桌面 App 的令牌打不通 Token Plan 的认证域」，与 Token Plan 迁到哪台主机无关。

**实测证据（2026-09-29，只读探针，token 只在内存中过一遍 `Authorization` 头，
未落盘、未进日志）**：

| 观测 | 结果 |
|---|---|
| 桌面 `~/.box-agent/config/auth.json` 的 JWT claims | `iss` 为**数字型 App 级标识**（本例 `721217`），**无 `aud`、无 `scope`** |
| `GET platform.sensenova.cn/lite/console/v1/tokenplan/pool-usage`（带该 token） | `401` `auth_token_invalid` / `Invalid access token` |
| `GET token.sensenova.cn/v1/models`（同上） | `401`，`{"code":16,"message":"Forbidden"}` |

**第二次只读复测（2026-09-30，判据 §6.1.1 原文 1 次只读请求）**：桌面 `access_token`
（claims 指纹与 09-29 相同）打 `GET platform.sensenova.cn/lite/console/v1/tokenplan/pool-usage`
仍回 `401 auth_token_invalid / "Unauthenticated"`——**判死结论未变**，认证域未合并。
附带对照：`xiaohuanxiong.com/api/web/llm/v2/models` 回 `404 page not found`（网关路由或鉴权入口与 09-29 记录有漂移，
融第二上游前需重新核实该端点契约，不能照抄 raccoon 的 URL 清单）。

对照本插件自己的令牌：Agnes 控制台的 access token（`POST {consoleBase}/api/user/login` 一跳换取，
见 [AGNES-API.md](./AGNES-API.md) §1）。**令牌这一层就不通用**——
换登录方式（扫码 / 短信 / 深链回调）也绕不过去。

**同期核实的上游事实**（来自 `upstream/deepseek-harness-codearts-master`，即
`dsh-codearts-auth`）：

- 小浣熊桌面官方授权链路 `office-raccoon://auth/callback` 在网页里**写死**，
  宿主侧 Node 进程收不到回调；第三方插件只能自建登录流（微信扫码 / 短信验证码）。
  故「读桌面 `auth.json`」是**捷径而非唯一路径**。
- `desktop/v1/login/points/grant` 是小浣熊「桌面端登录奖励（每号一次）」端点，
  但其积分属于**小浣熊域（`xiaohuanxiong.com`）**，不是 Token Plan 积分池——
  对 §6「签到 / 每日领取」边界仍不适用。

**三条凭据路线（原理；未来真要融时先回到这张表对形态）**：

| 路线 | 做法 | 代表 | 风险面 |
|---|---|---|---|
| 只读桌面登录态 | 读 App 凭据文件、绝不写回，刷新结果写插件自有副本 | workbuddy 类 | 低：不可能弄坏 App 的登录 |
| 回写桌面登录态 | 上游 refresh 是单次使用语义，必须把轮换后的令牌写回 App 文件 | 小浣熊桌面 | 高：写坏即把用户登出 App |
| 自有登录 + 凭据服务 | 自己走 OAuth / 扫码，凭据只进 DSH 凭据服务 | **本插件**、codearts | 低，但每个产品要各写一套 |

**若未来要融，正确形态是「第二上游 provider」而不是「第二登录路径」**：把
`xiaohuanxiong.com/api/web/llm/v2` 注册为独立 provider（opt-in、默认关、
独立凭据生命周期、不碰 Token Plan 池语义）。

> **方向已定（2026-10-01）：纳入。** 此前这里写「它撞 §5 不变量 3（按 Key/账号线划线），
> 属合规 / 授权分叉，须先定方向——**不默认吸收**」。当时搁置的原因是**边界划法**而不是
> 不认同这件事本身：按认证域划线会把同一厂商的姐妹产品线一并判成界外。
> [ARCHITECTURE.md](./ARCHITECTURE.md) §5 不变量 3 的划线依据已改为「厂商归属」，裁定
> **界内**——举证与裁定沿革见 [ADR.md](./ADR.md) ADR-002（该适用范围后由 ADR-003 收窄为 Agnes 线）。
> 本节的两次复测结论**不变**——它判死的是第二**登录路径**（桌面 App 登录态复用），
> 与第二上游是不是界内是两件事，别混为一谈。

**复测判据（本体稳定后、开工前先跑，1 次只读请求）**：拿桌面 `access_token` 打
`GET https://platform-backend.agnes-ai.cn/api/usage/overview`（Token Plan 现行控制台的额度路由）；
`200` = 认证域已合并（本结论被推翻，可继续）；`401` 或 HTTP 200 带信封 `code:401` = 仍然判死
（Agnes 的鉴权拒绝可能走 200 + `code:401`，两种形态都算拒绝，见 [AGNES-API.md](./AGNES-API.md) §3）。

**前置门禁**：本插件本体稳定——§2.1 / §2.2 两个 P0 已落地且无挂起中的吸收项。

### 6.1.2 第二上游形态：2026-10-01 网关契约复测（落地后补齐）

> **背景纠偏**：raccoon 第二上游（面板第三个 tab、`sensenova-raccoon` provider）已于
> 2026-09-30 21:31（commit `5d789b6`）落地并随 **0.4.3** 发布，但本文件当时**没有同步**——
> §6.1.1 的结论与 §7 的 P2 行都还停在「观望」。§6.1.1 判死的是**第二登录路径**（复用桌面
> App 登录态打 Token Plan），该结论不变；本节补的是**第二上游形态**（独立 provider 打
> `xiaohuanxiong.com` 网关）在落地之后的首次补齐复测。

**复测对象**：`https://xiaohuanxiong.com` 网关，全部请求**不带任何凭据**（无本地 token 参与、
无计费可能、只读语义），目的只是区分「路由不存在」与「路由存在但需鉴权」。

| 端点 | 方法 | 响应 | 判读 |
|---|---|---|---|
| `/api/web/llm/v2/model_catalog` | GET | `401` `{"code":200001,"message":"authorization_empty_error"}` | 路由存在，抵达鉴权层 |
| `/api/web/llm/v2/chat/completions` | GET | `404` 纯文本 `404 page not found` | **仅 GET 未注册，不足以判死**（见下） |
| `/api/web/llm/v2/chat/completions` | POST | `401` `{"code":200001,"message":"authorization_empty_error"}` | 路由存在，抵达鉴权层 |
| `/api/web/llm/v2/models` | GET | `404` 纯文本 `404 page not found` | 复现 §6.1.1 的 09-30 记录；**本插件不使用此端点** |

**结论**：本插件实际依赖的两个网关路由（`model_catalog` 拉目录、`chat/completions` 走推理）
**契约成立**——两者都返回结构化信封而非纯文本 404，说明请求已抵达鉴权中间件。09-30 那次
「404」记录的是参考件 `dsh-raccoon-work` 的 `models` 端点，**不是本插件用的端点**；此前按
前缀相同就判「实现的常量就是被标注 404 的那份清单」是**误判**，已更正。

**附带的真教训**：用 GET 给 REST 端点探活有歧义。Go/Gin 一类框架对「路径存在但方法未注册」
默认回纯文本 `404 page not found`，与「路径不存在」无法区分——只看 GET 的 404 会把一个健康
端点误判成已漂移。判据必须是「同一路径 + 正确方法」，且要看**响应体形态**（结构化信封 vs
纯文本），不止看状态码。已收进 [PITFALLS.md](./PITFALLS.md) §24。

**仍然成立的两件事**：① 桌面 App 登录态打 Token Plan 仍然判死（§6.1.1 未变，两个认证域不通
用）；② 复测只能证明**路由还在**，不能替代带凭据的端到端验证——真凭据下的信封形态、
`refresh` 单用轮换、倍率字段都以 `test/raccoon.test.mjs` 的离线 fixture 为契约，需**（定期人工复核）**。

## 6.3 第三上游形态：AgnesCode BFF（2026-10-01 契约探针 ✅，当日落地实现）

> **落地记录**：本节探针当日完成实现——`src/host/agnescode*.ts` 六件套（协议层 + 本机采集 /
> 凭据 store / 开关 store / 花名册映射 / 独立 publisher / peer adapter）+ `/agnescode` 路由 +
> 面板第四个 tab，套件 `test/agnescode.test.mjs`（离线检查）进 `npm test` 门禁。隔离纪律
> 与 §6.1 的 raccoon 行同款：独立 publisher / store / 凭据引用，对主注册影响恒为零。

> **背景**：用户问及 `https://agnes-ai.cn/agnescode`（AgnesCode，独立编程助手产品，微信登录、
> 与 Token Plan 认证域互不相通）。GitHub 参考件 `vibe-coding-labs/AgnesCode2Api`（协议翻译
> 代理：AgnesCode → Anthropic/OpenAI）已完成一轮逆向——**只引用知识，不复制代码**；
> 2026-10-01 起 AgnesCode 线的参照件与本机快照统一**落盘到 `upstream/` 容器**（该容器整体被
> `.gitignore` 忽略、不入库，清单见 [REFERENCES.md](./REFERENCES.md)），故此处原有的
> 「不进 `upstream/`」表述作废——那次判断的落点已改：# 不能丢的是「入库」，不是「落盘」。本节探针按 §6.1.2 同款纪律执行，另有
> **一条最小推理请求为真实计费**（16 max_tokens，实测 65 token，本机账号当时有 1200 枚时效积分）。

**形态判定：不需要「反代」。** 参考件存在的原因是 Claude Code 只说 Anthropic 协议，需要
翻译层；本插件的 provider 机制直连 OpenAI 兼容端点，协议翻译对本插件是多余层。接入形态 =
现有 `agnes-token-plan` provider 的同款复制（base + Bearer + OpenAI 端点）。

**契约探针（CN 站，凭据来自本机会话文件，全程内存使用不落盘不打印）**：

| 项 | 实测 | 判读 |
|---|---|---|
| BFF base（CN） | `https://api-agnes-code.agnes-ai.cn/v1` | 写在本机会话文件 `bffPublicBaseUrl` 字段里，**不硬编码**；国际站同构 `.com`。参考件把 `.com` 写成常量，正是 video.ts 踩过的「参考件默认国际站」同款坑 |
| `POST /v1/chat/completions` | `200`，标准 OpenAI 信封（`reasoning_content`、usage 细分） | **零协议翻译**，provider 架构原样复用 |
| `GET /v1/models` | `200`（带 `X-App-Id: 1` + `X-Platform: 1`） | 模型表与 `~/.agnes/config/config.yaml` 内置 `agnes` provider 一致（glm-5.2 / kimi-k3 / agnes-2.5 / 3.0 …） |
| `GET /api/v2/subscription/credits-balance` | `200`，`total_balance: 1200`（time_sensitive） | **独立积分池**；语义是订阅池（`level` / `subscription_credits` / 时效 vs 永久），与 Token Plan 的 usage-overview 完全不同，不能套同一渲染。1200 是本机账号当时状态，非平台常量 |
| `GET /api/v1/user/profile` | `200` | `auth_provider: wechat`、`app_id: agnes`、`current_subscription: null` |
| token 生命周期 | JWT，`exp−iat ≈ 28 天` | 到期只能引导重登；**刷新端点未证实**——桌面 App 的 `auth-token-refresh-reservation` 仅做失效检测、无续期实现。即**续期是用户手动仪式**：每约 28 天需重开桌面 App、再点「检测本机登录态」重新采集，插件无法自动续期。这是上游形态决定的**已知限制**，不是本插件特性缺口，也不要在文档里把它写成「点一下就永久好」的顺滑能力 |

**凭据来源（本机登录态采集，已验证解密链）**：Windows 桌面变体存
`%APPDATA%\AgnesCode\code-auth-session.cn.v1`，Chromium os_crypt 形态（`v10` 前缀 +
AES-256-GCM；密钥在同目录 `Local State` 的 `os_crypt.encrypted_key`，DPAPI CurrentUser
包裹）。macOS 的 IDE 变体走 `state.vscdb` 明文 JSON（参考件 `pkg/auth/credentials.go`）。
红线适用：解出的 JWT 只进 DSH 凭据服务，trace 只记形状（比照 §15）。备选路径是 OAuth
deep-link（`issue-authorization-code` 用 JWT 换一次性 code → BFF `exchange-code` 换
`access_token`，`client_id: agnes-code`，redirect `agnes://auth/callback`）——仅记录，未实测。

**先例归属**：这将是本插件第一条「**本机登录态采集**」线（qoder / trae / workbuddy 族先例，
§5.3 核实表）；Token Plan 仍是「自有登录」（`dsh-codearts-auth` 先例）。两种形态并存时隔离
纪律与主提供方同款（[ARCHITECTURE.md](./ARCHITECTURE.md) §5.2）执行：独立 publisher / store / 凭据引用，
对主注册影响恒为零；opt-in 默认关、失败降级为面板缺席。

**对小浣熊 tab 的 UI 裁定：不取代。** raccoon tab 的四段式（开关 / 登录 / 积分 / 花名册）
本身就是 workbuddy 式设计的一个实现，且事实纪律更严（`×N` 芯片区分「平台声明的真倍率」与
「操作者伪倍率」）；微信扫码是它独有的入口形态，采集式 UI 无处安放。要吸收的是：①
AgnesCode tab 采用 workbuddy 的「探测过哪些路径 + 逐档失败原因」诊断——本插件的凭据来源
首次来自本地文件，「没装桌面 App / 未登录 / 加密字段拿不到密钥」必须分开说，这正是
workbuddy 五档原因的承重场景；② 三个 provider tab 的重复结构（开关/登录/积分/花名册）若
成型，抽共享骨架组件，统一设计落在骨架上，不落在互相模仿上。**明确不搬**：账号池（会话
文件单账号，采集形态下多账号无源）、按请求体积的可用性测试（AgnesCode 限流触发条件未实测，
不得默认与 workbuddy 上游同款）、模型逐项勾选（无真实需求前不建面）。

**存储格式漂移哨子（`format_drift`，2026-10 落地）。** 这条线吃的是从桌面 App 逆推的私有格式，App 升级随时可能改会话文件形状——此前严格模式全 miss 只会说「文件不存在」，与「没登录」同款，而更早采集的 JWT 还能用约 28 天，失效要按周计才暴露。现在：walk 发现 App 目录里有「像会话文件族」（`code-auth-session*`）却不认识形状的文件时，给独立档 `format_drift`，建议从「重登」翻成「升级本插件」；有可读 `.v1` 在旁则漂移不成立（未知兄弟可能只是 App 自留备份）。`doctor` 同持这条分类的**只读盘点**（列文件名，永不读内容、永不碰密钥），「没装 App / 装了没登录 / 登录了但格式变了」三个事实在命令行分开点名。

**AgnesCode 路由 GET 最坏时延裁定（2026-10-03 补记）**：`loggedIn` 时 `/agnescode` GET 顺序发起 balance（`AbortSignal` 30s）+ catalog（30s）两个外呼，最坏约 60s 才应答；该量级与 tab 自己的 60s 轮询节奏同阶（客户端注释「balance + roster drift slowly」即全部依据），属**有意设计**而非缺口——余额与目录都是慢变数据，为最坏时延加并发（`Promise.all`）不改变稳态节奏。若日后 BFF 挂起导致「更新于」明显陈旧，先裁定改并发，再动节奏，别反过来。

### 6.3.1 契约复测（2026-10-01 深夜，本机凭据，只读端点）

> 证据：`upstream/AgnesCode-desktop-1.0.68/probe-agnescode-credits.mjs`（与模型探针
> `probe-agnescode-models.mjs` 同目录；stdout 只带形状事实，账号级原始响应落同目录
> `credits-probe-output.json`——gitignore 区内，**永不进提交 / issue / 公开渠道**）。
> 前缀约定同本节：账号侧端点挂 `{apiRoot}`（bffBase 去 `/v1`），目录与 chat 挂 `{bffBase}`。

| 项 | 实测 | 判读 |
|---|---|---|
| `GET {apiRoot}/api/v2/subscription/credits-balance` | `200`，信封 `code` 为**字符串** `"000000"`；`data` 共 13 字段：五个余额字段（`total_balance` / `time_sensitive_balance` / `permanent_balance` / `daily_free_credits` / `subscription_credits`）+ `level`(number) / `level_name`(string) / `effect_quota_balance` / `daily_effect_quota` + **四个订阅期字段** `current_period_start` / `current_period_end` / `duration` / `cancel_at_period_end` | `fetchAgnescodeBalance` 的字符串 `code` 比对与五个余额字段读取**全部对**。四个订阅期字段是「有无订阅 / 何时到期 / 是否期末取消」的判别料——本机免费账号全 `0`/`false`，有订阅的账号形状以真机为准。信封码形态与线上逆向件文档（`code: 0` 数字）不同，以本机实测为准（[REFERENCES.md](./REFERENCES.md) §3 版本漂移纪律） |
| `POST {apiRoot}/api/v1/subscription/credits-transactions`（body `{page,page_size,filter:0}`） | `200`，`data: {pagination:{page,page_size,total}, list:[…]}`；条目键 `description` / `amount` / `direction` / `platform` / `created_at` | **插件尚未接入的流水端点**。三条形状事实：① `created_at` 是 **epoch 秒**（逆向件文档的 ISO 串是版本漂移）；② `direction` 实测 1=入账 / 2=扣减；③ `platform` 是数字枚举（入账条 `4`、扣减条 `7`）语义未明——面板接入时原样存、不翻译。`description` 值带账号级内容，只进本机文件 |
| `GET {bffBase}/models` 字段面 | 活目录字段面（行数随 `AGNESCODE_FALLBACK_MODELS`，不在此钉死；新增 `agnes-2.0-flash`：`max_input_tokens 512000` / `max_output_tokens 65536`，BFF 行内直发）；行键新成员：`thinking_toggle`（`{default_enabled, switchable_endpoints:["chat"]}`，`kimi-k3` 无此键）、`is_gray` / `gray_available`、`provider`（全 `agrouter`） | `AGNESCODE_FALLBACK_MODELS` 已随复测同步（补 `agnes-2.0-flash`，上限值取 BFF 行内声明；`test/agnescode.test.mjs` 两处 `7` 钉同步改 `8`）——兜底表与活目录在复测时点对齐，行数随 `AGNESCODE_FALLBACK_MODELS` 走、不在此写死；活目录日后增行按同纪律刷表。`thinking_toggle` 是**推理开关事实**（哪些模型可切 thinking），现行 catalog 丢弃它；是否进面板未裁，先只记事实 |
| `POST {bffBase}/v1/chat/completions` 思考 wire（2026-10-03 真机补探） | `agnes-3.0-flash`，同一道多步算术题，7 发全 `200`：① 不发任何思考字段 → `reasoning_content` 406 字 / `reasoning_tokens` 320（v1 原形状）；② `request_params.agnes_thinking_enabled=true`+`thinking_effort=high` → 327 字 / 266；③ 同 +`auto` → 398 字 / 314；④ 通用 `reasoning_effort=high` → 366 字 / 291；⑤ `reasoning_effort=none` → **257 字 / 188，思考未关**；⑥ `low` → 425 字 / 342；⑦ `medium` → 328 字 / 260 | **「BFF 默认思考关」「档位不生效」两条假设均被推翻**：默认即思考开，`reasoning_effort` 阶梯被接受。**`reasoning_effort:"none"` 关不掉思考**（仍产 188 推理 token）——真关开关是桌面端的 `request_params.agnes_thinking_enabled=false`（或 `thinking_effort:"off"`），pi-ai 的字符串档位映射表达不了它。落地：descriptor 翻 `reasoning:true` + `agnescodeThinkingLevelMap`（`off:null`、`low/medium/high` 开、`xhigh/max` 关），profile 钉 `reasoning:DEFAULT_REASONING_EFFORT`（`agnescode-models.ts` / `agnescode-llm-adapter.ts`），`test/agnescode.test.mjs` 同步钉 |
| 倍率候选端点 | `GET /v1/model-config`、`/v1/model-rates`、`/v1/models/rates`、`/api/v2/model-config`、`/api/v2/models` 全部 `404`；活目录（行数随 `AGNESCODE_FALLBACK_MODELS`）上也**无任何** `credit` / `rate` / `multiplier` / `price` / `cost` / `billing` 键 | **平台级事实（非「没读到」）**：AgnesCode 的计费口径是账号级积分池，不存在按模型倍率——与 workbuddy 的 `credits: "x0.79"` 字段是不同体系。AgnesCode tab 因此**无倍率可显示**（数据层缺席；与 §7 表「伪倍率折名不做」那条决议不是一回事——那条裁的是操作者手填 ×N，这里是 BFF 根本没出这个数据源） |

**倍率字段补记（2026-10-04，桌面端 bundle 对照 + 本机只读复探）——上表「不存在按模型倍率」需修正**：用户在桌面端模型选择器上截到真实的**每模型消耗**（`agnes-2.5-pro 1.00x` / `deepseek-v4-flash 1.20x` / `glm-5.2 1.85x` / `agnes-2.5-flash 0.00x`）。对照本机快照 `upstream/AgnesCode-desktop-1.0.68/.vite/renderer/main_window/assets/App-Br3qyjae.js`：字段名是 **`points_cost_multiplier`**，渲染为 `${points_cost_multiplier.toFixed(2)}x`，i18n 标签 `modelDetailPopover.consumption` 原文是 **"Credits per call"**（每次调用消耗的积分数）。即**平台侧确有按模型的消耗倍率**，上表「平台级事实：不存在按模型倍率」的判读**过强**——正确表述是「**该字段不在插件当前读的那条 `/models` 响应上**」。

只读复探（`probe-multiplier-field.mjs` / `probe-multiplier-endpoints.mjs` / `probe-multiplier-hosts.mjs`，均在 `upstream/` gitignore 区内）：`GET {bffBase}/models` → `200`，8 行，行键 `created,description,gray_available,id,is_gray,is_member_only,max_input_tokens,max_output_tokens,model_type,object,owned_by,provider,supported_endpoint_types,thinking_toggle` —— **无 `points_cost_multiplier`**；同 host 12 条候选路径全 `404`；`agnescode.agnes-ai.cn` 各路径 `200` 但是 Docusaurus 文档站的 `text/html` 404 页（非 API）；`app.agnes-ai.cn` 全 `404`；`api.agnes-ai.com` 全 `401`。**结论：本机凭据（免费账号）在读得到的任何端点上都不返回该字段，但桌面端确实拿到了它** → 该字段**按账号/响应分支下发**（免费账号疑似不返回，或由另一条未定位的响应携带），**不是「平台没有这个东西」**。要接入需先定位携带它的那个响应；在定位到之前，插件维持「无倍率可显示」是**正确的现状**，但理由应改为「数据源未定位」而非「平台不存在」。

**`usage.reasoning_tokens` 汇报漂移补记（2026-10-03，`test/live-agnescode.mjs --chat` 复探）**：`/v1/chat/completions` 响应的 `usage.reasoning_tokens` 不再出现——上表当日思考 wire 七发里它逐发非零（188–342），晚间 ON wire（`reasoning_effort:"high"`，`reasoning_content` 98 字）与 OFF wire（无任何思考字段，101 字）复探均观察为 **absent**。插件对该值无运行时依赖（grep 证实：仅 `src/host/agnescode-models.ts` 注释层引用）→ 属注释层单点漂移，不是 wire 漂移；ADR-009 的两条结论（默认即思考开、off 诚实不提供）经本次 live 复探**复核仍成立**。上表的 188–342 与各字符数是本机账号当日状态，不是平台常量。

## 7. 优先级与时间盒

| 优先级 | 项 | 侵入性 | 门禁 |
|---|---|---|---|
| **P0 ✅** | `index.js` 控制面解耦（§2.1：`provider-publish.js` + `snapshot-aggregate.js` 抽状态机与聚合、`index.js` 1187→778 行、5 路由 + 2 IIFE 收编） | 中（纯重构，快照契约零改动） | `test/wiring.test.mjs` F3 经新模块注入仍全绿 + `routes`/`provider`/`draw` 四套件全绿 + `e2e-gate` |
| **P0 ✅** | 推理契约自动化回归（§2.2：`test/contract.test.mjs` 进 `npm test` + `test/live-contract.mjs` live 手动档 + `test/baselines/agnes-contract.json`） | 低（纯测试基建，不碰运行时） | `npm test` 全绿；`package.json` 有 `test:live:contract` 脚本 |
| **P0 ✅** | 429 spike + 配额联动（全局策略 `llm-retry.ts` + per-model 可用性 `llm-models.ts` + `index.ts` quota 重注册） | 低（1 行 peer + peer-free 分类器 + 状态文件桥） | `e2e-gate`（dsh CLI 在则实跑）；`test/retry.test.mjs` 已落地 |
| **P0 文档** | §5 纠偏 + 本文入库 | 无（仅 doc） | `docs.test.mjs` |
| **P1 ✅** | 出图吸收（§5.4 接法 B）：`draw.ts`（peer-free：结构化识别 / 端点拼接 / 429 分诊 / 失败冷却）+ `index.ts` opt-in 接线（`drawEnabled` 默认关，无 tools 服务即缺席）；快照契约零改动 | 低 | `test/draw.test.mjs` 已落地；离线套件全绿 |
| **P1 ✅** | `doctor --json`（§5：`src/host/doctor.ts` 只读巡检 + `tools/doctor.mjs`，零平台依赖） | 低 | `test/doctor.test.mjs`（独立套件，进 `npm test`） |
| P1（可选） | §4 官方文档保真（改名/链接，不提炼不 `git rm`） | 低（仅重命名 + 链接） | `docs.test.mjs` |
| **P2 ✅ 已落地后移除（2026-10-01）** | 第二上游 provider（小浣熊 / `sensenova-raccoon`）：曾随 0.4.3 落地、2026-10-01 续做网关契约复测**契约成立**（§6.1.2），但已随 Agnes 线独立**整条移除**（兄弟插件保留该线）——移除即本项终态，无「剩余未做」 | 高（新上游 + 新凭据生命周期） | 移除时同删 `test/raccoon.test.mjs` 与全部接线/文档；`docs.test.mjs` 检查 `README_TABS` 改钉三 tab |
| **P2 ✅ 落地（2026-10-01）** | 桌面端上游 AgnesCode（§6.3）：契约探针当日落地——六件套 + `/agnescode` 路由 + 第三个 tab + `test/agnescode.test.mjs`；三路子代理审核后修复 4 条 P1（挂载种子死守卫与旧上游同款一并修、harvest 诊断行即逝、客户端 `postJsonOrThrow` 丢失败载荷、过期重采集无单飞）与一批 P2（DPAPI 超时/stdin 容错、JSON 错误带文件原文泄露、非 win32 诚实报 unsupported、钉域拒非默认端口、switch/logout 过 redactSecrets、harvest 服务端单飞、余额 null 不画 0、doctor 增读开关、render 首帧钉三 tab）、**格式漂移哨子 `format_drift`**（2026-10：walk 第 9 档直说「格式变了，升级插件」+ doctor 只读盘点三事实分点名，见上方哨子段）；**live 探针档已落地（2026-10-03）**：`test/live-agnescode.mjs`（`npm run test:live:agnescode`；凭据取 DSH 凭据服务的 `AGNESCODE_CREDENTIAL` 或 `$AGNESCODE_CREDENTIAL` 环境变量，缺则醒目 SKIP；默认 2 只读请求，`--chat` 追加 2 条计费思考探针——节奏与修法纪律比照 `live-contract`，漂移补记见 §6.3.1）；**真 DPAPI 路径已补覆盖（2026-10-03）**：`test/agnescode-dpapi.test.mjs`——Windows 真往返（本测试自己用 PowerShell `ProtectedData::Protect` CurrentUser 加密随机字节再喂 `defaultDpapiUnprotect`，32B/1024B 双档 + 垃圾输入拒绝路径），离线、不碰用户真实会话文件，非 Windows SKIP。**仍缺**：会话文件 blob 布局假设仅探针一次性验证（fixture 与实现共享同一布局假设）、macOS/Linux 采集路径未实测（非 win32 现如实报 unsupported） | 高（新上游 + 新凭据生命周期；本插件首条「本机登录态采集」形态） | `test/agnescode.test.mjs` 离线检查 + `docs.test.mjs` 检查 `README_TABS`（三 tab 全覆盖）+ render 首帧三 tab 断言 |
| 明确不做 | 多 Key / 签到 / 跨 provider 聚合 | — | — |
| 明确不做 | 伪倍率折进注册模型名（qoder ② 法：把倍率嵌进 DSH 原生选择器的模型名里，绕「选择器无旁路字段」限制）。2026-09-30 决议 | 低 | 现状即决议：`×N` 只作**面板侧标记**（模型花名册行尾 + 趋势图，同一匹配器、同一数值，均标「非官方」）。理由：① 倍率是操作者手填的对比数据、非平台计费事实，折进 DSH 全局模型名会把个人配置泄漏给所有会话；② qoder 嵌名是「DSH 无字段携带平台真实倍率」的 workaround，本插件的倍率本就没有平台出处，面板就是它唯一合理的位置；③ 模型名是 DSH 配置 / 选择器的稳定标识（id 匹配），加 `×N` 会破坏 id 语义 |

> **顺序约束**：两个 P0（§2.1 / §2.2）已落地（2026-09），是后续任何「继续吸收」的前置门禁。

## 8. 关联文档

- [ARCHITECTURE.md](./ARCHITECTURE.md) §5 — 定位与边界（本文承接，不复制其表）
- [AGENTS.md](../AGENTS.md) — 验证裁剪、红线
- [TESTING.md](./TESTING.md) — `docs.test.mjs` 孤儿文件 / 跨文件重复表规则
- [AGNES-API.md](./AGNES-API.md) — Agnes 接口全集（现行事实源：控制台额度侧 + 推理侧）
- [PITFALLS.md](./PITFALLS.md) — 改代码前避坑（§16 peer 解析、§6 凭据事故）
