# DSH 统一出图/出视频接口审计（观察存档，2026-10）

> **性质**：调研观察记录，**不是待执行清单、不对运行时做任何改动**。
> 起因：一次设计锐评里提出「出图/出视频可否退回 DSH 的大统一接口，而非本插件自己造
> `agnes_draw_image` / `agnes_video_generate` 工具」。本文是把「能不能退回」这件事在
> 本机 DSH runtime 上扒实之后留下的存档，结论被 ARCHITECTURE.md §5.4 的接法 B（吸收）
> 采纳为现行形态的依据之一。
>
> **现状结论（一句话）**：DSH 当前**没有可供本插件退回的第一方大统一 image/video
> 注册面**，因此接法 B（本插件经 `ctx.tools` 自建 agent 工具）是当下唯一可行的落地点；
> 接法 A（喂社区 `dsh-draw-router`）才是真正的「依赖外部、更危险」，不应采用。

---

## 1. 调研方法

全部事实来自本机 DSH runtime（`~/.dsh/dsh-asar-unpacked/dsh/node_modules`）的静态扒取，
未启动任何 Host、未发任何网络请求：

- 枚举 `@deepseek-ai` 作用域全部包名，确认有无第一方 image/video 服务；
- 追踪本插件实际注册工具所走的 `ctx.tools`（`@deepseek-ai/dsh-tools`）契约；
- 在 runtime 全量 grep `images/generations` / `registerImagesApiProvider` / `videoApiProvider` 等符号，定位出图能力到底落在哪一层；
- 检查 `pi-ai` 的 `package.json` exports，确认其内部 image 注册面是否对外部可达。

---

## 2. 事实链（均为 runtime 实测）

| # | 事实 | 取证位置（本机 runtime） |
|---|---|---|
| 1 | 本插件出图/出视频经 `ctx.tools.register(defineTool({…}))` 落地；`dsh-tools` 的 `defineTool` 只有 `name / description / parameters / output / execute`，**无 `category` / `kind` / `tags` 等能表达「图像类工具」的分类字段** —— 即 DSH 没有「图像工具大统一面」，只有一个「工具大统一面」。 | `@deepseek-ai/dsh-tools`（README + `defineTool` 契约） |
| 2 | `@deepseek-ai` 作用域**没有**第一方 image / video 服务：无 `dsh-image` / `dsh-draw` / `dsh-video` / `dsh-media-gen`。`images/generations` 端点只出现在 `@earendil-works/pi-ai`（推理 peer 底层）与 `openai` SDK 内部，**均非 DSH 自己的服务**。 | runtime 全量 grep 结果 |
| 3 | `pi-ai` 内部确实存在图像注册面：`images-api-registry.js` 导出 `registerImagesApiProvider(api, { generateImages })` + `getImagesApiProvider(api)`，`register-builtins.js` 已将 OpenRouter 自注册进去（签名 `generateImages(model, context, options)`）。**但该面仅在 `pi-ai` 内部被引用**，`@deepseek-ai/dsh-llm-pi-ai` 与 `dsh-llm` 都没有桥接它给外部 provider。 | `@earendil-works/pi-ai/dist/images-api-registry.js`、`providers/images/register-builtins.js`；`@deepseek-ai` 作用域 grep 零命中 |
| 4 | `pi-ai` 的 `package.json` exports **没有 `./images` 子路径导出**（仅 `.` / `./compat` / `./providers/*` / `./api/*` / `./utils/*` / `./oauth` 等）。即使想 `import`，合法入口也不存在。 | `@earendil-works/pi-ai/package.json` |
| 5 | **视频侧连内部面都没有**：runtime 内不存在 `registerVideoApiProvider` / `videoApiProviderRegistry`。Agnes 的 `agnes_video_generate` 是异步任务协议（create→poll），更无现成大统一面可挂。 | runtime 全量 grep 零命中 |
| 6 | 本插件走的那条 provider 注册通道**不收 image/video**：`dsh-llm-pi-ai` 给外部 provider 暴露的只有 `ctx.llm.registerAdapter` / `registerConfigurableProviders` / `registerModelDiscovery` / `ctx.authorization.registerFlow`，**无 image / video 注册入口**。 | `@deepseek-ai/dsh-llm-pi-ai/lib/index.js` 导出面 |

---

## 3. 结论与边界

- **「退回通用接口 / 大统一接口」在当前 DSH runtime 不成立**：该接口**不存在**——
  既无第一方 image/video 服务，`pi-ai` 内部的 image 注册面又不可达、视频面更缺。
  因此 ARCHITECTURE.md §5.4 选接法 B（吸收、自建工具）是合理而非过度设计；
  接法 A（喂社区 `dsh-draw-router`）才是把执行面押在社区包上的真危险，**否决**。

- **已有脆弱性同源但不新增**：`dsh-tools` 是 Host 发行 peer（随 DSH 升级），本插件
  造 `agnes_draw_image` / `agnes_video_generate` 与 `llm-error-fix.ts` 造 peer 补丁层
  **同源**（都绑 `dsh-tools` / `dsh-llm-pi-ai` 的契约），但两者均 opt-in 默认关、
  降级同型（见 lifecycle.ts 的共享 `mountAgentTool` 阶梯），爆炸半径被三条不变量压住。

- **唯一可设想的「真·大统一」路径是上游增强，非本插件能单方面完成**：若未来
  `@deepseek-ai/dsh-llm-pi-ai` 把 `pi-ai` 的 `registerImagesApiProvider` 经
  `ctx.llm` 暴露成一个 provider 可注册的 image 能力面，则本插件的 `draw.ts` 可从
  「自建 `agnes_draw_image` 工具」降级为「往 `agnes-token-plan` provider 挂一个
  `generateImages` 实现」——更贴大统一、少一层工具注册面。视频同理，但 `pi-ai` 连
  内部 video 面都没有，须先有内部面才能谈暴露。**此项纯属上游演进可能，本仓库不跟踪、不提案。**

- **本存档不引入任何代码改动、不新增门禁、不修改任何运行时契约**。它只解释
  「为什么只能走接法 B」，作为未来若有人再问「为何不自建还是不接通用面」时的回溯依据。

---

## 4. 与既有文档的关系

- 本文件不复制 ARCHITECTURE.md §5.4 的「出图对接点源码对照表」与「接法 A/B 决策表」
  （那两张表是其唯一出处，按 [docs.test.mjs](./README.md) 跨文件重复表规则保持单源）；
  本文只补 §5.4 未覆盖的事实——**「DSH 无第一方大统一 image/video 面」的 runtime 取证**，
  以及「接法 A 被否决」的明确裁定。
- 若未来 §5.4 修订出图路线（例如上游真暴露 image 注册面），本文应随同更新或直接归档。
