# 架构（Architecture）

本仓库 `dsh-connect-agnes-token-plan` 是 DeepSeek Harness 的一个**插件**，在 Harness Web UI 的 **Plugins 页**以插件卡提供 Agnes 控制台 Token Plan 的实时额度面板。它还**不是**一个独立可运行程序，而是挂在 Host（桌面版 / `dsh web`）里的一截逻辑。

本文讲清三件事：插件与 `upstream/` 的关系、插件内部的 Host/Client 分流、以及数据如何流动。

---

## 1. 双仓库关系：`dsh-connect-agnes-token-plan` 与 `upstream/`

本仓库根目录下有一个 **被 `.gitignore` 忽略的 `upstream/`** 目录，它是从 `~/.dsh/fork/sensenova-usage-dashboard` 移入的**上游仓库**（独立 git 仓库，线上：[shaobingtongzhi/sensenova-usage-dashboard](https://github.com/shaobingtongzhi/sensenova-usage-dashboard)；本地副本当前不带 `.git`，恢复方式见下方引用块）。

| 维度 | `dsh-connect-agnes-token-plan`（本仓库） | `upstream/`（被忽略，独立仓库） |
|---|---|---|
| 形态 | DSH 插件（Host 半边 + Client 半边） | 独立 Python 桌面应用（pywebview 原生窗口） |
| 语言 | Host 半边与 Client 半边均为 **TypeScript 源码**（`src/host/*.ts` + `src/client/*.ts`），经 `npm run build`（tsdown）构建为 `lib/`（Host 单条 ESM bundle + 动态切分 chunk）与根 `client.js`（Client IIFE 产物）；`lib/` 与 `client.js` 均为 `.gitignore` 忽略的纯构建产物，删后可从 `src/` 重建 | Python（`dashboard.py` + `auth_login.py`） |
| 账号凭据 | 走 **DSH 凭据服务**（`~/.dsh/.credentials.yaml`），无明文文件 | 明文存 `accounts.json`（为支持自动重登） |
| 令牌续期 | **Agnes 不发 refresh token**：令牌失效即用存下的账号名 + 密码**重登一次** | JWT 过期后用明文账号密码**重登** |
| 登录节流 | 区分时间型 / 凭据型拒绝，防锁号 | 仅基础重试 |
| 与控制台交互 | `/api/usage/overview` / `/api/usage/series` / `/api/cn/user/subscription` / `GET /v1/models` | 商汤时代的 `pool-usage` 等接口 |
| 是否进本仓库历史 | 是（本仓库主开发目标） | **否**（gitignored，保持独立 git 历史与 remote） |

**为什么要这样放：** 上游 Python 工具是这套商汤控制台集成的「原始实现 / 参考源」，里面沉淀了接口字段、打包（`build_mac.sh` / PyInstaller `.spec`）、登录封包等可复用知识。把它以**被忽略的 `upstream/`** 形式容纳进本仓库，既能随时对照、复用其接口与打包经验，又不会污染本插件仓库的提交历史，也不会把明文凭据文件（`accounts.json`）带进版本库。插件在**构建期与运行期都不依赖 `upstream/`**——两者只是概念上的上下游，没有代码耦合。

> 若需向上游提交改动，进入 `upstream/` 目录本身就是一个完整 git 仓库，直接 `git` 操作即可，与外层仓库互不影响。**注意：本地副本当前实测不带 `.git`**——若要在其中独立 `git` 操作，先恢复为独立仓库：
> `git clone https://github.com/shaobingtongzhi/sensenova-usage-dashboard upstream/sensenova-usage-dashboard`

---

## 2. 插件内部结构：Host 半边 vs Client 半边

插件分两半，加载时机与改动代价完全不同：

| 半边 | 文件 | 加载时机 | 改动后如何生效 |
|---|---|---|---|
| **Host（服务端）** | `src/host/*.ts`（32 个模块，另有 `src/host/token-store/` 子目录 6 个；经 `npm run build` 构建为 `lib/`） | 启动时加载一次 | **重新构建 + 完全退出 DSH（含托盘）再启动**，`dsh web` 不会热重载 |
| **Client（前端）** | `src/client/*.ts`（19 个模块，构建为根 `client.js`） | 浏览器侧，随页面加载 | `npm run build:client` 重建后浏览器刷新即可 |

- `index.ts`：注册只读路由 `/api/dsh-connect-agnes-token-plan/snapshot`（聚合控制台数据，401 自动重登重试一次）+ 账号 / API Key / 模型清单 / 出图开关 / 小浣熊配置路由；模块装配与生命周期接线在 `lifecycle.ts`。
- `host-config.ts`：配置契约——`CONFIG_DEFAULTS`、`resolveSettings` / `resolveAuthOverrides`（含嵌套 `auth:` 块拒绝）、`isAdmitted` 同源闸、`hostName` 解析。
- `codes.ts`：全部错误码与平台原因码的唯一声明处。`agnes-auth.ts` 产出、`token-store.ts` 判定是否 parked、`routes.ts` 判定是否属于「拿不到令牌」，三处都从这里取——新增一个平台原因只需改这一个文件。
- `token-store.ts` + `token-store/`：凭据服务里的令牌与账号存取、按期重登、401 拒绝记忆。子目录按职责拆成 `account` / `acquire` / `renewal` / `grant` / `throttle` / `state` 六块（拆分蓝图见 [TOKEN-STORE-SPLIT.md](./TOKEN-STORE-SPLIT.md)，行为由 `store-baseline.test.mjs` 冻结）。
- `throttle-store.ts`：登录节流状态，写在插件自己的状态文件（`$DSH_HOME/state/<plugin>/throttle.json`，原子写、0600），跨进程跨重启生效。
- `agnes-auth.ts`：**一跳**账号密码登录（`POST {consoleBase}/api/user/login`）+ 失败分类 + `Retry-After` 解析。`refresh()` 永远抛 `NO_REFRESH_TOKEN`，store 靠这个码落到重登。没有 OIDC / PKCE / JWE。
- `console-client.ts`：控制台与模型目录的网络请求，带信封解包（`{code,message,data}`）、短生命周期缓存与 single-flight（并发轮询只发一次请求）。
- `parsers.ts`：响应解析层——字符串数值 / epoch / ISO 归一、`checkShape` 漂移检测、`parseUsageSeries` 分桶求和、`quotaWindows` 四窗口、`matchCurrentPlan` 套餐匹配、`identifyVisionModel` 视觉模型识别。
- `snapshot-aggregate.ts`：快照路由的数据聚合（peer-free）——并行取数 / 解析 / 形状漂移 / 四窗口与累计用量组装 / vision 识别 / `llm` 状态块组装。`routes.ts` 只保留 HTTP 面（路由注册、同源闸、body 读取、`writeJson`），聚合逻辑在此，`test/routes.test.mjs` 可无容器地钉住每个分支。
- `trace.ts`：登录 trace 落盘（成功/失败，值级脱敏，仅留最近 20 个，权限 0600）。
- `util.ts`：共享工具函数（`str` / `num` / `obj` 等类型安全读取器）。
- `state-store.ts`：按 profile 分段的状态文件读写基建（catalog / provider / draw 三份状态共用，见 [PITFALLS.md](./PITFALLS.md) §23）。
- `provider-publish.ts`：直接注册的 provider 的发布状态机（peer-free）——`publishChain` 串行化、`disposed` 闸、单点 `registerPair` 与回滚路径（PITFALLS §18/§19）。从 `index.js` 抽出，使路由层保持轻量；`index.js` 驱动它，`test/wiring.test.mjs` 经此模块注入并发 publish 门控。
- `llm-models.ts` / `llm-adapter.ts` / `llm-retry.ts` / `llm-error-fix.ts`：推理侧的纯逻辑映射（无 peer，离线可测）、依赖 peer 的适配器半边、429 退避策略、以及 Agnes 把速率上限错命名为 `quota_exceeded_error` 的纠正。
- `draw.ts` / `draw-store.ts`：出图工具（`agnes_draw_image`）与它的面板开关。
- `raccoon*.ts`：第二上游（小浣熊）——网关契约、QR 登录状态机、独立 store / publisher / provider id / 开关，与 Token Plan 完全隔离。
- `client.js`：Plugins 页内的配置卡与三个 tab（积分额度 / 接入 API / 小浣熊）+ 账号表单（React，纯主题令牌样式）。内部 `interpretSnapshot` 把 Host 的响应读成 `(data, error)` 对，再交给决策块。
- 测试基建：`client-surface.js` / `panel-decision.js` / `panel-render.js` —— 把 `src/client/` 作为模块加载后物化 `panel` 测试面，供 `panel.test.mjs` / `render.test.mjs` 直接调用。不进运行时、不进 `files` 打包清单。

---

## 3. 数据流（轮询 → 快照 → 渲染）

```
[面板打开]
   │  每 30s（仅挂载时轮询，关闭即停）
   ▼
GET /api/dsh-connect-agnes-token-plan/snapshot   ← Host 半边
   │  1) 取令牌；临近过期或控制台回 401 时重登一次（Agnes 没有 refresh token）
   │  2) 先单独取 /api/usage/overview —— 认证探针（五个源之一，失败不再致命）
   │     再并行取 series / subscription / 公开 plans / GET /v1/models（五个源一律可降级）
   │  3) 按 consoleBase 等配置聚合，Host 缓存 cacheSeconds 秒
   ▼
{snapshot}  ──HTTP 200，body 内 ok:true/false 区分成败──►
   │
   ▼
client.js: interpretSnapshot(body) → {data, error}
   │  error 携带 auth 块（含 needsAccount / retryAfterMs / needsUserAction）
   ▼
决策块（panel-decision.js 从同一模块取的 viewOf）决定渲染：
   - 有数据 → 额度上限（四窗口）/ 账号累计用量 / 分桶柱图 / 套餐对比
   - 控制台未连接（quota.consoleConnected:false）→ 额度 tab 内明说，
     并把登录卡展开；另两个 tab 不受影响
   - 需配置账号且完全没有 body → 额度 tab 内是 AccountForm
   - config_error / console_error → 纯文本提示（登录解不了的问题：
     前者是配置写错，后者是控制台没应答，下一轮通常自愈）
```

关键点：**HTTP 永远 200**，成败靠 body 里的 `ok` 与 `code` 区分；`auth` 块会随失败一起下发，所以连不上控制台时面板也能说出「令牌是否能自愈」。

**为什么 `overview` 仍然单独先取、却不再是唯一致命的**：单独先取的理由没变——它是认证探针（最便宜的认证调用，任何已登录账号都能发），且**串行**放在其余取数之前，是因为它 401 时会先把令牌换新，后面的批量才拿着活令牌出门（`test/routes.test.mjs` B 组钉死了「死令牌只被出示一次」）；未登录时它失败在本地（`not_configured`，不发请求），所以这个串行不花任何往返，稳态下也通常命中缓存。

变的是它**不再把失败变成整个快照的失败**。它曾经是唯一致命源：失败即冒泡到路由的 catch，整个 body 走 `ok:false`，面板只剩登录表单——把 API Key tab（不读控制台）和小浣熊 tab（连的是另一个上游、有自己的凭据）一起埋掉，正是 §5 不变量 3 禁止的形状。现在它失败只意味着 `quota.consoleConnected:false`：`quota.totals` 是 `null` 而不是零值块（否则一次读取失败会被渲染成「0 次请求」——把失败伪装成测量），面板在额度 tab 内点名「控制台未连接」，另两个 tab 一个点击之外。

---

## 4. 登录与令牌生命周期

详见 [AUTH.md](./AUTH.md)。一句话版：

1. 用户首次在面板填一次账号密码，Host 向 `{consoleBase}/api/user/login` 发**一跳** POST；密码是明文 JSON，只过 TLS（Agnes 没有 JWKS / JWE 封包端点，没有任何东西可以把它包起来，所以**传输层是唯一的保护**，而「绝不落盘」是承重设计而非整洁）。
2. 账号名与 access token 存入 DSH 凭据服务（记录 kind 只能是 `grant`；**密码不落盘**，`AGNES_PASSWORD` 环境变量是唯一持久来源）；此后**令牌失效就用同一路径重登一次**——Agnes 不发 refresh token，`refresh()` 恒抛 `NO_REFRESH_TOKEN`，store 正是靠这个码落到重登。
3. 令牌寿命优先读 JWT 的 `exp`，读不出则按 `fallbackExpiresInSeconds`（默认 7 天）估；提前 `tokenSkewSeconds`（默认 120s）触发重登；控制台返回 401/403 时也重登并重试一次（**只一次，不递归**：刚换的令牌也被拒说明问题在账号，再试只会敲锁）。
4. 每一次登录尝试（**成功也算**）都落一份脱敏 trace 到 `$DSH_HOME/logs/`，否则「浏览器能登、面板不能」无法对照排查。

---

## 5. 生态定位：大统一——商汤全过程集成的单点入口（2026-09-29 定位变更）

**决议（2026-09-29）**：插件定位从「只做信息、不做执行、n 个插件分层分散行动」
改为**大统一**：额度/登录/模型清单（现状）+ 视觉信息下发（§5.1）+ LLM provider
注册（§5.2）+ 出图路由对接 + 429 自愈（退避/分诊），逐块吸收进本插件，
不再依赖多个插件各自为战。可行性依据是 §5.3 的生态核实：同类插件已把
其中几块能力做成了单包现实。

此前「商汤全家桶不成立」的判断就此废止，但爆炸半径教训**仍然有效**
（本插件曾是桌面端必需启动项，一次凭据事故炸过整机，见
[PITFALLS.md](./PITFALLS.md) §6 与 [SETUP.md](./SETUP.md) §2 注记），
收敛为大统一的三条不变量：

- **每个新模块 opt-in、默认关**，任何失败降级为「面板照常用、该模块缺席」
  （§5.2 的降级模式是范本）——不许再造「桌面端必需启动项」。
- **凭据红线不动**（[AGENTS.md](../AGENTS.md) 红线 1/2）：新增凭据一律只进
  DSH 凭据服务（含未来若引入多 Key 池），永不入库、永不进日志。
- **只吸收与商汤（SenseTime）产品线强相关的能力**，不做跨 provider 通用聚合——
  §5.3 里 `dsh-provider-quota` / `dsh-musage` 的定位边界就是本插件的边界。
  > **2026-10-01 修订（边界放宽）**：原表述是「只吸收与商汤 **Key/账号线**强相关的能力」，
  > 按 Key 域名 / 认证域划线。该划法会把同一厂商的姐妹产品线误划到界外——Token Plan
  > 控制台与小浣熊（`xiaohuanxiong.com`）同属商汤旗下产品，却走互不相通的两个认证域
  >（实测见 [ROADMAP.md](./ROADMAP.md) §6.1.1 的两次复测）。
  > 界定依据改为**厂商归属**而非域名或认证域，第二上游因此属**界内**，裁定详情见 §5.5。
  > 另外两条不变量（opt-in 默认关、凭据红线）不受本次修订影响。
- **一个模块缺席，不许把别的模块一起埋掉**（2026-10-01 补记）：第一条不变量的推论，
  本插件自己违反过一次——控制台（地基）读不到时整个快照走 `ok:false`，面板只剩登录表单，
  把 API Key tab（根本不读控制台）和小浣熊 tab（另一个上游、另一套凭据）一起带走。
  现已改为 `quota.consoleConnected:false` 的软降级 + 客户端 tab 栏无条件渲染，
  数据流见 §3；诚实性要求同时成立：读不到的用量是 `null`，不是零值块。

变更前的三层分工，改作吸收路线图：

| 层 | 变更前谁干 | 大统一后的去向 |
|---|---|---|
| 额度 / 登录 / 模型清单 | **本插件** | 维持现状，继续是地基 |
| 「哪些模型能看图」的识别与信息下发 | **本插件（见 §5.1）** | 维持现状（两步走已落地） |
| 真把图喂给模型（视觉/绘图路由） | `dsh-media-skills` / `dsh-draw-router`（社区） | **拟吸收**：出图路由对接，参考 §5.3 `dsh-draw-router`，对接点源码对照见 §5.4 |
| 429 自愈（退避+分诊） | `st-rotator`（独立 Python 进程） | **拟吸收**：吸收其两条纪律（先分诊「限频 vs 配额」、降速退避），**不做多 Key 池**（同账号共享额度池，轮换无效）；路线图见 [ROADMAP.md](./ROADMAP.md) |

本插件仍是机器里**唯一既知道本 Key 实际能调哪些模型、又常驻 DSH 里**的组件——
大统一之后它从「只下发信息」升级为「信息 + 执行」，但每一块执行都挂在上面的
三条不变量之下。

### 5.1 视觉能力：两步走（2026-09 决议）

痛点：用户在 DSH 设置里填入 `AGNES_TOKEN_PLAN_API_KEY` 后，模型卡片的「输入类型」
不会自动标记「图片」，Agent 不知道哪把模型可当 vision 模型，填 key 不会自动打开
看图。DSH 的 LLM 链路本身原生认图片输入（deepseek provider 有
`maxImagesPerRequest`、图片 offload 一整套参数），缺的只是「这套餐里哪把模型
能看图」这条结构化信息。

**第一步（本期，已完成）**：插件从 `GET /v1/models` 的 `catalogModels` 算出
`visionModels`（可看图模型清单），发进 `/snapshot`，面板加一行展示。
识别依据：**已确认（拉真实响应）**——`/v1/models` 在**每个**模型
条目上都带结构化字段 `input_modalities`（字符串数组，如
`["text","image"]`）与 `output_modalities`，所以按字段判定：`"image"` 出现在
`input_modalities` 里即可看图；名字规律（`vl` / `vision`）仅作为「平台若某
天不返回模态字段」的兜底，并标 `source: "name"` 注明是按名字推断。实测：
`deepseek-v4-flash`、`glm-5.2`、`kimi-k3` 等模型 input 仅 `["text"]`；
`Agnes-6.8-flash-lite` input 为 `["text","image"]`（即可看图模型）；
`Agnes-u1-fast`、`Agnes-u1.5-lite` input 仅 `["text"]` 但 output 为
`["image"]`（出图模型，不是看图模型——只看 `input_modalities` 的判定天然
把它们排除，名字规律若只看 `-lite` 会误判，所以名字兜底里已删掉 `flash-lite`）。

另外，API key 的读取路径按 DSH 官方 provider 惯例改为**先经 credentials 服务
的参考层**（`ctx.get("credentials")?.resolve("AGNES_TOKEN_PLAN_API_KEY")`，对应
`~/.dsh/.credentials.yaml` 里用户级的 env 变量值），最后才回退 `process.env`。
旧代码只读 `process.env`，而很多机器（含本机）的 key 只存在 credentials 服务
里、`process.env` 里根本没有这条——所以旧版「读不到 key」并不等于「没有
key」，是读错了层。

**第二步（本期已实现，opt-in）**：把第一步算出的可看图模型清单写进
**本插件自己那一行 DSH settings**（`imageModelIds` / `visionModels`
两个字段，走 DSH 官方写路径
`settings.update(rowId, patch, revision)`），供后续
LLM connect 插件读取，从而让 DSH 的图片
offload 链路知道这把 Key 里哪些模型可以接图。

设计守口（对应 §5 大统一的不变量：opt-in 默认关、失败降级不拖垮宿主）：
- **只写本插件自己的 row**，绝不碰其它 provider（trae / workbuddy 等）
  的 `imageModelIds` 格子——算错一份模型清单，最坏影响的是面板自己的
  一行字，不会波及 DSH 的模型路由。
- **默认关闭**（`writeImageModelIds: false`）。不显式打开时，这个插件
  仍然只是信息层；打开后，Host 在每次 catalog poll 算出 `visionModels`
  后会幂等地写回本 row（清单没变就不写，不刷 revision 计数）。
- 写入是**旁路增强**：被拒/无 settings 服务时只打日志，poll 照常应答，
  面板照常显示——写不写成功不影响读的那一半。

宿主机器 `~/.dsh/profiles/*/cordis.patch.yml` 里已有 `imageModelIds`
与 `imageOverrides` 实例（该路径在宿主 profile 目录，不在本仓库），
trae 源码注释「Provider API 不暴露模态元数据，image 输入靠显式
`imageModelIds` 声明」对本插件读的这份目录**不成立**：平台已经暴露
`input_modalities`（见上），第二步只是把这份现成信息按 DSH 的
settings 写路径交出去，不做识别逻辑。

### 5.2 第三步：本插件直接注册 LLM provider（2026-09，opt-in）

第二步把信息「写给别的 connect 插件读」；第三步更进一步——开关
`registerProvider: true` 后，**本插件自己**调用 `ctx.llm.registerAdapter`
注册一个直连 `apiBase`（默认 `https://api.agnes-ai.cn/v1`）的
OpenAI 兼容 provider，用户不再需要手写 `llm-pi-ai` patch 行。

关键事实与守口：

- **provider id 用 `agnes-token-plan`，不能用裸 `Agnes`**：宿主
  profile 里可能已存在手写 `llm-pi-ai` 的 `Agnes` 行，重名
  注册会被 `registerAdapter` 以 DUPLICATE_ADAPTER 拒绝。同时注册
  `registerConfigurableProviders`（`settingsNs` 为本插件自己的 row，
  `declared:false`），让模型设置页出现该 provider 的配置入口。
- **Key 仍是同一个引用**：面板「接入 API」区把 `sk-` Key 以
  `AGNES_TOKEN_PLAN_API_KEY` 引用存进 DSH 凭据服务（`api-key-store.ts`），
  `process.env` 兜底；与手写行读取的引用名相同，一份值两边都亮。
  Key 在适配器里是**每次请求现取**（`resolveApiKey`），轮换 Key 无需
  重新注册；任何快照/路由响应只回布尔状态与来源标签，永不回显明文。
- **模型清单来自 catalog，vision 自动识别**：`/v1/models` 的完整 entry
  经 `llm-models.ts`（**无 peer 依赖**，离线可测）映射成 pi-ai descriptor：
  vision 判定复用 §5.1 同一份 `identifyVisionModel`，vision 模型自动带
  `input:["text","image"]`。两个承重字段：`compat.supportsDeveloperRole:
  false`（不设会自动探测成 true，该端点持续 403）；**不声明 maxTokens
  值**（声明了会变成输出上限、截断长回复，只钉字段名 `max_tokens`）。
- **catalog/勾选清单是插件私有状态，不进 dsh 配置**：
  `catalog-store.ts` 写 `$DSH_HOME/state/<profile>/<name>/catalog.json`（按 profile 分段，见 [PITFALLS.md](./PITFALLS.md) §23）
  （version 载荷、temp+rename 原子写、0600/0700、损坏即忽略），
  存 catalog entries 与 `enabledModelIds` 允许清单（**空数组=不过滤**，
  全新安装默认提供全部模型）。重启后、首次轮询前就靠这份缓存先注册。
- **刷新=重建+重注册+广播**：`PiAiAdapter` 内部按 profiles 快照记忆化，
  所以 catalog/允许清单变化时整体重建 adapter、替换注册并
  `ctx.emit("llm/adapters-updated")`；注册失败回滚旧 pair，不拖垮正在
  服务的模型。快照用「id+vision 位+允许清单」签名去抖，catalog 一小时
  缓存、面板 30 秒轮询也不会反复重注册。
- **peer 依赖懒加载**：`llm-adapter.ts` import Host 发行的
  `@earendil-works/pi-ai` / `@deepseek-ai/dsh-llm-pi-ai` /
  `@deepseek-ai/dsh-llm`，干净检出解析不到，所以 index.js 只在开关开启
  且 `ctx.get("llm")` 存在时动态 `import("./llm-adapter.js")`；无 llm
  服务、peer 加载失败都降级为「面板照常用、provider 缺席」，并把
  去密错误带进快照 `llm.providerError`。图片两 hook
  （`resolveAttachments` / `resolveImageAccess`）必须接，否则图片消息
  直接 UNSUPPORTED_CONTENT。

### 5.3 同类插件生态事实（本机核实，2026-09-29）

大统一的可行性依据：DSH 生态里已有同类插件把其中几块能力做成了单包现实。
本表是 2026-09-29 核实到的快照，后续吸收哪块能力，先回到这里对形态。

| 插件 | 核实到的形态 | 对本项目的意义 |
|---|---|---|
| `@alaxrpg/dsh-sensenova-provider`（desktop） | **直接竞品**：同样走商汤 OIDC+PKCE、注册 LLM provider，带多 Key 轮换与 vision | 证明「额度 + provider 合一」在 DSH 生态成立；其多 Key 轮换是本插件没有的能力，但 Token Plan 同账号共享额度池、换 Key 不换池，**不吸收**（见 [ROADMAP.md](./ROADMAP.md) §1） |
| `dsh-retry-boost` | 429 自愈网关：多 Key 池化、AIMD 限速；专门处理 SenseNova 把「配额不足」（insufficient_quota）混进 429 被误判重试的问题 | 429 自愈模块的同类先例；吸收时必须区分「限频（可退避重试）」与「配额不足（换 Key / 停）」 |
| `dsh-draw-router` | 绘图路由，含 `sensenova-u1-fast` 出图（同一模型在现行 catalog 里叫 `Agnes-u1-fast`） | 出图路由的对接参考（`Agnes-u1-fast` 即 catalog 里 output 为 `["image"]` 的出图模型，§5.1 已识别）；参考件放 `upstream/dsh-draw-router/` 作对照 |
| `mmx-quota-tool` | 聚合面板基准：实时积分面板、跨 provider 汇总、用量告警 | 面板 UX 基准（实时性、告警形态）向它对齐；跨 provider 聚合本身**不**吸收 |
| `dsh-provider-quota` / `dsh-musage` | 品类对照：泛化的「provider 额度面板」 | 定位边界样本：本插件不泛化成通用额度面板，只深耕商汤 |
| `dsh-codearts-auth`（`upstream/deepseek-harness-codearts-master`） | **多 provider 聚合登录插件**：codearts / buddy / workbuddy / lobsterai / qoder / loomy / raccoon / trae 各写一套自有登录流（IAM OAuth、扫码轮询、短信），凭据一律进 DSH 凭据服务；其中小浣熊走微信扫码——因官方深链回调 `office-raccoon://auth/callback` 写死、宿主 Node 收不到 | 「自有登录 + 凭据服务」形态的完整先例（与本插件同机制）；其跨 provider 泛化正是 §5 不变量 3 划出的边界，**不吸收**。小浣熊部分的事实见 [ROADMAP.md](./ROADMAP.md) §6.1.1 |

**代价核实（同日二次核实，2026-09-29）**：上表核实的是「形态存在」，这里补「维护代价」的实测快照。GitHub 查询：`alaxrpg/dsh-sensenova-provider` 最后推送 2026-09-26、0 star、2 个开放 issue（活跃）；`hhb1028/dsh-retry-boost` 最后推送 2026-09-03（4 star）；`Thedeergod666/dsh-musage` 2026-08-31（6 star）；`mtty-ai/mmx-quota-tool` 2026-08-16（2 star）。由此钉住两件事：其一，这批存在性证明全部是**个人维护、个位数采用**的插件，没有一个经受过规模检验——§5 决议的真实依据强度是「单包可行」，不是「已被验证的成熟路线」；其二，本机这批插件一个都没安装（仅 `upstream/` 参考件），本机事实上已经只跑本插件。这把执行纪律（每块吸收都挂快照契约 + e2e 门禁，[ROADMAP.md](./ROADMAP.md) §2.3 顺序约束）从谨慎升级为必需。

### 5.4 出图对接点：dsh-draw-router 源码级对照（2026-09-29）

对象：`upstream/dsh-draw-router/repo/lib/index.js`（495 行，v0.1.1）。
结论先行：**判定我们已有且更准、出图执行只有约 80 行、中间不存在需要
谈判的协议**——大统一走吸收（下述接法 B），接法 A 仅在想保留
draw-router 的多源能力时才有意义。

| 维度 | dsh-draw-router（现状） | 本插件（现状） |
|---|---|---|
| 出图模型识别 | 名字正则 `DRAW_MODEL_PATTERNS`（line 25-34：`/image/i`、`/u1-fast/i`、`/wan/i`、`/flux/i`…命中才认），探测自己另调一次 `GET /v1/models` | `modality.ts` 三级判定：`output_modalities` 字段优先 → `agnes-image-*` 名称兜底 → 默认 `text`，catalog 每小时已有 |
| 识别质量 | 实锤会漏：两把出图模型 `Agnes-u1-fast` / `Agnes-u1.5-lite`（§5.1）里，前者因 `/u1-fast/i` 是子串匹配仍能命中，**`u1.5-lite` 一条正则都不命中**——装它配同一源，`draw_image` 默认永远挑不到 u1.5-lite | 两把都识别 |
| 出图执行 | `buildEndpoint` 拼 `{base}/v1/images/generations`（line 72-79）→ `POST {model, prompt, n, response_format}` → 取 `data[0].url / b64_json`（line 209-261），约 80 行 | 无（待吸收的全部增量） |
| 凭据 | 明文写进插件目录 `draw-config.json`（line 140-151） | DSH 凭据服务，不落盘 |

对接的两种接法：

- **接法 A（喂信息，零改对方）**：快照/设置行加一份 `imageGenModels`
  （与 `visionModels` 同姿势，同一份 catalog 换个判定方向），预填
  draw-router 的 `manualModels`——它每个 source 本来就支持 `addModel`
  （line 470-477），`drawModels()` 会合并 `detected + manual`
  （line 180-186），我们的清单进去后正则漏识别的问题直接消失。
- **接法 B（吸收，大统一路线，推荐）**：Key（凭据服务 `AGNES_TOKEN_PLAN_API_KEY`）、
  apiBase、catalog、轮询基建本插件全有，吸收的增量只是上面那 80 行执行 +
  用自己的结构化判定替掉正则。它 495 行里其余约 400 行（多源管理、
  DashScope 异步任务、其它厂商特判）按 §5 不变量 3
  **不吸收**——那是「跨 provider 通用绘图」的边界外。

顺手可借的小件：probe 失败 30 秒 cooldown（line 196）；
lifetime `AbortController` + `AbortSignal.any` 超时合并模式（line 103-115）。

**接法 B 已落地（2026-09-29，`draw.ts` + `index.ts` 接线）**：

- 工具名 `agnes_draw_image`（带前缀，避免与 dsh-draw-router 的
  `draw_image` 撞名），配置开关 `drawEnabled`（默认关）+ `drawModelId` +
  `drawTimeoutMs`；只有 `drawEnabled === true` 且 Host 有 tools 服务时才
  动态 `import("@deepseek-ai/dsh-tools")` 注册——无 tools 服务、peer 加载
  失败、注册被拒都降级为「工具缺席、面板照常」，与 §5.2 的降级同型。
- 识别走 `modality.ts` 的 `isImageGenModel`，与对话侧的 `isChatModel` **由同一个
  函数解析模态**，两份清单不可能互相矛盾；
  Key 每次调用现取（`resolveApiKey`，轮换即生效）；失败分诊沿用 429 纪律
  （`insufficient/quota` → 配额问题，别重试；其余 429 → 限频，等再试）；
  失败后 30s 冷却（借自上游 line 196）。
- 快照契约**零改动**（13 键不动，`API.md` 不变）：工具要么在要么不在，
  agent 直接可见；面板不新增展示。

**视频吸收（接法 B 对称，2026-10-01，`video.ts` + `index.ts` 接线）**：与出图共用同一套
「存私有状态 + 面板开关 + 挂载时读生效值」机制，差异只在协议——

- 工具名 `agnes_video_generate`，配置开关 `videoEnabled`（默认关）+ `videoModelId` +
  `videoTimeoutMs` / `videoWidth` / `videoHeight` / `videoNumFrames` / `videoFrameRate`；
  与 `agnes_draw_image` 同一挂载阶梯（`lifecycle.ts` 的 `mountAgentTool` 私有包装），
  **同一套降级**（无 tools 服务 / peer 加载失败 / 注册被拒 → 工具缺席、面板照常）。
- 图片**同步**返回、视频是**异步任务**：`video.ts` 的执行体是 `createVideoTask` →
  `pollVideoResult` 状态机，而不是 `draw.ts` 的一次 `drawOnce`。端点构造与查询响应解析
  见 [AGNES-API.md](./AGNES-API.md) §7.5。
- **只覆盖 V2.0 参数体系**（`width`/`height`/`num_frames`/`frame_rate`）。名字含 `2.5`
  的家族（`agnes-video-2.5` / `agnes-video-2.5-flash`）走 `mode`/`seconds`/`size`/
  `aspect_ratio`，与 V2.0 **互斥**，混发会被 400 拒绝——所以 `pickVideoModel` 只在 V2.0
  家族里选，2.5 家族进 `video25ModelIds` 单独上报给面板说明「为什么选不到」。`test/video.test.mjs`
  9 段直接覆盖这条分派。
- 视频**没有 30s 冷却门**：一次视频尝试耗时分钟级、且与出图共用同一视频限频池，
  协议自身延迟已远宽于 30 秒；冷却门在此是死代码（决策见 AGNES-API.md §7.5.1）。
- 快照契约新增视频键（仍是 `llm` 块内的子键，顶层键数不变）：`videoEnabled` / `videoSource`
  / `videoModel` / `videoCandidateIds` / `video25ModelIds`。

**前提反转（2026-10-01 真机）**：上表「本插件」一列原先写的是「结构化判定
（`output_modalities`）」。这个前提**只在 SenseNova 目录上成立**。Agnes 网关
（new-api 血统）的 `/v1/models` 条目只带 `id` / `object` / `created` / `owned_by` /
`supported_endpoint_types`，**没有任何模态字段**。于是同一个缺失字段让两个判定朝
**相反方向**失手——恰恰是本表承诺「不可能互相矛盾」的那一对：

- `isImageGenModel` 严格方向（缺字段 = 未知 = 不是出图模型）→ 出图工具一个候选都
  选不出来，面板报「暂无出图模型」，而目录里明明列着 `agnes-image-2.5-flash`；
- `isChatModel` 宽松方向（缺字段 = 对话）→ 全部 image / video 模型被挂进对话
  选择器，用户一选就 `400 模型 … 是 image 模型，请使用 /v1/images/generations`。

修法不是推翻「结构化优先」，而是**补齐**它：`modality.ts` 仍把声明字段放在第一
优先（平台将来补字段即自动生效），只在字段缺席时退回**平台自己的命名段**
（`agnes-image-*` / `agnes-video-*`）。两个判定改为共用这一个函数，矛盾由构造
消除而非靠约定维持。判据与真机取证见 [AGNES-API.md](./AGNES-API.md) §7.1 / §7.5。

### 5.5 边界裁定：第二上游（小浣熊）属于界内（2026-10-01）

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

## 6. 与上游 Python 工具的差异（给移植 / 对照用）

- **凭据安全**：上游明文 `accounts.json`；本插件零明文、零调试日志，仅经 DSH 凭据服务。
- **续期策略**：上游过期即重登（依赖明文密码）；本插件同样以重登为唯一续期路径（Agnes 不发 refresh token），但密码可从环境变量删除——删掉后只是失去「自动重登」，面板会明确要求手动登一次，而不是静默失败。
- **节流**：本插件显式区分「时间型拒绝（锁号/限频）照单全收平台声明窗口」与「凭据型拒绝（错密码）绝不自动重试」，专门防锁号；上游无此分层。
- **接口知识可复用**：上游的 JWT 解析、`upstream/auth_login.py` 的登录封包，仍是理解商汤体系登录形态的对照参考（本插件的 Agnes 一跳登录已不需要封包，见 [AUTH.md](./AUTH.md) §3）。

---

## 7. 相关文档

- [SETUP.md](./SETUP.md) — 安装、配置、重启注意事项
- [AUTH.md](./AUTH.md) — 认证、续期、节流设计
- [API.md](./API.md) — 路由与控制台端点、配置字段
- [TESTING.md](./TESTING.md) — 测试体系与已知缺口
- [CONTRIBUTING.md](./CONTRIBUTING.md) — 提交约定与红线
