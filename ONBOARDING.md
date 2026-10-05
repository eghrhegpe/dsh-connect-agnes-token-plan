# ONBOARDING — 三天内读什么

给第一次接手本插件的人：本仓文档量大（架构/红线/踩坑/PITFALLS 各成篇），本文件是唯一
的「入口地图」，只告诉**按什么顺序读哪几篇、读到什么程度算够**，不重复任何事实——数字、
红线、契约都以 `docs/` 与 `AGENTS.md` 为准。

> 本文件是**静态入口**，不进 `docs.test.mjs` 的活文档计数护栏：它不写死会随代码漂移的
> 模块数 / 规模 / 行数 / 路由条数 / 套件规模。任何「N 个」「N 行」式陈述一旦需要，请回到
> 对应 `docs/` 篇目核对。

## 第 0 步（5 分钟，必读）

- `AGENTS.md` —— 本会话的纪律总纲：**怎么验证、七条红线、去哪查**。这是唯一一份「会让你
  少犯炸机器错误」的文件，改任何代码前先读它的「红线」段。
- `README.md` —— 给用户看的能力全景，先建立「这个插件到底干什么」的直觉。

## 第 1 天（动手前）

1. `docs/ARCHITECTURE.md` —— 理解 Host / Client 分流、双仓库关系，以及 §5 的三条不变量
   （面板照常用、模块缺席降级、不计算「剩余」）。**之后你判断「这写法怪不怪」都先拿这三条
   不变量对照**。
2. `docs/PITFALLS.md` —— 55 条「现象→根因→修法」。改代码前扫一遍，你即将踩的坑大概率已在
   这里。
3. `docs/AGNES-API.md` —— 控制台额度侧与推理侧的接口全集；动登录 / 取数 / 出图 / 视频前查。

## 第 2 天（开始改）

- `docs/AUTH.md` + `docs/AGNES-API.md` §1–§2 —— 一跳登录、失败分类、重登、节流。
- `docs/TESTING.md` —— 测试体系与「按域裁剪、禁止无脑全量」的门禁纪律。
- `docs/CONTRIBUTING.md` —— 提交约定、`upstream/` 红线、发布版本同步规则。
- 实际跑一遍：`node test/parsers.test.mjs`（最轻、最快、最独立），确认本机 harness 能跑。

## 第 3 天（深入某一域）

按你要动的域，挑对应篇目精读，不要一次性全读：

- 动额度 / 取数 / 面板：`docs/API.md`、`docs/SETUP.md`、`src/host/parsers.ts`（解析层）。
- 动 LLM provider / 出图 / 429 自愈：`docs/DSH-LLM-DEVELOP.md`、`docs/PROVIDER-HOT-RELOAD.md`、
  `src/host/pi-ai-adapter-core.ts`（两 adapter shell 共享的装配核）。
- 动桌面端上游（AgnesCode）：`docs/ROADMAP.md` §6.3（契约探针 + 隔离裁定）→ `src/host/agnescode*.ts`。
- 拍 / 改某条裁定、回溯边界沿革：`docs/ADR.md`（决策账本，取代关系与举证链在此）。

## 评审 / 锐评代码前（重要）

`AGENTS.md` 的「评审纪律」四条规定务必遵守：

- 量化断言必须可复现（分子分母都写清，禁止凭印象报数）；
- 先读裁定，再读代码（「怪写法」先在 PITFALLS / ADR 搜出处）；
- 每条问题先做一次无罪搜索（判「吞错误」前先读 catch 上方注释）；
- 结论分四级：实测属实 / 部分属实 / 设计取舍 / 无法证实——后两类不得包装成缺陷。

## 门禁速查（改完必跑）

```powershell
npm run build          # 改 src/ 后必跑，重建 lib/ 与 client.js 并同 commit 提交
npm test               # 离线全量套件 + 末尾 4 道 gate：tsc-gate / build-gate / dup-gate / e2e-gate（各自探到 tsc / tsdown / jscpd / dsh CLI 才实跑，否则 SKIP）
node test/<域>.test.mjs # 单跑某一域（见 AGENTS.md「验证」段清单）
```

`docs.test.mjs` 会检查：内部链接可解析、跨文件表格去重、根 README 行数上限、教学快照同步、
API 契约、考古纪律、peer 静态边界、活文档计数护栏。本文件不触发 `ORPHAN_DOCS`（它只审
`docs/` 顶层），但其中任何指向 `docs/` 的链接必须是真实存在的文件。
