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

- **残留（如实记录，不得包装成已完成）**：① qoder 的 `card-host-parity.test.js` 已改为 import 真模块，但 `client-bundle.test.js` 与 `protocol-shape-card.test.js` **仍从产物抠刚被抽出去的那两个函数**——抽取只做了一半；② 本仓 `panel.test.mjs` 有两处**接线类**源码正则（`setInterval` 无字面量、`title: tt(...)` 顺序），属「effect 无法被 hook-less 替身驱动，只能拒绝第二份副本」的诚实取舍，**不属本条的打击面**；但 `panel-decision.js` 对 `render` / `consoleConnected` / `canManageAccount` / `coolingMs` / `needsUserAction` 的再推导，与 `panel-page.ts` 同源而分写，是本条判据 1 的**真残留**（同一句 `auth !== null` 存在两份）。
- **判据落地（2026-10-03）**：判据 1/2 已成机器可验——`docs.test.mjs` 检查 `RULE_LAYER_BOUNDARY`：① 纯模块（`snapshot.ts` / `models.ts` / `format.ts` 等）必须能被 Node 直 import，且不得**值位置** import `runtime.ts`（`import type` 编译期擦除，不算耦合）；② 测试不得用「模板串定位函数头 + 花括号配平」从 client 产物抠函数体，也不得 `new Function(<产物片段>)`。探测器**锚惯用法而非函数名清单**——按名清单会误伤合法用法（把规则名当 surface 键断言是引用模块面），也会随改名静默失效；并自带负向对照证明探测器本身有效（PITFALLS §39）。判据 3 无法机械化，仍靠 review。
- **未完成**：qoder 两个残留测试的收敛——属另一仓库，需在该会话内完成（本仓只能记录；`RULE_LAYER_BOUNDARY` 一旦在 qoder 落地会当场点名那两处）。
- **与既有条目的关系**：本条不改变 ADR-005 的准入门槛，而是给「client 侧新规则放哪」补上事前决策点；PITFALLS §39「点名守护物而不校验守护物」是本条判据 2 的直接依据——抓产物文本的检查看着像守护，实则守护的是排版。
