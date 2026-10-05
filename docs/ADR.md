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
- **理由**：video 吸收的实际成本高出路线图预估一个数量级（出图执行体 80 行 → 单文件 993 行，双参数家族 + 异步状态机 + 轮询预算挤在一起），账单以 `video.ts` / `routes.ts` 两个巨文件的形式先到；两者已分别按本蓝图拆分（2026-10）。

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
- **裁定**：控制台四源（`overview` / `series` / `subscription` / `plans`）一律软失败——失败时写入 `quota.error` 并显示来源，但不冒泡到路由的 catch；`overview` 失败时设置 `quota.consoleConnected:false` 且 `quota.totals=null`（而非零值块）。第五个源 `/v1/models`（Key 侧目录）同样软失败，但**只降级、不写 `quota.error`**：目录拉不到置 `catalogAvailable:false`（面板「可看图」行随目录缺席），这是 Key 侧语义，故意与配额侧的四源错开（`snapshot-aggregate.ts:301` 的 Optional 注释钉住这个方向）。面板据此说明「控制台未连接」，其他 tab 不受影响。
- **理由**：旧文曾写 `usage/overview` 是唯一致命源（[SETUP.md](./SETUP.md):117、[AGNES-API.md](./AGNES-API.md):66-69 旧表述），与代码实现相反。代码与测试（`test/routes.test.mjs:466-471`、`test/e2e.mjs:396-404`）早已钉死新行为。为避免读者按旧文档排查误判代码回归，需把旧裁决入账本，并在正文统一为新表述。此裁定已在 [ARCHITECTURE.md](./ARCHITECTURE.md):76-77/102-104、[API.md](./API.md):220-225 体现，现补入账本以方便后续追溯。
- **受影响的文档**：`docs/SETUP.md:117`、`docs/AGNES-API.md:66-69` 已同步为新表述；`docs/AGENTS.md` 红线 6 亦已改为现行表述（「overview 唯一致命源」旧裁决废止一句即见），本条待办行随 2026-10-03 核销。
- **与既有条目的关系**：继承 ADR-004「一个模块缺席不许埋掉别的模块」，将之具体化为五个额度源的软失败策略。

## ADR-008 构建产物入库：取消忽略 lib/ 与根 client.js

- **日期**：2026-10-03
- **状态**：现行（取代 ROADMAP §6.2 的「产物彻底不入库」，即 2026-09-30 当晚裁定）
- **裁定**：`lib/`（Host ESM bundle + 切分 chunk）与根 `client.js`（Client IIFE）由 `npm run build`（tsdown）从 `src/` 重建，**随库提交**——`.gitignore` 不再忽略它们。改 `src/` 后必须重建，并把产物与源码放进**同一个 commit**；CI 新增 `artifacts` job：`npm run build` + `git diff --exit-code -- lib client.js`（双跑验可复现），拦「改了 src 没重建」。`prepack` 保留（registry 发布 tarball 新鲜度不变）；**不加 `prepare`**。
- **理由**：DSH 市场 / `dsh plugin add` 的 git 直装走 pnpm git-dep 管线，pnpm 11 的 `packageShouldBeBuilt` 按「`main`（`./lib/index.js`）在克隆里是否存在」决定是否跑构建脚本——产物在库则克隆即可用（零构建、零 devDeps、零 `allowBuilds` 审批）；产物缺失则翻回「需要构建」，而 pnpm 未经 `allowBuilds` 批准不跑构建脚本，直接 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，装出来的插件没有宿主入口、卡片失效。2026-10-03 实测：`pnpm add git+https://github.com/eghrhegpe/dsh-connect-agnes-token-plan`（全新工作区、无 `allowBuilds`）在入库前撞该错、入库后 `exit 0` 且 `lib/index.js` + `client.js` 齐备。兄弟插件 `dsh-connect-qoder` 同款做法（`.gitignore` 不忽略 `lib/`，并留警告别加回）。
- **为什么不是别的修法**：加 `prepare` 会让 `packageShouldBeBuilt` 翻回 true，零配置作废（`prepare` 本身还要 `allowBuilds` 批准）；建 `pnpm-workspace.yaml` 只影响本机、改不了市场用户侧 pnpm 的行为；只修文档不解决问题。唯一可靠解是产物入库。
- **受影响的文档**：`.gitignore`（取消 `/lib/` `/client.js`，加 qoder 同款警告块）；`AGENTS.md` 验证段；`test/build-gate.mjs` 措辞（freshness 语义不变，但现在它就是「入库产物 vs 重建」的比对）；`docs/ARCHITECTURE.md:18`、`docs/DSH-PLUGIN.md:30/143`、`tsdown.config.mjs` 头注释、`test/docs.test.mjs:354` 注释已改为现行表述。
- **历史条目不改写**：`docs/ROADMAP.md:217/224-227`、`docs/PITFALLS.md:353` 保留 2026-09-30 / 2026-10-01 当时的记录——按考古纪律不在原文盖内联修订补丁，现行规则以本条为准。
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
  - `render` **不是分叉**：`PanelPage` 的门是 `needsSetup && loadedOnce`（`panel-page.ts:311`），带一个本视图模型根本没有的「首帧」状态；`decidePanelView` 的三态是为断言做的**粗化**，两者是结构不同的两个问题，不是同一判定的两份。
  - `consoleConnected` **不是判定而是字段读取**：三处分叉使用它——`panel-page.ts:298`（展开账户卡）、`:404`（显示未连接提示）、`snapshot.ts:261`（是否需要 setup）——**三处语义各不相同**，把它算成「同源分写」是把「都读了这个字段」误当成「都判了同一件事」。
- **这条的净效果**：ADR-006 残留段列的五项里，`canManageAccount`（上一轮已改）与 `coolingMs`（本条）**两项是真残留并已清**，`render` / `consoleConnected` / `needsUserAction` **三项经核实不需要改**。`needsUserAction` 尤其要注意：它在 `panel-decision.js:136` 与 `account-form.ts:312` 是**同一个表达式、无分叉**，此前被一并列进残留清单属连带误判。
- **验证**：`test/panel.test.mjs` 88 → **91**（新增 §F1 三条）。新增的 §F1 是**负向对照**：E 段用「窗口 + `needsUserAction: false`」、F 段用「`null` + `needsUserAction: true`」，**两段恰好都碰不到两者分歧的那份输入**——这正是它能活下来的原因。§F1 补的输入是 `retryAfterMs: 2h + needsUserAction: true`，并额外断言视图模型与规则同源。**负向验证**：把 `coolingMs` 退回旧的自推实现 → **2/91 红**（正是 §F1 那两条），还原后全绿。
- **为什么这条分叉此前不产生用户可见错误**（诚实注记，不包装成「无害」）：Host 自己**不会**下发这种形状——`inForceWaitMs` 在 parked 时恒返回 `null`（`token-store/throttle.ts`），且 parked 记录的 `until` 就是 `null`。真正可达的是**面板自己的 POST 路径**：`routes/account.ts` 把平台声明的窗口复制进响应体，而 `needsUserAction` 来自节流的 `parked` 标志，于是「验证码 + `Retry-After: 7200`」会同体给出两者（该路径已由 `a85f4b3` 修掉矛盾 UI）。所以这是**结构债而非活 bug**，但 ADR-006 已把它挂在账上，挂着不销就是账本失效。
- **与既有条目的关系**：不改变 ADR-006 判据 1（纯模块可 Node 直 import）——本条正是它的应用，`panel-decision.js` 早就在 import `snapshot.ts`（`shouldShowAccountManagement`），所以「`.js` 文件不经 import 路径」曾被当作推迟的理由是**未核实的推断**（2026-10-05 核实后更正）。也不改变判据 3（仍靠 review），但本条把 review 的结论**落成机器可验的负向对照**，缩小了判据 3 的适用面。
