# 决策账本（ADR）

**为什么有这个文件**：本插件的边界与定位裁定改过好几次。此前每次改动都在正文上盖一块「修订（日期）」内联补丁——ARCHITECTURE §5 曾因此叠出三层沉积，新读者把历史读成现行规则，文档被迫按「考古地层」维护。2026-10 起改为：**现行文档只写现状；裁定沿革一律入本账本**。

## 使用规则

- 一条裁定一个条目：`## ADR-NNN 标题`，块内必有**日期**与**状态**（现行 / 已被 ADR-NNN 取代 / 存档）。
- 改裁定 = 新增条目（标 `取代：ADR-xxx`）+ 把现行文档改写为现状表述；**不在现行正文留内联补丁**。
- 被取代裁定的原文若需要完整保留，进归档文件（先例：[ARCHIVE-BOUNDARY-DECISIONS.md](./ARCHIVE-BOUNDARY-DECISIONS.md)）。
- 门禁：`docs.test.mjs` 检查 `ARCHAEOLOGY` 扫全部非账本文档，命中「日期修订」「修订（二）」「本节裁定已失效」样式的内联考古层即红。

---

## ADR-001 定位从「额度信息面板」转向「大统一」

- **日期**：2026-09-29
- **状态**：现行（不变量正文见 [ARCHITECTURE.md](./ARCHITECTURE.md) §5）
- **裁定**：放弃「只做额度信息、n 个插件分散行动」，转向商汤全过程集成的单点入口——额度 + provider + 出图路由对接 + 429 自愈，逐块 opt-in 吸收；不做多 Key 池（同账号共享额度池，轮换无效）。
- **理由**：同类插件生态（§5.3 核实）已把「其中几块能力做成单包」变成现实；本插件是唯一既知道本 Key 实际能调哪些模型、又常驻 DSH 的组件。此前「商汤全家桶不成立」的判断废止，但爆炸半径教训（PITFALLS §6）收敛为 §5 的不变量继续生效。

## ADR-002 边界划线从「Key/认证域」放宽为「厂商归属」

- **日期**：2026-10-01
- **状态**：已被 ADR-003 取代（就适用范围而言）
- **裁定**：不变量 3 的划线依据，从「只吸收与商汤 Key/账号线强相关的能力」改为「只吸收与商汤（SenseTime）产品线强相关的能力」——按域名/认证域划线会把同厂商姐妹产品线误划界外；小浣熊第二上游由此属界内。
- **理由（三条独立举证）**：中证网 2026-07-19（U1 Pro 能力在商汤旗下小浣熊与 Seko 深度验证）、商汤官方稿件 2026-09-21（小浣熊由商汤打造）、本仓库 ROADMAP §6.1 既有措辞。原文见 [ARCHIVE-BOUNDARY-DECISIONS.md](./ARCHIVE-BOUNDARY-DECISIONS.md)。

## ADR-003 边界收窄至 Agnes 线（现行）

- **日期**：2026-10-01
- **状态**：现行；取代 ADR-002 的适用范围
- **裁定**：小浣熊第二上游整条移出本插件；现行上游只有 **Agnes 控制台（Token Plan）与 AgnesCode 桌面端**。吸收范围从「厂商归属」实际收窄为「Agnes 产品线直接相关的能力」；「厂商归属」表述仅存为历史。兄弟插件 `dsh-connect-sensenova-token-plan` 保留小浣熊线并继续演进。
- **理由**：Agnes 线独立成完整体系（登录态、目录、额度、工具、桌面端上游各自成套），带宽与爆炸半径都要求单插件不再跨产品线摊薄。面板第三 tab 因此是 AgnesCode（ROADMAP §6.3）而非小浣熊。

## ADR-004 不变量补条：一个模块缺席，不许把别的模块一起埋掉

- **日期**：2026-10-01（补记）
- **状态**：现行（正文见 ARCHITECTURE §5 第四条）
- **裁定**：opt-in 降级不变量的推论——任何「一个上游读不到」不得拖垮无关 tab。快照实现为 `quota.consoleConnected:false` 软降级 + 客户端 tab 栏无条件渲染；读不到的用量是 `null` 而非零值块（诚实性与可用性同时成立）。
- **理由**：本插件自己违反过一次——控制台读不到时整个快照 `ok:false`，把不读控制台的 API Key tab 与另一上游的 tab 一起带走。

## ADR-005 吸收准入门槛：先申报容器，再写实现

- **日期**：2026-10-02
- **状态**：现行（操作纪律见 [CONTRIBUTING.md](./CONTRIBUTING.md) §5）
- **裁定**：新能力落地前，必须在 ROADMAP/ARCHITECTURE 写明它进哪个现有文件/分册；现有结构装不下时，**先出拆分蓝图（先例 [TOKEN-STORE-SPLIT.md](./TOKEN-STORE-SPLIT.md)）、冻结行为基线，再实现**。每块都 opt-in 合规不等于整体内聚——准入门槛把结构债从「事后锐评」变成事前决策点。
- **理由**：video 吸收的实际成本高出路线图预估一个数量级（视频执行体 80 行 → 单文件 993 行，双参数家族 + 异步状态机 + 轮询预算挤在一起），账单以 `video.ts` / `routes.ts` 两个巨文件的形式先到；两者已分别按本蓝图拆分（2026-10）。

## ADR-006 client 分层边界：能算的进纯模块，画树的走产物

- **日期**：2026-10-03
- **状态**：现行（判据 1/2 已机械化：`docs.test.mjs` 检查 `RULE_LAYER_BOUNDARY`；判据 3 仍靠 review）
- **裁定**：client 侧的可测边界画在「**能算的 vs 画出树**」，不画在「领域状态 vs UI」。凡是对输入算出结论的规则——决策、格式化、优先级、折扣/促销判定、窗口标签、允许清单代数——一律放进**不 import `runtime.ts` 的纯模块**（`snapshot.ts` / `models.ts` / `format.ts` 这一层），由测试**直接 `import`** 真模块断言；只有画出元素树的组件才经由 `client-surface.js` 的捕获型 loader 物化。**规则层不得以「抓产物文本 + 在测试里抄一遍」为兜底**：那等于把双重真源换个地方放着，源码一漂照样绿。
- **判据（三条，可机械检查）**：
  1. 纯模块必须能在 Node 里被**直接 import 并调用**其导出函数——`import type { Tt } from "./runtime.ts"` 这类**类型位置**的 import 不算耦合（编译期擦除），`import { h } from "./runtime.ts"` 这类**值位置**的才算；
  2. 测试不得**从产物文本抠规则函数体**：包括「模板串定位函数头 + 花括号配平」的抽取器惯用法，以及 `new Function(<产物片段>)` 求值。判据锚**惯用法**而非函数名清单——按名清单会误伤合法用法（把规则名当 surface 键断言是引用模块面，不是抠源码），也会随规则改名静默失效；
  3. 断言规则层行为的测试，其失败原因必须是**真模块的行为变化**，不是锚点漂移——负向验证：把该规则改名或改语义，测试应因 import 失败或断言失败而红，而不是因为正则不匹配而红。
- **理由**：三家同族插件（本仓 / `dsh-connect-qoder` / `dsh-connect-sensenova-token-plan`）都做了「分层 + 纯函数 + hook 容器」，看起来差不多，但**可测边界画的位置不同**，代价差一个数量级：画在规则层的，测试永远引真模块；画在 UI 层的，最易被 UI 改动波及的规则（促销、折扣、窗口标签）留在 `.tsx` 里，Node 抓不到，只能退回「抓 bundle 文本 + 抄镜像」。而这类规则恰恰是 UI 一改就动、最需要防漂移的。本条把该边界定死，同时也解开一个伪冲突：**JSX 自由与纯层可测性并不冲突**——测试不 import `.tsx`，Node 就不必加载 JSX；组件层想断言「用户看到的」走产物/dom 路线即可。
- **三家进度对照（2026-10-03 实测，非架构差异而是迁移进度差）**：

| 项目 | 规则层位置 | Node 直测 | 残留的产物文本锚点 |
|---|---|---|---|
| 本仓 agnes | `snapshot.ts` / `models.ts` / `format.ts`，已可直 import 并调用 | 达标 | 无 `new Function` 抠 client；仅接线类源码正则（见下「残留」） |
| sensenova | `models.ts` / `format.ts` / `snapshot.ts`，已可直 import 并调用 | 达标 | 无 |
| qoder | `controller.ts` 已达标；`card-model.ts` **已抽出但未提交**（`card.tsx` 工作树减重） | 部分 | 仍在 `client-bundle.test.js` / `protocol-shape-card.test.js` 用 `new Function` 抠 `offPeakState` / `refreshNoticeKey` |

- **残留（如实记录，不得包装成已完成）**：① qoder 的 `card-host-parity.test.js` 已改为 import 真模块，但 `client-bundle.test.js` 与 `protocol-shape-card.test.js` **仍从产物抠刚被抽出去的那两个函数**——抽取只做了一半；② 本仓 `panel.test.mjs` 有两处**接线类**源码正则（`setInterval` 无字面量、`title: tt(...)` 顺序），属「effect 无法被 hook-less 替身驱动，只能拒绝第二份副本」的诚实取舍，**不属本条的打击面**；③ `panel-decision.js` 对 `canManageAccount` 与 `coolingMs` 的再推导曾是本条判据 1 的真残留——两者已改为 import 真模块（`shouldShowAccountManagement` / `servedWaitMs`），**本仓这一项已清**，逐项核实与取代关系见 [ADR-010](./ADR.md)。同段落曾把 `render` / `consoleConnected` / `needsUserAction` 一并列为残留，经核实那是**误判**：前两者是结构不同的另一个问题与纯字段读取（后者三处使用语义各不相同），`needsUserAction` 则从未分叉——清单与结论均以 ADR-010 为准。
- **判据落地（2026-10-03）**：判据 1/2 已成机器可验——`docs.test.mjs` 检查 `RULE_LAYER_BOUNDARY`：① 纯模块（`snapshot.ts` / `models.ts` / `format.ts` 等）必须能被 Node 直 import，且不得**值位置** import `runtime.ts`（`import type` 编译期擦除，不算耦合）；② 测试不得用「模板串定位函数头 + 花括号配平」从 client 产物抠函数体，也不得 `new Function(<产物片段>)`。探测器**锚惯用法而非函数名清单**——按名清单会误伤合法用法（把规则名当 surface 键断言是引用模块面），也会随改名静默失效；并自带负向对照证明探测器本身有效（PITFALLS §39）。判据 3 无法机械化，仍靠 review。
- **未完成**：qoder 两个残留测试的收敛——属另一仓库，需在该会话内完成（本仓只能记录；`RULE_LAYER_BOUNDARY` 一旦在 qoder 落地会当场点名那两处）。
- **与既有条目的关系**：本条不改变 ADR-005 的准入门槛，而是给「client 侧新规则放哪」补上事前决策点；PITFALLS §39「点名守护物而不校验守护物」是本条判据 2 的直接依据——抓产物文本的检查看着像守护，实则守护的是排版。

## ADR-007 五个额度源全部软失败（overview 不再是唯一致命源）

- **日期**：2026-10-03
- **状态**：现行（取代旧裁决「overview 唯一致命源」）
- **裁定**：控制台四源（`overview` / `series` / `subscription` / `plans`）一律软失败——失败时写入 `quota.error` 并显示来源，但不冒泡到路由的 catch；`overview` 失败时设置 `quota.consoleConnected:false` 且 `quota.totals=null`（而非零值块）。第五个源 `/v1/models`（Key 侧目录）同样软失败，但**只降级、不写 `quota.error`**：目录拉不到置 `catalogAvailable:false`（面板「可看图」行随目录缺席），这是 Key 侧语义，故意与配额侧的四源错开（`snapshot-aggregate.ts` 里 `errors: allFailures(...)` 的注释钉住这个方向）。面板据此说明「控制台未连接」，其他 tab 不受影响。
- **理由**：旧文曾写 `usage/overview` 是唯一致命源（[SETUP.md](./SETUP.md):117、[AGNES-API.md](./AGNES-API.md):66-69 旧表述），与代码实现相反。代码与测试（`test/routes.test.mjs`、`test/e2e.mjs`）早已钉死新行为。为避免读者按旧文档排查误判代码回归，需把旧裁决入账本，并在正文统一为新表述。此裁定已在 [ARCHITECTURE.md](./ARCHITECTURE.md):76-77/107-108、[API.md](./API.md):268-271 体现，现补入账本以方便后续追溯。
- **受影响的文档**：`docs/SETUP.md`、`docs/AGNES-API.md` 已同步为新表述；`docs/AGENTS.md` 红线 6 亦已改为现行表述（「overview 唯一致命源」旧裁决废止一句即见），本条待办行随 2026-10-03 核销。
- **与既有条目的关系**：继承 ADR-004「一个模块缺席不许埋掉别的模块」，将之具体化为五个额度源的软失败策略。

## ADR-008 构建产物入库：取消忽略 lib/ 与根 client.js

- **日期**：2026-10-03
- **状态**：现行（取代 ROADMAP §6.2 的「产物彻底不入库」，即 2026-09-30 当晚裁定）
- **裁定**：`lib/`（Host ESM bundle + 切分 chunk）与根 `client.js`（Client IIFE）由 `npm run build`（tsdown）从 `src/` 重建，**随库提交**——`.gitignore` 不再忽略它们。改 `src/` 后必须重建，并把产物与源码放进**同一个 commit**；CI 新增 `artifacts` job：`npm run build` + `git diff --exit-code -- lib client.js`（双跑验可复现），拦「改了 src 没重建」。`prepack` 保留（registry 发布 tarball 新鲜度不变）；**不加 `prepare`**。
- **理由**：DSH 市场 / `dsh plugin add` 的 git 直装走 pnpm git-dep 管线，pnpm 11 的 `packageShouldBeBuilt` 按「`main`（`./lib/index.js`）在克隆里是否存在」决定是否跑构建脚本——产物在库则克隆即可用（零构建、零 devDeps、零 `allowBuilds` 审批）；产物缺失则翻回「需要构建」，而 pnpm 未经 `allowBuilds` 批准不跑构建脚本，直接 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，装出来的插件没有宿主入口、卡片失效。2026-10-03 实测：`pnpm add git+https://github.com/eghrhegpe/dsh-connect-agnes-token-plan`（全新工作区、无 `allowBuilds`）在入库前撞该错、入库后 `exit 0` 且 `lib/index.js` + `client.js` 齐备。兄弟插件 `dsh-connect-qoder` 同款做法（`.gitignore` 不忽略 `lib/`，并留警告别加回）。
- **为什么不是别的修法**：加 `prepare` 会让 `packageShouldBeBuilt` 翻回 true，零配置作废（`prepare` 本身还要 `allowBuilds` 批准）；建 `pnpm-workspace.yaml` 只影响本机、改不了市场用户侧 pnpm 的行为；只修文档不解决问题。唯一可靠解是产物入库。
- **受影响的文档**：`.gitignore`（取消 `/lib/` `/client.js`，加 qoder 同款警告块）；`AGENTS.md` 验证段；`test/build-gate.mjs` 措辞（freshness 语义不变，但现在它就是「入库产物 vs 重建」的比对）；`docs/ARCHITECTURE.md`、`docs/DSH-PLUGIN.md`、`tsdown.config.mjs` 头注释、`test/docs.test.mjs` 的 `SRC_COMMENT_REFS` 注释已改为现行表述。
- **历史条目不改写**：`docs/ROADMAP.md` 的历史条目、`docs/PITFALLS.md` §32 保留 2026-09-30 / 2026-10-01 当时的记录——按考古纪律不在原文盖内联修订补丁，现行规则以本条为准。
- **与既有条目的关系**：恢复并强化 ROADMAP §6.2「新纪律」（2026-09-30 当晚被自己取代的那条「产物与源码同 commit」，见 ROADMAP.md:221-223），但动机从「build-gate 红」扩展为「git/市场直装零构建」；不改变 ADR-001~007 任何裁定。

## ADR-009 AgnesCode 思考契约：档位可用、`off` 诚实不提供

- **日期**：2026-10-03
- **状态**：现行（取代旧裁决「AgnesCode 思考 wire 通道未验证，descriptor 钉 `reasoning:false`」）
- **裁定**：AgnesCode provider 补全思考契约——descriptor 翻 `reasoning:true` 并挂 BFF 专属 `agnescodeThinkingLevelMap()`：`off:null`、`minimal:null`、`low:"low"`、`medium:"medium"`、`high:"high"`、`xhigh:null`、`max:null`；adapter profile 钉 `reasoning: DEFAULT_REASONING_EFFORT`（high），与 Token Plan 侧一致。**不提供「关思考」**——`off` 留 `null`，DSH 选择器不显示该档位。
- **理由（真机探针，2026-10-03，`agnes-3.0-flash`，`{bffBase}/v1/chat/completions`，7 发全 HTTP 200）**：推翻 v1 的两条假设——
  1. **默认即思考开**：连思考字段都不发，`message.reasoning_content` 照常返回（406 字 / 320 reasoning_tokens）。v1 的 `reasoning:false` 从没把思考关掉，只是把选择器藏了。
  2. **`reasoning_effort` 阶梯可用**：`none`/`low`/`medium`/`high` 全被接受（200），`low` 425 字 / 342、`medium` 328 字 / 260、`high` 366 字 / 291。
  - **`reasoning_effort:"none"` 关不掉思考**（仍回 257 字 / 188 reasoning_tokens）。桌面端真正关思考的开关是 `request_params.agnes_thinking_enabled:false`（非官方模型为 `thinking_enabled:false`，配 `thinking_effort:"off"`），而 pi-ai 的档位映射值是**字符串**，表达不了「在 `request_params` 里塞布尔值」。据此把 `off` 留 `null`：映射成 `"none"` 会让用户点「关思考」实际还开着——与 `PITFALLS §20` / `docs/DSH-LLM-DEVELOP.md` §4 警告的「档位映射错 = 思考被静默关」同类的静默谎言，方向相反。
- **为什么不是别的修法**：① 走 `request_params` 需要 pi-ai 支持按档位注入 provider-specific body 字段，当前档位映射模型表达不了；② `off → "none"` 是最小改动，但会制造误导性开关；③ `xhigh`/`max` 未对 BFF 实测，按「钉死值须以 live 探针为准」的纪律保持关闭，等补探后再开。
- **受影响的文档**：`src/host/agnescode-models.ts`（模块头决策 1 + 新 `agnescodeThinkingLevelMap`）、`src/host/agnescode-llm-adapter.ts`（profile 钉 reasoning）、`test/agnescode.test.mjs`（断言从 `reasoning===false` 改为 4 条）、`docs/ROADMAP.md` §6.3（新增 2026-10-03 探针行）、`CHANGELOG.md [0.8.1]`。历史表述 `docs/ROADMAP.md` §6.3 旧「thinking wire channel is unverified」按考古纪律保留，现行以本条为准。
- **与既有条目的关系**：具体化 ADR-003（Agnes 线）里 AgnesCode 那条「wire 未验证」的已知限制——探针补齐后收窄为「`request_params` 级思考开关（含 `off`）未接入」，而非「思考契约整体未验证」；不改变 ADR-001~008 任何裁定，也不改变 `docs/DSH-LLM-DEVELOP.md` §4 的通用裁法（那是对 Token Plan 侧「off→`none`」的既有裁定，此处不适用，因为两个网关行为不同）。

## ADR-010 client 视图模型的残留收敛：只有 `coolingMs` 是真分叉，另两项是原记录误判

- **日期**：2026-10-05
- **状态**：现行（取代 ADR-006「残留」段对 `panel-decision.js` 的五项指控；不改变 ADR-006 判据 1/2/3 任何一条）
- **裁定**：`test/panel-decision.js` 的 `decidePanelView` 改为调 `snapshot.ts` 导出的 **`servedWaitMs(auth)`** 报 `coolingMs`，与 `AccountForm`  obeying 的 `servedWaitUntil` 同一份判定（后者由前者换算而来）。同时候选两项**明确不改**并说明理由：`render` 与 `consoleConnected` 不是分叉。
- **为什么只有 `coolingMs` 是分叉**（逐项核实，不是印象）：
  - `coolingMs` 此前自推 `typeof retryAfterMs === "number" && > 0`，**不看 parked 标志**；而 `AccountForm` 真正 obey 的 `servedWaitUntil` 对 parked 返回「无等待」。同一份 auth 块两个答案，**实测**。且 `servedWaitMs` 与 `servedWaitUntil` 的拆法本身就是这条裁定的产物：判定（剩余毫秒）与换算（绝对期限）单位不同，合在一处时两个消费者各自漂移。
  - `render` **不是分叉**：`PanelPage` 的门是 `showSetupForm = needsSetup && loadedOnce`（`panel-page.ts`），带一个本视图模型根本没有的「首帧」状态；`decidePanelView` 的三态是为断言做的**粗化**，两者是结构不同的两个问题，不是同一判定的两份。
  - `consoleConnected` **不是判定而是字段读取**：三处分叉使用它——`panel-page.ts` 的 `openedAccountOnce` 早退（展开账户卡）、`consoleConnected === false` 三元（显示未连接提示）、`snapshot.ts` 的 `needsSetup`（是否需要 setup）——**三处语义各不相同**，把它算成「同源分写」是把「都读了这个字段」误当成「都判了同一件事」。
- **这条的净效果**：ADR-006 残留段列的五项里，`canManageAccount`（上一轮已改）与 `coolingMs`（本条）**两项是真残留并已清**，`render` / `consoleConnected` / `needsUserAction` **三项经核实不需要改**。`needsUserAction` 尤其要注意：它在 `panel-decision.js` 与 `account-form.ts` 的 `needsUserAction` 是**同一个表达式、无分叉**，此前被一并列进残留清单属连带误判。
- **验证**：`test/panel.test.mjs` 88 → **91**（新增 §F1 三条）。新增的 §F1 是**负向对照**：E 段用「窗口 + `needsUserAction: false`」、F 段用「`null` + `needsUserAction: true`」，**两段恰好都碰不到两者分歧的那份输入**——这正是它能活下来的原因。§F1 补的输入是 `retryAfterMs: 2h + needsUserAction: true`，并额外断言视图模型与规则同源。**负向验证**：把 `coolingMs` 退回旧的自推实现 → **2/91 红**（正是 §F1 那两条），还原后全绿。
- **为什么这条分叉此前不产生用户可见错误**（诚实注记，不包装成「无害」）：Host 自己**不会**下发这种形状——`inForceWaitMs` 在 parked 时恒返回 `null`（`token-store/throttle.ts`），且 parked 记录的 `until` 就是 `null`。真正可达的是**面板自己的 POST 路径**：`routes/account.ts` 把平台声明的窗口复制进响应体，而 `needsUserAction` 来自节流的 `parked` 标志，于是「验证码 + `Retry-After: 7200`」会同体给出两者（该路径已由 `a85f4b3` 修掉矛盾 UI）。所以这是**结构债而非活 bug**，但 ADR-006 已把它挂在账上，挂着不销就是账本失效。
- **与既有条目的关系**：不改变 ADR-006 判据 1（纯模块可 Node 直 import）——本条正是它的应用，`panel-decision.js` 早就在 import `snapshot.ts`（`shouldShowAccountManagement`），所以「`.js` 文件不经 import 路径」曾被当作推迟的理由是**未核实的推断**（2026-10-05 核实后更正）。也不改变判据 3（仍靠 review），但本条把 review 的结论**落成机器可验的负向对照**，缩小了判据 3 的适用面。

## ADR-011 429 误判的实证依据与「不可拆的补丁」边界，及其到期日纪律

- **日期**：2026-10-05
- **状态**：现行（取代 `docs/IMPROVEMENTS.md` §3.1 / §3.2 / §3.3 三节的承载位置；不改变 ADR-001～010 任何裁定）
- **裁定**：本条把「Agnes 限频 429 被 peer 判成 QUOTA」这条**实证链**与由此确立的三条工程边界（补丁不可复制、契约护栏、两级到期日）升为决策账本条目。2026-10-05 起原承载文件改名归档为 [`ARCHIVE-IMPROVEMENTS-2026-09.md`](./ARCHIVE-IMPROVEMENTS-2026-09.md)（内容按原样保留，不删历史），本条与 ADR-010 共同承接它的活内容。
- **实证链（本机 peer 源码逐段坐实，非假设）**：Agnes 限频 429 的 body 常带额度措辞（`quota exceeded` / `out of rate budget` 等），而 ① pi-ai 把整段 JSON body 拼进 `errorMessage`（`@earendil-works/pi-ai/dist/api/openai-completions.js` → `dist/utils/error-body.js`）；② `classifyPiAiError` **先 quota 后 rate**（`dsh-llm-pi-ai` 的 `isQuotaExceededError` 在前，`/\b429\b|rate.?limit/` 在后——限频正则实际是死分支）；③ `isQuotaExceededError` 命中面过宽（`dsh-llm/lib/types/error.js`），命中 message 文本里的硬额度措辞。三者相乘 → 带额度措辞的限频 429 被判 `QUOTA`，而 `DEFAULT_RETRYABLE_CODES` 不含 `QUOTA` → **限频不重试**，且面板把模型按 `exhaustedModelIds` 静默下线。
- **一处必须留痕的自我更正**（原稿写错过，2026-09-29 核验修订）：原稿称「正则命中 `quota_exceeded_error` 这个**类型名**」——**不成立**。正则末尾 `\b` 词边界不穿透 `_`（`_` 属 `\w`），实测 `isQuotaExceededError('"type":"quota_exceeded_error"') === false`。真正触发误判的是 429 体 **message 文本里的额度措辞**。若不更正，后来人会在 peer 已修类型名匹配后以为本插件的补丁是多余的而删掉它——而删掉的那一刻，静默漏纠会立刻回来。
- **边界一：这类补丁不可手抄多份**。`pi-ai-adapter-core.ts` 装惰性 auth 平面、图像预算与两个图像 hook、以及 429 误判纠正 Proxy。该 Proxy 是**打在不可改 peer 上的补丁**，其删除受到期日治理；手抄两份的后果是「改一处漏一处」，让某条路由带着 peer 的 429 误判继续上线。故两条路由**共用组装核心，配置分离**——与 `publish-core.ts` 对两个 publisher 的同款处理。
- **边界二：必须有契约护栏**。补丁依赖 peer 的 message 拼接格式；peer 一改 `error-body.js`（不再嵌 body 或换 type 字段名），`extractStructuredType` 抓不到 → 退回纯文本启发 → **静默漏纠**，而用固定字符串的测试察觉不到 peer 行为漂移。故 `test/peer-contract.test.mjs` 钉死端到端行为契约：peer 判 QUOTA + 含限频信号 → 本插件 `reclassifyFinish` 纠正回 RATE_LIMIT。漏纠的**精确触发面**是「message 文本含额度措辞**且**含速率信号」的临界体（结构化 type 分支能纠正，文本启发会误判真耗尽），这正是该护栏要钉的点。
- **边界三：补丁定两级到期日，不做无期的债**。① **退出证（`peer-contract.test.mjs` §E）**：抽取并执行 peer 未导出的 `classifyPiAiError` 源码体（注入其两个依赖，不重抄分支顺序），问「peer 会不会自己判对」→ 转真时打印 `EXIT-PROBE: patch-redundant` 并转红，那是**退化**信号（确认 no-op、走收紧 peer 下界），**非删除信号**。② **删除闹钟（`error-fix.test.mjs` §5，离线永远跑）**：钉住 peer 下界 `>=0.1.5`；下界一抬高（老 Host 不再被支持）即转红并给出整层删除清单。**刻意不删补丁**——它是「老 Host + bug 版 peer」的兜底，删了反而破坏向后兼容；两级设计只是把这个「刻意」变成可执行的判定，避免有人在自己机器上看到 peer 修好就顺手删掉。
- **受影响文件**：`src/host/{llm-error-fix,pi-ai-adapter-core,llm-adapter,agnescode-llm-adapter}.ts`、`test/{peer-contract,error-fix}.test.mjs`、`docs/ARCHITECTURE.md` §5.2（429 自愈的边界表述）。
- **与既有条目的关系**：不改变 ADR-001（大统一）——本条是 §5.2 那块「429 自愈」的实现纪律细则；与 ADR-006 判据 3 所依赖的那条**实测**约束（client 侧 Loader 的同步 `require` 只认平台 seed 包名，故 `client.js` 无法相对 import 任何本地模块）同族：**都是「把 peer / 平台的能力读到底，据此划定插件能做什么」的实证裁定**，不是偏好。那条约束的原文曾记于现已归档的 `docs/IMPROVEMENTS.md` §4.4（见 [ARCHIVE-IMPROVEMENTS-2026-09.md](./ARCHIVE-IMPROVEMENTS-2026-09.md)），现行表述以本条与 ADR-006 的引用为准。

## ADR-012 「大统一」把结构性爆炸半径重新集中——列为已知权衡

- **日期**：2026-10-05
- **状态**：现行（取代 ADR-001「爆炸半径教训收敛为 §5 不变量」那句留白；不改变 ADR-001～011 任何裁定）
- **裁定**：ADR-001 把插件从「额度信息面板」升级为「商汤全过程集成的单点入口」后，同进程现在一手握着四类本不该共处的东西——① LLM provider 注册与生命周期、② 出图执行体、③ 视频异步状态机、④ **解密第三方桌面端 AgnesCode 的 os_crypt/DPAPI + AES-GCM 会话文件**（攻击面最敏感的一块，见 `docs/ROADMAP.md` §6.3）。隔离纪律是真实的：agnescode 与主线 publisher 共用 `publish-core.ts` 机制、**不共用状态**；`kind:"grant"` 单点构造（`grant.ts` 的 `storeGrant`）单点判定（`grant.ts` 的 `parseGrant`）；throttle 与凭据 grant **刻意共享、不统一**（PITFALLS §23）。但「隔离到位」不等于「爆炸半径没变大」——把解密另一个 App 秘密的钥匙、provider 生命周期、出图/视频执行全部收进一个跑在用户 DSH 进程里的额度面板插件，**结构性爆炸半径被重新集中了**。
- **理由（这是 ADR-001 那句「爆炸半径教训」的现代重演形态，非新事故）**：PITFALLS §6 的历史教训是「私有状态误进凭据服务，一条 typo 就会炸掉整台机器」——那次是把错东西放进了共享的承重服务。本条目把同一类教训钉在当前形态上：共享承重面从「凭据服务」换成了「本插件自身这个进程 + 它手里的解密密钥与 provider 通道」。本次是**设计张力，不是缺陷**——§5 不变量（五源一律软失败、一个模块缺席不许埋掉别的模块，ADR-004/007）正是为此而设的主动缓解，让任何一个上游炸了都不波及无关 tab。
- **债务控制阀（可执行的术前自查，非口号）**：ADR-005 准入门槛（新能力先申报容器、装不下先出拆分蓝图、冻结行为基线再实现）是把这类结构债「从事后锐评变成事前决策点」的机制；video 吸收成本超预估一个数量级（视频执行体 80 行 → 单文件 993 行）的账单正是它拦下来的。本条目不要求拆回分散插件，但要求**任何新能力在走 ADR-005「申报容器」那一步时，先填下面这张爆炸半径对照表**——它把「大统一重新集中了爆炸半径」从账本里的已知权衡变成吸收决策的实际闸门：
  - **① 承重面归类**：新能力落在四类既有承重面（provider 注册 / 出图执行 / 视频状态机 / 桌面端密钥采集）里的哪一类？还是引入了**第五类共享承重面**？引入新类 = 自动触发 ADR-005 拆分蓝图（同 video）。
  - **② 新增共享状态**：它新增了什么跨进程 / 跨重启状态（写盘位置 / 凭据引用 / 解密密钥访问）？是否复用既有机制（`publish-core` 共用 / `grant` 单点构造 / throttle 与 grant 刻意共享，PITFALLS §23）？**不得**新开一个 state 窝点又不走拆分蓝图。
  - **③ 失败域边界**：它的失败会不会跨出自己的 tab / publisher（即会不会撞 ADR-004/007「一个模块缺席不许埋掉别的模块」）？若会，先把它改成软失败再申报。
  - **④ 基线可冻结**：行为基线能不能写进 store/routes 测试（ADR-005「冻结行为基线再实现」）？写不进基线的吸收，禁止开始。
  - 这四问任一带「引入新承重面 / 新 state 窝点 / 失败域外溢 / 基线不可冻」，都先回到 ADR-005 的拆分蓝图或降级改造，而不是带债落地。
- **与既有条目的关系**：继承 ADR-001（大统一定位）与 ADR-003（Agnes 线收窄）；具体化 ADR-005「整体内聚 ≠ 每块都 opt-in 合规」那句——准入门槛管的是「新块往哪放」，本条管的是「放进来之后整包爆炸半径的已知上限」。不影响红线①～⑦任何一条。

## ADR-013 产物命名不含内容哈希；build-gate 改为「暂存重建 + 双向比对」

- **日期**：2026-10-06
- **状态**：现行（补充 ADR-008；不改变 ADR-008「产物入库」本身，也不改变 ADR-001～012 任何裁定）
- **裁定**：① `tsdown.config.mjs` 的 host 条目加 `outputOptions.entryFileNames: "index.js"` 与 `chunkFileNames: "[name].js"`——chunk 名只由模块名决定，**不含内容哈希**。② `test/build-gate.mjs` 重写：把 `tsdown.config.mjs` **原样**复制、只改两处 `outDir` 指向 gitignored 的暂存目录，跑真实构建，再与入库产物逐字节比对（`lib/` 与根 `client.js` **两边都查**）；不再在工作树里跑 `npm run build`。
- **理由（四条独立成立，任一条都足以驱动改动）**：
  1. **改名噪音**：哈希命名下改一次源码 = git 里一对 `D` + `??`，diff 全是重命名，review 与 blame 都读不动。实测（2026-10-06）：改名后给 `src/host/codes.ts` 做一次内容变更再构建，`lib/` 6 个文件全部**原地修改**，0 个新增、0 个删除。一次性迁移成本是 5 个文件改名，此后不再发生。
  2. **CI 断言的依赖被简化**：`artifacts` job 靠「第二次构建必须无变化」验可复现。哈希命名下这条断言还依赖 chunk 内联顺序；`[name]` 下文件名与内容都只依赖源码内容。实测两次独立构建：文件名集合与逐文件 sha256 全同（0/6 差异）。
  3. **门禁不该修复它测量的东西**：旧门禁在**工作树里**跑 `npm run build`——测试跑到一半改写了它守护的入库产物；构建半途失败则留下半成品，且没有任何信号表明工作树被碰过。
  4. **旧门禁只查 `client.js`，`lib/` 的漂移完全没有门禁覆盖**：「改了 src 忘 build」在本机是绿的，只有 CI 的 `artifacts` job 会红。ADR-008 把产物变成入库承重面之后，这是该模式**唯一没有别的信号兜底**的失效模式（工作树干净、离线套件绿、typecheck 绿，装出去的是昨天的代码）。
- **为什么不是别的修法**：① 保留哈希命名、让门禁容忍改名——噪音在 diff 里，门禁消除不了它。② 内联回单文件以消灭 chunk 命名问题——peer 依赖必须 `external`，且 `lib/` 需要按模块切分。③ 给门禁加 `--fix` 自动重建工作树——那就回到了「门禁修复被测量物」，红信号消失。④ 让 CI 单独负责 `lib/` 新鲜度——CI 红之前产物已经进过 tag。
- **一条必须留痕的自我更正**（避免后来人把手抄第二份当成正确做法）：`test/build-gate.mjs` 早期版本从 `tsdown.config.mjs` **用正则提取命名方案**再重建一份暂存配置当判定基准——那仍是第二份。配置一旦漂移，门禁会报「入库有 / 新构建无」，读起来像「改了 src 忘 build」，白烧一轮排查。现行做法是直接跑**同一份**配置（只改 `outDir`）；若配置丢了门禁依赖的形状（两处 `outDir` 锚点），失败时点名缺失锚点（「0 个 host outDir 锚点，本门禁没有基准可比对」），而不是拿错基准静默比对。这条与 PITFALLS §39「探测器失配 → 两侧集合双双缩水 → 零违规假绿」是同一类病。
- **为什么 `splitting` 不是解法**：tsdown 顶层没有 `splitting` 选项（实测 2026-10-06：加 `splitting: false` 后 chunk 数与文件集完全不变，选项被静默忽略），所以「用 splitting 关掉切分」这条路不存在——`chunkFileNames` 是唯一的命名手段。
- **验证**：`test/build-gate.mjs` 16/16 通过；负向对照 4 例全红——① 改一个 chunk 的字节 → `content changed: llm-adapter.js`；② 删掉入库 chunk → `tracked but absent from the rebuild` + `in the rebuild but not tracked`；③ 删掉 `client.js` → 存在性与新鲜性两条同时红；④ 改 host 的 `outDir` → 响亮报锚点缺失。
- **受影响文件**：`tsdown.config.mjs`（host 条目加 `outputOptions`）、`lib/*.js`（5 个改名 + `index.js` 内容）、`test/build-gate.mjs`（重写）、`.gitignore`（忽略 `.build-gate.config.mjs`，暂存目录落在已忽略的 `tmp/`）、`docs/ARCHITECTURE.md`、`docs/DSH-PLUGIN.md`、`docs/TESTING.md`、`docs/ROADMAP.md` §6.2、`.github/workflows/ci.yml`（两处 pnpm 理由措辞 + 可复现性表述）。
- **与既有条目的关系**：不改变 ADR-008 任何一项——产物仍随库提交、仍**不加 `prepare`**、`prepack` 仍保留、CI 仍有 `artifacts` job。本条只降低该模式的日常维护成本，并把它唯一的失效模式（`lib/` 漂移）补进门禁覆盖。

## ADR-014 快照取数并行化：`overview` 折进批量（取代 §3「串行先取」表述）

- **日期**：2026-10-10
- **状态**：现行（取代 `docs/ARCHITECTURE.md` §3 的「`overview` 串行单独先取」表述；不改变 ADR-007「五个额度源一律软失败」与 ADR-004 不变量 3）
- **裁定**：`snapshot-aggregate.ts` 的五源取数由「`overview` 先行 + 四源 `Promise.all`」改为**五源同一 `Promise.all`**；`test/routes.test.mjs` B 组的钉从「死令牌恰好被出示一次」换成「**每个认证源至多出示一次死令牌 + 每次轮询至多一次登录**」。连带同族的两处慢点一并并掉：`/agnescode` 路由的 balance 与 catalog 两个上游读改并行（最坏 60 s → 30 s）；**API tab 三个写卡片（provider 开关 / 模型清单 / 两个工具卡）与 AgnesCode 三动作**的「保存后全量 `load()` 回显」改为把 POST 响应体（Host 写后态）就地并入快照 `llm` 块（`PanelPage.echoLlm`）或整包 `setState`；AccountForm 与 ApiKeyForm **有意保留**全量 load（登录与换 Key 是真正需要整体重取的时刻）。
- **理由（两条独立成立）**：① **串行形状在失效账号下把超时链叠加**：`overview` 的登录链（`requestTimeoutMs` 15 s）叠在批量超时（`consoleTimeoutMs` 15 s）之上——单次快照最坏 30 s 起（401-dance 全超时链 ~45 s），轮询周期却是 30 s；叠加 API tab 的保存/开关回显走同一条全量路由、AgnesCode 侧 30 s + 30 s 顺序 BFF 读，两个 tab 的操作反馈全被拖在慢路径后面（用户实测：积分刷新失败前其它两 tab 无视觉反馈）。并行把最坏从「和」压到「max」。（早期排查一度归因到浏览器 6-connections 连接池排队——**经 grep 不采纳**：GUI 主 bundle（`dsh-web-frontend` 的 index / vendor 各 ~600–740 KB）长连接句型零命中，`dsh-client-hmr` 的 EventSource 仅 dev watcher 下运行，池是否吃紧不可证实；可证因果只有上面两项。）② **串行给的两样好处在并行下各有承接**：换新令牌靠 `getToken` 单飞（`token-store.ts`——并发 acquire 共享一次 login，防锁号纪律不变）；`not_configured` 仍是各源本地失败、零往返（并行不产生新请求）。
- **竞态核实（不是推断）**：`invalidate(token)` 只把被拒令牌记入有界 `rejected` 集并清空内存 grant——后到的源 invalidate 误清已愈合缓存时，`acquire` 的 `readStored` 从凭据服务读回已持久化的新鲜 grant，且 `isFresh` 只拒 `rejected` 集内的令牌（新令牌不在集内），**不会**触发第二次登录（已对 `invalidate`（token-store.ts:203）/ `readStored` 持久读（grant.ts）/ `isFresh` 的 rejected 过滤（grant.ts:173）/ `acquire` 快路径（acquire.ts:77）逐处核实）；`fetchConsole` 的 401 舞蹈每飞行至多一次（present → renew → retry，不递归），所以「每源一次出示」在并行下依然成立。
- **验证**：`routes` 200/200（B 组新钉：3 出示 / 1 登录）、`agnescode` 180/180、`panel` 91/91、`render` 273/273、`contract` 122/122、`provider` 220/220、e2e 66/66；typecheck 与 build-gate 绿。
- **受影响文件**：`src/host/snapshot-aggregate.ts`（五源并行 + 注释）、`src/host/routes/agnescode.ts`（balance/catalog 并行）、`src/client/{panel-page,provider-controls,model-picker,wire,agnescode-tab}.ts`（`echoLlm` / `LlmEchoPatch` / 各卡片回显 / AgnesCode 整包应用）、`test/routes.test.mjs`（B 组新钉）、`docs/ARCHITECTURE.md` §3（框图 + 段改写）、`docs/PROVIDER-HOT-RELOAD.md`（回显形状注记）、`docs/AGNES-API.md`（探针句修正）、`CHANGELOG.md` [0.11.0] 段（归位：该批次在 0.10.2 发布后的补记提交里曾误记在 [0.10.2] 段，0.11.0 时移回）、本账本条目、`lib/` + `client.js`（随 src 同 commit 重建）。
- **与既有条目的关系**：继承 ADR-004/007（软失败形状不变：`overview` 失败仍只落到 `quota.consoleConnected:false` + `quota.error`，tab 栏无条件渲染不动）。B 组旧钉「恰好一次」保护的是**登录次数**——该不变量改由「登录至多一次 + 单飞」承载（真守卫），「出示次数」降为旧串行形状的痕迹，随本条退役。不影响红线①～⑦。

## ADR-015 目录刷新的节拍归宿主：`GET /snapshot` 不再携带控制面副作用

- **日期**：2026-10-17
- **状态**：现行（取代「目录落盘 + provider 重建是快照路由的副作用」这一既有形状；不改变 ADR-007 五源软失败、ADR-004 不变量 3，也不改变 ADR-012 的四类承重面划分）
- **裁定**：`/v1/models` 的「取 → 落盘 → 重建注册」整条链搬进 `src/host/catalog-refresh.ts`（`createCatalogEffects`），由**宿主**按 `pollSeconds` 自行节拍；`GET /snapshot` 保留「我这次取到的目录立刻生效」这条路（面板开着就是即时刷新），但不再是唯一的节拍来源。写入侧只有**一个**入口（`run`），路由与 tick 共用同一个实例，串行链保证「签名检查 + 它守护的那次写」不可交错。**后台调用者不申报允许列表**：tick 与快照路由传 `undefined`（= 保留磁盘上那份），只有 `/models` 的保存才显式下发列表——刷新不得覆盖它没做过的保存。
- **为什么（缺陷是「浏览器就是宿主的时钟」）**：此前 `applyCatalogEffects` 只被 `buildSnapshotBody` 调用，而 `buildSnapshotBody` 只被 `GET /snapshot` 调用。于是进程里的模型发现完全由**谁在轮询**决定：面板关掉、也没有会话跑在 `agnes-*` 模型上时没人轮询，平台新上的模型在整个进程生命周期里都看不见，重启才恢复。同一形状还带来第二个问题——两个客户端同时轮询时，两边都能在同一个 `await` 前读到旧签名，于是**同一次目录变更被落盘两次、发布两次**（`publisher.publish` 自己排队，但它前面的签名读取不排队）。缓存与单飞去重的是**请求**，不是**写**。
- **容器申报（ADR-005）**：进新文件 `catalog-refresh.ts`，不进 `snapshot-aggregate.ts`——后者是「纯聚合」，把定时器塞进去会让它重新长出 I/O（PITFALLS §50 记的正是这条边界被注释假装掉的历史）。写入逻辑是 `applyCatalogEffects` 的逐字搬运（签名判等 → `catalogStore.replace` → 只在落盘成功时推进签名 → `publisher.publish` → `quotaSignature` 翻转分支），行为基线由 `test/catalog-refresh.test.mjs` 冻结，`test/routes.test.mjs` 组 S 仍从路由侧钉同一条不变量。
- **节拍：多久一次**。tick 周期 = `settings.pollSeconds`（默认 30 s），与面板同一口径——「多久看一眼」本来就是同一个数，两个消费者共用一个值才不会互相打脸。**但实际上游请求率不由它决定，由 `CATALOG_CACHE_MS`（1 小时）决定**：缓存新鲜时 tick 只是一次 `Map` 查找，所以面板关着时最多 **24 次/天** `/v1/models`，面板开着时两边命中同一条缓存条目（请求数不增）。这是本条最关键的量化前提——没有它，「宿主加定时器」就等于给上游加了一条无人监督的轮询线。**它只对成功路径成立**：`sharedFetch` 只在成功时写缓存，所以网关一旦拒绝，那条缓存永远停在「过期」上，节拍本身就成了重试率——失败路径由下一条的退避界定（实测：网关整小时拒绝，从 120 次/小时降到 ≤8 次/小时）。
- **开关：只在哪些条件下跑**。① **没有推理 Key 就完全不打**：`refresh` 在「无 Key」出口直接返回，后台零流量（这也是本条**不加新配置键**的理由——「关掉后台刷新」已经有了现成的、语义正确的做法：不配 Key，而那时目录本来就无处可取）；② **配置行坏掉（`configError !== null`）不启动**：坏行不该派生一个后台轮询器，而且解释错误的面板必须照常工作；③ **首个 tick 延后一个周期**：`apply()` 目前挂载期零网络（seed 只读盘），一个起停都在 30 s 内的 Host 不该留下一次网关请求；面板开着时第一次取数由路由即时驱动。
- **失败怎么退避**。四类失败各自就地软失败，不冒泡、不重试放大：① **网关失败**（`fetchCatalog` reject / 非数组）→ 保留已落盘的目录与既有注册，什么都不改，并**指数退避**：`retryDelayMs(n) = min(30 s × 2^(n−1), 15 min)`，稳定后 4 次/小时；失败 streak **只在首次记一行**、恢复时再记一行（逐次记会把请求洪泛换成日志洪泛）。没有这条退避，「网关拒绝」就是唯一会让 tick 按节拍打上游的形状——缓存永不新鲜，实测 120 次/小时、2,880 次/天，而且完全静默；② **无 Key** → 记忆 60 s（`NO_KEY_RETRY_MS`），否则「没配 Key」是另一个永远填不满缓存、因而永远走不到廉价出口的形状，会变成每 30 s 一次凭据服务读取（2,880 次/天 → 1,440 次/天）；③ **落盘失败** → 不推进签名，下次 tick 重试（PITFALLS §40，原样保留）；④ **发布抛错** → tick 的 catch 记一行日志，绝不让异常逃进 Host。节流/锁号纪律不适用：这条链**只读推理 Key、不碰控制台**（不登录、不进 `token-store` 的节流窗口）。
- **爆炸半径四问（ADR-012）**：① **承重面归类**：不引入第五类——落在既有的「provider 注册」这一类，且**缩小**了它的触发面（写入从 N 个路由调用收敛到一个实例）。② **新增共享状态**：零个新 state 文件、零个新凭据引用；唯一的进程内新增是 `noKeyAt` 时间戳与一个串行链，都随实例消亡。③ **失败域边界**：撞不上 ADR-004/007——四类失败全部就地降级，最坏结果是「目录停在上一版」，不碰 `quota` 的任何源，也不碰另外两个 tab。④ **基线可冻结**：`test/catalog-refresh.test.mjs` 48 条覆盖写入串行、§40 签名、两个廉价出口、四类失败、退避日程、后台不申报列表，以及定时器的启停/`unref`；负向对照七项全红（去串行链 → A5 红；写失败仍推进签名 → A4 红；首 tick 立即执行 → C1/C3/C4b 红；去掉无 Key 记忆 → B3 红；去掉退避闸 → D1/D1b/D2/D2b/D3 红；逐次记日志 → D4 红；后台断言自己读到的列表 → B7/B8 红）。
- **为什么不是别的修法**：① **只给路由加去抖**——缺陷是「没人轮询就没人发现」，去抖治不了没有调用者。② **让面板在后台保持轮询**（例如隐藏 tab 继续跑）——把宿主的时钟继续交给浏览器，且用户关掉窗口就没有宿主了。③ **新增 `catalogRefreshSeconds` 配置键**——多一个「多久一次」的真源，而它想解决的问题（后台流量）已由「无 Key 即零流量」+ 1 小时缓存界定；真要更慢，`pollSeconds` 就是那个旋钮（代价是面板也变慢，这是诚实耦合）。④ **把 tick 放进 `startSideEffects`**——那里全是 fire-and-forget、没有返回值可以交给 `teardown`；定时器必须**能被停**，所以它的 stop 函数直接进 unmount 链。
- **受影响的文件**：`src/host/catalog-refresh.ts`（新）、`src/host/{index,snapshot-aggregate,types,lifecycle}.ts`、`src/host/routes/snapshot.ts`、`test/catalog-refresh.test.mjs`（新）、`.github/workflows/ci.yml`（offline job 套件清单）、`docs/ARCHITECTURE.md` §2/§3、`docs/TESTING.md`、`CHANGELOG.md`、本账本条目、`lib/`（随 src 同 commit 重建；`client.js` 不变——这条链不碰 client 半边）。
- **历史表述不改写**：`docs/PITFALLS.md` §40 与 §50 里的 `applyCatalogEffects` 是当时的事实记录，按考古纪律保留原文；它的现行地址是 `catalog-refresh.ts` 的 `runNow`。
- **与既有条目的关系**：ADR-005 的容器申报在本条被真正用了一次（先出文件与基线，再实现）；ADR-012 的四问首次有了一份填完的实例。不改变 ADR-001～014 任何裁定。

## ADR-016 本地 stats 存储补每客户端用量段，推翻「不记 token/轮次」旧裁法

- **日期**：2026-10-18
- **状态**：现行（取代同日「每日额度事实透出 + 本地限流症状记录」段里「不记 token/轮次」那半句；不改变限流症状记录本身，也不改变 ADR-007/004 软失败不变量）
- **裁定**：`src/host/agnescode-stats-store.ts` 在既有 `rateLimit` 段旁新增 `usage` 兄弟段，记本插件自身的**每轮用量**（请求次数 + `input`/`output`/`cacheRead` token，按本地日聚合、同一 30 天窗口）。`STATS_VERSION` 保持 1：新段是可选的，两个读路径各自忽略不认识的段，升版只会白白丢掉既有 `rateLimit` 历史。观测钩是 `reclassifyStream` 新增的第二路 `onUsage`（收流上每个 `usage` chunk，与只收 finish 的 `onRateLimit` 正交）。全零轮次跳过，不虚增请求数。面板与胶囊各显示一行「经本插件：今日 N 次 · X tokens（其中缓存 Y）」。
- **理由（旧裁法为何作废）**：同日早先的裁定以「平台无 token 口径可读；本地自记会漏桌面 App 消耗而严重低估」为由拒绝记 token。它**混淆了两个不同的问题**——「我的账号一共花了多少」（credit 流水 `ledger` 的职责，含桌面 App）与「我经本插件的调用花了多少」（读者真正在问、且兄弟插件 qoder/trae 都在透出的数）。修法不是藏起这个数，而是**限定并标明口径**：label 写死「经本插件 / via this plugin」，账号总量继续留给流水。带对口径标签的数是诚实的；同一个数没标签，才是旧裁法真正要防的那个谎。兄弟插件 qoder 的「今日经本客户端请求 N 次 · 消耗 X tokens」正是「诚实 + 有用」可以并存的实证。
- **胶囊侧的连带**：本条同时是「积分余额胶囊 2026-10-18 简化」放回来的**唯一**一行——那条简化把 grants/限流/流水三行页脚与昵称从 28px 胶囊移除（它们是页脚、且免费账号读起来是一片 0）；用量行不属于被移除的三行，它是本客户端自身流量、是余额之外读者扫一眼就想要的那个数，且无记录时不渲染，故不回填空态杂乱。
- **受影响的文件**：`src/host/agnescode-stats-store.ts`（`usage` 段 + `recordUsage` + `readUsage`）、`src/host/llm-error-fix.ts`（`reclassifyStream` 加 `onUsage`）、`src/host/pi-ai-adapter-core.ts` + `src/host/agnescode-llm-adapter.ts`（透传 + 落盘）、`src/host/routes/agnescode.ts`（GET 带 `usage`）、`src/client/{wire,agnescode-tab,composer-usage-pill,index,i18n}.ts`（读数 + 文案 + 胶囊行）、`test/{agnescode-stats,agnescode,dom-render}.test.mjs`、本账本条目、`docs/ROADMAP.md` 同日段、`README.md` 胶囊段、`lib/` + `client.js`（随 src 同 commit 重建）。

## ADR-017 agnes-2.5-pro 的思考档位阶梯与 3.0-flash 不同：`high` 按模型映射到 `xhigh`

- **日期**：2026-10-18
- **状态**：现行（细化 ADR-009；不改变其「档位可用、`off` 诚实不提供」两条结论，只按模型修正档位映射）
- **裁定**：`agnescodeThinkingLevelMap(id)` 改按模型：`agnes-2.5-pro` 返回 `{off:null, minimal:null, low:"low", medium:"medium", high:"xhigh", xhigh:"xhigh", max:null}`；其余 id 保持共享阶梯（`high:"high"`、`xhigh:null`）。**`high` 必须保留在 supported 集合里**——profile 钉 `DEFAULT_REASONING_EFFORT`（"high"）是 provider 级，dsh-llm-pi-ai 的 `resolveReasoningLevel` 对不在模型 supported 集合内的档位直接抛 `UNSUPPORTED_REASONING_EFFORT`（无 clamp，`lib/index.js` 1701-1705），关掉 `high` 会让该模型每次请求本地即败——但 wire 拼写改为平台接受的 `xhigh`（同时是该模型的平台默认）。
- **理由（真机 400，2026-10-18，`agnes-2.5-pro`，`{bffBase}/v1/chat/completions`）**：用户会话选 `agnes-2.5-pro` + 默认「高」档失败，平台原文 `litellm.BadRequestError: OpenAIException - Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low`——该模型的 BFF 阶梯**没有 `high`**，顶层是 `xhigh`（也是默认）。与 ADR-009 的 3.0-flash 探针（`none`/`low`/`medium`/`high` 全 200）对照：**阶梯按模型不同，全 provider 共享一张映射是错误抽象**。`xhigh` 一并打开：同一段 400 原文证明平台接受它（3.0-flash 的 `xhigh` 仍无证据，保持关闭）。
- **为什么不是别的修法**：① `high:null` 会让 provider 级 Default "high" 对 dsh-llm-pi-ai 抛 `UNSUPPORTED_REASONING_EFFORT`——本地即败，比上游 400 更糟；② 把 profile 默认档位改成 `xhigh` 是 provider 级改动，会让 `agnes-3.0-flash`（`xhigh` 未探通）的 Default 失效；③ 显示层「高」标签 = `defaultEffort`（provider 级），per-model 改标签需要 pi-ai 支持按模型默认档位，当前档位模型表达不了。故只在 wire 拼写层修正，标签不动——「高」对 2.5-pro 即「平台默认档」，语义诚实。
- **受影响的文档**：`src/host/agnescode-models.ts`（`agnescodeThinkingLevelMap(id)` per-model + 模块头决策 1）、`test/agnescode.test.mjs`（新增 agnes-2.5-pro 断言块）、`docs/ROADMAP.md` §6.3.1（新增 2026-10-18 探针行）、`CHANGELOG.md`（[Unreleased]）。ADR-009 原文按考古纪律保留不改写。
- **与既有条目的关系**：细化 ADR-009 的档位映射（该裁定以 3.0-flash 探针为基础，未覆盖 2.5-pro 的阶梯差异）；不改变 `docs/DSH-LLM-DEVELOP.md` §4 的通用裁法（Token Plan 侧 `thinkingLevelMapFor` 未动）。

## ADR-018 agnescode 识图默认放行：没证据的行也收图，但面板必须说「未实测」

- **日期**：2026-10-22
- **状态**：现行（实现见 `src/host/agnescode-models.ts` 的 `AGNESCODE_VISION_DENYLIST` / `agnescodeVisionVerdict` / `agnescodeVisionSource`，`agnescodeRoster` 把 `vision` 与 `visionSource` 一起透出；面板 chip 见 `src/client/agnescode-tab.ts`；门禁见 `test/agnescode.test.mjs` 的判定阶梯段与 `test/dom-render.test.mjs` 的 chip 段）
- **裁定**：判定阶梯四级——**实测否决集 → 行内声明 → `PROBED_VISION` 实测表 → 默认放行（`assumed`）**。前三级给面板一个朴素 chip；`assumed` 必须画成「可看图·未实测」并带 tooltip；否决项画 `vision:false`、无 chip。换言之：**默认值是「给它图片」，唯一能否掉它的是带日期实测的否决条目**。
- **理由**：网关 `/models` 的每一行都只写 `model_type: "text"`，从不说自己能不能看图（`fetchAgnescodeCatalog` 因此钉死 `vision:false`——那是 wire 事实，不是判决）。旧逻辑把「文档表里没有」读成「不支持」，于是网关每上一次新模型，图片入口就静默消失一次：用户看不到任何提示，只能自己发现并来报。这条失效方向是不可见的（能力缺失不像错报那样会在会话里露头），而错报在当前网关是可观测的：模型收到图片后自述看不见，HTTP 仍是 200。
- **代价与护栏**：默认放行把失效方向翻成「错报」，但没有翻成「谎报」——`visionSource` 让面板把未实测的行标出来，读者因此知道这是插件的默认，不是平台的声明。否决集是唯一维护面：发现某模型自述看不见，就把它带日期加进 `AGNESCODE_VISION_DENYLIST`。
- **边界**：只动 agnescode 这条上游；Token Plan 侧 `identifyVisionModel`（按 `/v1/models` 的 `input_modalities` 判定）不受影响，两侧判定函数不合并。`AGNESCODE_FALLBACK_MODELS` 的 `vision` 列是手写快照，不经过本判定函数；`visionSource` 只影响面板显示，不改变 descriptor 的 `input` 数组长度约定（`vision:true` → `["text","image"]`）。
- **复核条件**：若网关开始在 `/models` 里声明模态（`input_modalities` 或视觉标签），第二级（`declared`）就会接管绝大多数行，`assumed` 退化为稀有位——那时本条仍然成立，只是很少被用到。若哪天实测发现「未实测默认可看图」在本网关的错报代价高到不可接受（例如图片被静默吞掉且模型照常编造），把默认改回 `false` 并把本条的 `assumed` 换成一个显式的 `unknown` chip。

## ADR-019 网关新增模型走胶囊的「· N 新模型」，不弹窗、不留确认态

- **日期**：2026-10-22
- **状态**：现行（实现见 `src/host/agnescode-roster-seen-store.ts` 的首次见到历史、`src/host/routes/agnescode.ts` 的 `newModelIds` 差分、`src/client/composer-usage-pill.ts` 的 AgnesCode 胶囊段；门禁见 `test/agnescode.test.mjs` 的两个新段与 `test/dom-render.test.mjs` 的胶囊三帧）
- **裁定**：网关目录里出现本机没见过的 model id 时，**只在胶囊上多一段「· N 新模型」**（tooltip 与 popover 给名字，最多列三个），不弹窗、不阻塞、不留「已读」按钮。判定基准是插件自己写的首次见到文件 `agnescode-roster-seen.json`：**首次写入是播种（整表记为已见、一条都不报）**，之后新增的 id 记为「现在」并保持 7 天，离开目录的 id 从表里删除（重新上架算新）。
- **理由**：DSH 的 Host 面没有通知/弹窗服务，插件的可见面只有插件卡与胶囊；而胶囊本来就是读者扫余额的地方，把「网关多了个模型」放在余额旁边是同一类信息（都关于「现在能用什么」）。播种是必须的：升级后的第一次运行会把当时整张目录写成历史，否则每个老用户都会被告知全部七个模型都是新的——那是噪音，不是提醒。
- **为什么不是弹窗 / 已读态**：弹窗需要用户处理，而「多了个模型」不需要处理；已读态需要一个点击，等于把一个纯信息变成一次任务。7 天窗口是提醒的寿命：够长到用户会看见，够短到不会永远挂着。重上架的 id 再报一次，因为那说明这一行背后的东西换过手，值得知道。
- **边界**：只在 `modelsSource === "live"` 时差分——回退快照表是插件自己的六行文本，拿它差分会在登录/离线那几帧凭空造出「新模型」。差分对象是**整张 live 目录**，不是用户勾选的子集：某个模型是不是网关的新闻，与这台机器勾了哪些框无关；拿子集差分还会让一个上架很久的模型在「被勾上」的那天冒充新模型。`newModelIds` 缺席（旧生产者、离线、首次播种）时胶囊什么都不画，不画空段、不留悬空分隔符。该标记只出现在 agnescode provider 被选中的胶囊上；Token Plan 侧名册没有这个字段。
- **复核条件**：若网关开始提供「上架时间」字段，差分就应改成读那个字段，本文件降级为离线兜底；若 DSH 之后提供通知服务，这段可以迁过去，胶囊只留计数。

## ADR-020 AgnesCode 桌面源开关：两个源一个槽，读时仲裁（raccoon §6.1.11 镜像）

- **日期**：2026-11-18
- **状态**：现行（细化 AGENTS.md 事实 3「采集/续期/撤销」段；不改变红线①～⑦、ADR-004/007 软失败不变量，也不改变 AgnesCode 与主 provider 的隔离裁定 §5.5）
- **裁定**：AgnesCode 凭据从「两条写路径共一个槽（最后写入者胜）」升级为**「两个源、一个槽、读时仲裁」**，镜像兄弟插件 `dsh-connect-sensenova-token-plan` 的 raccoon §6.1.11（官方客户端只读源开关）：
  1. **新开关**：`agnescode-desktop-source.json`（共享 `switch-store.ts` 工厂，profile 级 §23 纪律），**opt-in 默认关、面板独占**（dialect B：无配置默认值，面板说开才是开），与 provider 开关 `agnescode-provider.json` 各自独立文件（一次翻转不得触碰另一家的发布决定）。
  2. **读时优先级**（`createAgnescodeStore.resolve()`，不是模式切换）：开关**开**且桌面会话文件视图**新鲜**（JWT `exp` 距到期 > 60 s 引导窗，`AGNESCODE_DESKTOP_LEAD_MS`）→ 供 `desktop-file` 视图凭据；其余一切情况（关 / 文件缺 / 读不动 / 无 `exp` / 已过期 / 平台不支持）→ 落回槽内凭据（`credentials` / `memory`），**关掉源从不丢登录**。
  3. **只读视图**（`src/host/agnescode-desktop-view.ts`，peer-free）：桌面文件是 App 的记录所有人，本插件是它的**视图**——不刷新、不回写、**不把视图凭据拷进 DSH 凭据服务**（槽里只有显式 `save()` 的产物：harvest 覆盖写 / 扫码登录）。缓存纪律：stat 键控成功缓存（会话文件 + Local State 的 mtime/size 不变即免重走 walk，DPAPI 子进程只在 miss 时出生）+ 单飞 + 失败退避 60 s（`AGNESCODE_DESKTOP_VIEW_BACKOFF_MS`，与 lifecycle 重采集退避同号异主）；失败不缓存（文件改名中不得粘住 TTL）。
  4. **封闭 reason 集**（视图对面板的回答，绝不含路径/尺寸/解析片段）：harvest 九档 tier 直映（`file_missing` / `format_drift` / `unreadable` / `no_key` / `decrypt_failed` / `malformed` / `no_token` / `untrusted_base` / `unsupported_platform`）+ `no_expiry` / `expired`（成功解密但过期判决）+ `read_failed`（walk 抛错）。
  5. **跨 base 重发布泛化**：`resolveToken` 的跨账号 BFF base 重建原只在重采集成功路径上跑；改由 store 供凭据的 `bffBase` 与 publisher 现行 base 对比——**视图源与槽源共用同一条重建链**（桌面 App 换账号、扫码登国际站账号等场景不再让旧 base 带着新 token 打 401）。
  6. **面板**：AgnesCode tab 凭据卡内第二个开关行「使用桌面端登录态（只读）」+ raccoon 同款 live/idle 两行（`desktopLive` / `desktopIdle` + reason 字典）；`/agnescode` GET 增 `desktopSource: {enabled, serving, reason?}`，POST 增 `{action:"desktop-source", enabled}`（写后走 `publishFromStore()` 全量回显，与既有三动作同纪律）。
- **理由（现状的三个缺口，缺一个都足以驱动）**：① **槽内凭据只在过期时才被重采集**——桌面 App 提前轮换 token 或换账号登录时，槽里的旧 token（未过期）继续被服务，直到上游 401 才触发重走；读时仲裁让「App 文件新鲜 = 直接跟随」，App 是登录态的真源，插件不再抱快照（raccoon 原文：「the panel FOLLOWS the App instead of holding a snapshot of it」）。② **两条写路径无优先级**——harvest 与扫码登录共槽、后写者胜，读者无法表达「我要以桌面端为准、扫码只是兜底」；③ 兄弟插件 raccoon 已有此形状（§6.1.11，2026-11-17 翻转 §6.1.10），两仓同族纪律漂移本身就是缺陷面。
- **爆炸半径四问（ADR-012）**：① **承重面归类**：落在既有第四类「桌面端密钥采集」内，零新承重面——视图只读、开关走既有 switch-store 工厂、不碰 publisher 共享机制（隔离 §5.5 不变）。② **新增状态窝点**：一个 state 文件 `agnescode-desktop-source.json`（switch-store 工厂统一纪律：版本化载荷 + 原子写 + §23 共享目录一次性继承 + doctor 盘点行）；视图缓存与退避计时器是进程内对象，随装配消亡，不落盘。③ **失败域边界**：全软失败——视图读失败只在本 tab 内降级为「用槽内凭据」，reason 行可诊；开关默认关，未开机的机器行为与今日逐字节相同（现有测试全绿即基线）；不碰 Token Plan 五源、不碰出图/视频。④ **基线可冻结**：store 优先级 + 视图行为先落 `test/agnescode.test.mjs` 扩展段与 `test/agnescode-desktop-view.test.mjs`（注入式离线，DPAPI/时钟/文件全部可注），开关商店进 `test/switch-store.test.mjs` 第五项共享行为清单。
- **为什么不是别的修法**：① 把桌面文件读取并进现有 harvest 按钮（用户手动点）——raccoon 形状的价值正在于**每次读自动跟随**，手动按钮是快照，不是视图；② 开关做成「登录方式互斥」（选桌面即禁止扫码）——丢登录的开关违反 raccoon 同款不变量「切源永不丢登录」；③ 视图凭据入库（拷进凭据服务）——副本一旦与 App 文件漂移就是「别人登录态的一具过期尸体」（raccoon 原文），且「读」从此不再读 App，App 换账号插件不知道；④ 不加开关直接让桌面文件永远优先——行为静默改变所有现有装机（后写槽内扫码凭据的人发现自己打的是桌面账号），违背 opt-in 家族纪律。
- **撤销语义（与 provider 开关并列钉死）**：关**源**开关 ≠ 丢凭据（槽原样、App 文件原样）；关 **provider** 开关 ≠ 吊销（重开即复用）。真吊销仍在桌面 App 内登出/改密码，或操作者手删 `AGNESCODE_CREDENTIAL` 记录——插件侧采集写权限为零的裁定不变。
- **受影响的文件**：`src/host/agnescode-desktop-view.ts`（新）、`src/host/agnescode-store.ts`（优先级 + `state()` 源事实 + `desktopSource` 依赖）、`src/host/agnescode-switch-store.ts`（第二开关）、`src/host/agnescode-lifecycle.ts`（跨 base 重建泛化）、`src/host/agnescode.ts`（walk 排序器导出，单一真源）、`src/host/{switch-store,switch-precedence}.ts`（头注四→五开关）、`src/host/routes/agnescode.ts`（GET 块 + POST 动作 + 400 尾行）、`src/host/{index,types,doctor}.ts`（装配/线型/盘点行）、`src/client/{wire,agnescode-tab,i18n}.ts`（状态字段 + 开关行 + live/idle 行 + 中英文案）、`test/{switch-store,agnescode,agnescode-desktop-view,routes,wiring,doctor,dom-render}.test.mjs`、本账本条目、`docs/{ROADMAP,API}.md` + `AGENTS.md` 事实 3、`lib/` + `client.js`（随 src 同 commit 重建）。
- **与既有条目的关系**：镜像兄弟仓 `dsh-connect-sensenova-token-plan` ROADMAP §6.1.11（其 §6.1.10 的「不做」翻转先例）——两仓各自实现同一形状（凭据/store/publisher 隔离纪律下不共享代码，§5.5）；继承 ADR-005 申报（新容器 = 视图模块 + 一个 state 文件，均已先于实现落账）与 ADR-012 四问（本条为其第六个填完实例）。

## ADR-021 国际站双 provider 并存：一站点一条路由，不做站点开关

- **日期**：2026-11-18
- **状态**：现行（细化 PITFALLS §29「两站凭据不互通」为设计裁定；不改变红线①～⑦，不改变 ADR-007 软失败不变量；面板半边裁定后新增第 6 开关 `intl-provider.json` 进 switch 家族，dialect A）
- **裁定**：国内站与国际站各持一条**并存**的 LLM provider 路由——`agnes-token-plan`（CN，存量，全部既有行为字节不动）与 `agnes-token-plan-intl`（INTL，新增）——由**单一 patch 键** `registerProviderIntl`（默认 `false`）激活。两站账号体系不互通（PITFALLS §29），模型目录几乎同形，provider 行是**唯一**用户可见的站点区分面；「一套凭据 + 一个当前站点开关」被刻意否决：开关是全局非原子旋钮，切换瞬间在飞的 LLM 流 / 出图 / 视频任务全部改道，而 CN grant 打 INTL 网关必 401——正是「防止意外」要防的形状。同类插件的收敛形状即此（qoder `qoder` / `qoder-global` 两区域同时在线、minmax 区域路由 + 碰撞防护、trae 区域→provider 映射「两区域 provider 不交叉计费」）。
- **隔离面（两行互不可见，全部按站切分）**：
  1. **provider id**：`LLM_PROVIDER_ID` / `LLM_PROVIDER_ID_INTL`（双侧拼写由 `test/contract.test.mjs` §11c 五钉之一）；adapter 工厂参数化 provider 身份（CN 为默认，INTL 传 `INTL_PROVIDER`），目录/发布/回滚全走共享 `publish-core`（一次修复两行同得）。
  2. **目录**：`catalog.json`（CN）/ `catalog.intl.json`（INTL），同一目录、两个文件（`catalog-store` 的 `file` 参数）；INTL 无 §23 前身，不做继承。
  3. **API key 引用**：`AGNES_TOKEN_PLAN_API_KEY`（CN）/ `AGNES_TOKEN_PLAN_INTL_API_KEY`（INTL）——同一 reference 机制、不同引用名（红线②不破：仍是 `grant` / `api-key` 两种 kind 里的引用值，无私有 kind）。
  4. **控制台 grant**：`agnes-console` / `agnes-console-intl` 两条 grant 记录，`AGNES_USERNAME(_INTL)` / `AGNES_PASSWORD(_INTL)` 账号引用对、`throttle.json` / `throttle.intl.json` 节流文件（节流仍按 §23 共享目录、只按站分文件：跨 profile 共享的语义是「这台机器别再敲」，两站各守各的）。
  5. **快照**：行恒装配（配置错或 pre-ADR-021 Host 才缺行），以**并行软批量**进同一快照（共享 cache/inflight 按 URL 天然分家）；INTL 半边**关着全静默**——publisher 闸、目录写手 gate 依赖（关着的 tick 一次请求都不做）、快照 INTL 批量（关 = quota: null，缺数带因）三处接缝保证「关 = 不拉目录、不打登录、不注册、无第二 tick」，整段致命失败降级为「无 intl 块」，CN 半边逐字节不动（§5 不变量按站再执行一次）。
- **激活语义**：`registerProviderIntl` 是**唯一的 INTL 激活开关**，且刻意是 patch 行单源值（`writeImageModelIds` 形状）而非面板开关——面板存一个「当前站点」就是被否决的全局旋钮本身。关闭时整个 INTL 半边全静默：不拉 INTL 目录、不打 INTL 登录、不注册 provider、无第二只 tick；CN 装机行为与加此键之前逐字节相同。
- **为什么不是别的修法**：① **两行插件**（装两遍、各自 patch 国际 base）——同一 profile 内插件按包名唯一，双行不可行，双站只能单行内 per-site 槽（qoder/trae 同款）；② **站点开关**（单 provider + 当前站点）——全局非原子旋钮 + 401 改道事故面，同类插件「完全一致也分两条」正为此；③ **INTL 做面板开关**（进 switch 家族第六个）——面板可存的「站点」状态正是被否决的形状，且兄弟会话正在 switch-store/precedence 上做工（ADR-020），加第六项把撞车面扩大到全部开关语义。
- **爆炸半径四问（ADR-012）**：① **承重面归类**：落在既有第三类「直接注册 provider」内，零新承重面——publisher/队列/回滚/目录全复用 `publish-core`；新容器 = 两个 state 文件（`catalog.intl.json` 按 profile 段、`throttle.intl.json` 共享目录）+ 两条凭据引用名，均按 ADR-005 先申报后实现。② **新增状态窝点**：如上；进程内无新增（第二组 publisher/tick 随装配生灭）。③ **失败域边界**：全软失败——INTL 段致命降级为缺块、CN 不动；INTL origin 畸形只伤 INTL 行（日志一行），不写 `configError`（不埋 CN 面板）；开关默认关 = 未配置的机器零行为变化。④ **基线可冻结**：`test/config.test.mjs` 1c 段（三键默认 + 探针值字面量钉）、`test/contract.test.mjs` §11c 第五钉、`test/store-baseline.test.mjs`（token-store 参数化后零漂移）、`test/intl-provider.test.mjs`（新：双行装配/门控/隔离面注入式离线驱动）。
- **面板半边裁定（同日第二轮，「激活语义」与「为什么不是别的修法」③ 被本段取代）**：用户裁定面板必须能「看见切换到国际版的方式」，「面板开关 = 被否决的全局旋钮」的顾虑随之消解——否决的是「一个**站点**旋钮改道所有在飞任务」的形状，而「每站一个**自己的**开关、各管各的行」正是同类插件（qoder 双区域行各自可关）的收敛形状。落账：① **第 6 个开关** `intl-provider.json`（dialect A：面板值胜 patch 键 `registerProviderIntl`，与 `provider.json` 同款工厂与行为清单，`switch-store.test.mjs` 六店同测）；② **行恒装配**——开关不再门控装配只门控静默：publisher 闸、目录写手 `gate` 依赖（关着的 tick 一次 fetch 都不做）、快照 INTL 批量（关 = `quota: null`，缺数带因，不是零值块）三处接缝保「关 = 静默」，首次开闸即活（面板翻转下一个 tick 生效，无需重启）；③ **面板半边 UI**：「接入 API」tab 的 INTL 卡（开关 + `site:"intl"` 键位 + 注册状态，读 `intl.llm`，echo 只落 `intl` 半边）与「积分额度」tab 的 INTL 账号卡（`site:"intl"` 路由参数、INTL 登录态、国际登录页链接）；`api-key` / `account` 路由按 `site` 参数化，INTL 动作只碰 INTL 行自己的引用/记录/目录/发布，行未装配时答 `intl_inactive`（新码 `CODE.INTL_INACTIVE`）；④ 快照 `intl` 块升级为**装配即在场**（`quota` 可空 = 开关关、批量未跑），`llm` 半边常报 `registerProvider` + `registerSource`（开关卡与快照同一事实，不会互打脸）。**留白（后续批）**：INTL 花名册整选 UI（INTL provider 现注册整份 INTL 目录）；INTL 侧出图/视频工具（两工具恒走 CN `apiBase` + CN key）。
- **受影响的文件**：`src/host/{llm-models,llm-adapter,provider-publish,host-config,catalog-store,api-key-store,throttle-store,token-store,token-store/state,token-store/account,snapshot-aggregate,routes/snapshot,lifecycle,index,doctor,types}.ts`、`src/client/{const,composer-usage-pill,wire,i18n}.ts`、`cordis.patch.yml`、`docs/{SETUP,API,PITFALLS,ADR}.md`、`test/{config,contract,docs,intl-provider}.test.mjs`、本账本条目、`lib/` + `client.js`（随 src 同 commit 重建）。
- **与既有条目的关系**：PITFALLS §29 从「注意」升级为「设计」（该条修法行已回写指针）；继承 ADR-012 四问（第七个填完实例）与 ADR-005 申报（新容器先落账）；站点=provider 命名空间的裁定与兄弟仓 qoder/minmax/trae 的同族形状互为镜像（各仓独立实现，§5.5 隔离纪律下不共享代码）。

