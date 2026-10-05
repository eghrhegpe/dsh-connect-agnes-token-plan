# 已失效裁定存档（历史边界决策，不再作为现行依据）

> 本文档收录 ARCHITECTURE.md §5.5 的原文——该节裁定「小浣熊（raccoon）属于界内」
> 已于 2026-10-01 随小浣熊第二上游整条移出本插件而失效。现行上游只有
> Agnes 控制台（Token Plan）与 AgnesCode 桌面端。
>
> 保留原文的目的是让未来边界争议可回溯：当时的划线依据、举证与不改变项
> 仍然有参考价值，但不构成现行约束。

---

## 5.5 边界裁定：第二上游（小浣熊）属于界内（2026-10-01）

> ⚠️ **本节裁定已随 2026-10-01 的移除而失效**：小浣熊第二上游已整条移出本插件（见 ARCHITECTURE.md §5.3 修订（二）），
> 本节保留为历史裁定记录，不再作为现行边界的依据。现行上游只有 Agnes 控制台与 AgnesCode 桌面端。

**裁决**：小浣熊（`xiaohuanxiong.com` 网关，`sensenova-raccoon` provider）**属于**
§5 不变量 3 界内的能力，不是破例，也不是例外许可。随本次裁定，不变量 3 的划线依据
从「Key/账号线（认证域）」改为「**厂商归属**」。

**为什么原来的划法会判错**：不变量 3 原写「只吸收与商汤 **Key/账号线**强相关的能力」。
如果「账号线」指的是同一个认证域，那么小浣熊天然被排除——两者的令牌确实不通用：
拿小浣熊桌面 App 的 `access_token` 打 Token Plan 的额度路由回
`401 auth_token_invalid`（当时打的是商汤控制台；Token Plan 现已在 Agnes 控制台，
复测端点见 [ROADMAP.md](./ROADMAP.md) §6.1.1 的两次复测与其「复测判据」）。
**但认证域不通 ≠ 产品线无关**——把一个自家厂商的姐妹产品判成界外，是拿实现细节当边界。

**同一厂商的举证**（三条独立信源，不是推测）：

| 信源 | 原文要点 |
|---|---|
| 中证网 2026-07-19（商汤 U1 Pro 发布） | U1 Pro 的能力「在**商汤旗下的**产业级 AI『小浣熊』及视频创作工具 Seko 中已得到深度验证」 |
| 商汤官方稿件 2026-09-21 | 「**商汤小浣熊 Raccoon Work**」由商汤科技打造，支持移动端 / 桌面端 / 私有化部署 |
| 本仓库既有措辞 | [ROADMAP §6.1](./ROADMAP.md) 早已写「接入**商汤小浣熊**桌面 App 模型」——边界这次才承认，事实一直在那儿 |

**它与 Token Plan 的关系**（写清才能让后来人判断能不能再放宽）：同一厂商、**不同产品线**、
**互不相通的认证域**、**互不算的积分口径**（那边独立余额，这边 5h/周额度池）。所以它在实现上
必须做到的正是现在这套：**独立凭据生命周期、独立 publisher、独立 provider id**——共享任何
一样都会把两条产品线焊死在一起。它撞的不是「是不是商汤的」这条线，而是「要不要把一个新
产品的凭据塞进旧产品的池子里」这条线。

**本次裁定不改变的边界**（防止一句话把口子开成无限大）：

- **仍然不做跨厂商聚合**——codearts 那类「一套形态融 N 个不同厂商」的做法依旧在界外，
  这是 §5.3 里 `dsh-provider-quota` / `dsh-musage` 的泛化定位，与本插件的深耕路线相反。
- **本次放宽只覆盖「同一厂商下的产品线」**，不覆盖「同一厂商做的一切」——举个例子，
  商汤方舟的视觉 API、Seko 视频创作即便确认同厂商，也仍需各自走 §5 的裁定流程。
- **每纳入一条新产品线，必须同时落三条**：① 厂商归属的外部举证（可核的信源，不是印象）；
  ② 它与 Token Plan 的具体关系（尤其积分与认证域是否通用）；③ 三者齐全才允许默认关
  opt-in 地进入树干——缺任何一条都回到 §5.2 的 publisher 隔离形态自行维护。

---

# 附：2026-09 研究档案中已失效的判断（2026-10-05 并入）

> 以下内容原出自 `docs/IMPROVEMENTS.md`（2026-09，商汤 SenseNova 时代的研究档案）。
> 该文件已于 2026-10-05 改名归档为 [`ARCHIVE-IMPROVEMENTS-2026-09.md`](./ARCHIVE-IMPROVEMENTS-2026-09.md)，
> 本文档收录其中**已失效、已过期、已落地**的判断原文，供未来回溯「当初错在哪、
> 或者当初的顾虑是否成立」。**它们都不是现行依据。**

## A1. 「本插件已是这台机器的默认推理通道」（2026-09 原稿 → 2026-09-29 撤销）

**原论断**：ROADMAP §0 与 §2 引言原写「本插件已是双 profile 的 `agent-default-model`
——即这台机器的**默认推理通道**，故障域已升级为推理可用性」。

**撤销理由**（2026-09-29 复核）：`agent-default-model` 是 `@deepseek-ai/dsh-agent-default-model`
的**「默认模型选择」读写服务**（`lib/index.js:14` 自述 *Owns the default model **selection***，
`saveSelection()`（`:53-66`）经 `configEditor.edit()` 把用户上次选中的模型**回写**进 profile patch）。
它是**运行时可变的选择记录**（config schema 里 `provider`/`model` 均 `.volatile()`），不是静态的
「默认通道」架构声明。两个 profile 指向不同供应商、mtime 随模型切换被改写，正是这一语义的佐证。

更根本的是**原引用内容已不可复现**：稿件描述的 `provider: sensenova-token-plan` /
`model: sensenova-6.8-flash-lite / reasoningEffort: high` 在任何现行文件（含
`cordis.patch.yml.bak-plugin-manager` 备份）里都查不到。

**现行表述**（见 [ROADMAP.md](./ROADMAP.md) §0）：本插件**可**向 DSH 注册推理 provider
`agnes-token-plan`；它**是否**成为某台机器的默认推理通道，由该机 profile 与用户模型选择决定，
**不随插件注册自动成立**。一旦某 profile 真的选它作默认，故障域才从「Plugins 页里的只读面板」
升级为「推理可用性」——这是**条件性**爆炸半径，不是既成事实。

## A2. `index.js` 接线层收编方案（2026-09 → 已落地并被二次拆分取代）

**原方案**：`index.js`（当时 778 行）按行号列出 11 段责任（`apply()` 头部 `#L195-L236`、
`ACCOUNT` 路由 `#L437-L516`、`ctx.effect` teardown `#L709-L723` 等），建议抽 `routes.js` +
`lifecycle.js`，目标 `index.js` < 300 行。

**落地与后续**：2026-09-29 已完成第一步（`routes.js` + `lifecycle.js`，`index.js` 瘦到 251 行）；
此后 2026-10 又照 `token-store` 的术式**二次拆分**为 `routes/` 家族 8 模块 + 薄 facade
`routes.ts`，并按 ADR-005 出了 [TOKEN-STORE-SPLIT.md](./TOKEN-STORE-SPLIT.md) /
[PUBLISH-CORE-SPLIT.md](./PUBLISH-CORE-SPLIT.md) 两份拆分蓝图。

**为何归档**：原文的行号清单已完全失效（`src/host/index.ts` 现 342 行，模块清单以目录为准），
而方案本身已被更细的结构取代。现行结构见 [ARCHITECTURE.md](./ARCHITECTURE.md) §2。

**留存的教训**：`ctx.effect` 的 cleanup 语义（注册时**返回**的函数在卸载时才执行；误写成
注册时直接执行会让 teardown 立即清光全部路由）——当时由 `wiring` 测试首轮红暴露，
现已固化为 [PITFALLS.md](./PITFALLS.md) §18 的纪律。

## A3. 落地顺序表与总判断（2026-09 → 10 项里 8 项已落地）

原 §5 是按「收益/风险比」排的 10 项待办表，§6 是总判断。**核验（2026-10-05）**：10 项里
§3.3①④（peer 契约护栏 + 两级退出证）、§4.3（`autoRecoverArmed`）、§4.2（CI live-contract）、
§2.3（接线层收编）、§1.3（定位对齐）、§4.1 第一步（状态原语）均已落地；§4.4a/§4.4b 已**判停**
（Loader 硬约束，见 ADR-011）。仅 §3.3②③（等上游修 peer）与 §4.1 第二步
（`dsh-atomic-write` 跨进程写锁）仍待外部条件。

原文 §6 写着「**下一步最该做**的是同为 P0 的 §4.3 `autoRecoverArmed` 布尔」——而它已完成。
这正是 [PITFALLS.md](./PITFALLS.md) §55 记的那条教训的实例：**档案里的待办状态无人维护**。

## A4. 姊妹插件横向对比结论（2026-10-02）

原 §8 是与 `dsh-connect-sensenova-token-plan`（同作者，SenseNova 线）的横向核实，
其中三项已明确**不是本仓欠账**：

- **§8.1** 原表把「SenseNova 全仓 strictNullChecks 翻转」对立「Agnes 只做到 tsc 真跑层级」，
  读起来像本仓欠一刀。实测本仓 `tsconfig.json` 的 `strict` / `strictNullChecks` /
  `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` **全部已全局开启**，
  并由 `test/tsc-gate.mjs` 保证 `npm test` 真跑 tsc。两仓殊途同归，**不列为差距**。
- **§8.3** 原表标给 SenseNova 的「routes 拆分、switch-store + switch-precedence、modality
  单函数」三条，实测本仓**都已落地**，反而是该仓应借鉴本仓的。
- **§8.2** 列的两条本仓 P0-lite 护栏（`jscpd` 去重闸、commitlint）**已落地**
  （`package.json` 的 `lint:dup` / `lint:commits`）——原文按未做记，属状态腐烂。

**为何仍归档**：对比结论本身在当时是准确的，且其**方法**（拿兄弟插件当参照系逐条回本仓坐实）
值得保留；但两仓此后各自演进，对照侧「0.4.7 形态」不再可复核（原文 §8.5 已声明
「未在本机复核，仅作方向参照」）。现行边界与路线图一律以
[ARCHITECTURE.md](./ARCHITECTURE.md) §5 与 [ROADMAP.md](./ROADMAP.md) 为准。
