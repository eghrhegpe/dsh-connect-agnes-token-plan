# 架构（Architecture）

本仓库 `dsh-connect-agnes-token-plan` 是 DeepSeek Harness 的一个**插件**，在 Harness Web UI 的 **Plugins 页**以插件卡提供 Agnes 控制台 Token Plan 的实时额度面板。它还**不是**一个独立可运行程序，而是挂在 Host（桌面版 / `dsh web`）里的一截逻辑。

本文讲清三件事：插件与 `upstream/` 的关系、插件内部的 Host/Client 分流、以及数据如何流动。

---

## 1. 与参照件容器 `upstream/` 的关系

本仓库根目录下有一个 **被 `.gitignore` 忽略的 `upstream/`** 目录。它是**参照件容器**，不是「本插件的上游应用」：里面并排放着若干**独立 git 仓库**（各占一个用仓库原名命名的子目录，浅克隆、多数自带 `.git` 与 remote，少数为上游 zip 解包 / 本机快照）与**本机快照**（如桌面端 `app.asar` 解包）。承重件的来源、版本与「承重在哪」登记在 [REFERENCES.md](./REFERENCES.md)。

历史上游是商汤时代的 Python 桌面工具 [shaobingtongzhi/sensenova-usage-dashboard](https://github.com/shaobingtongzhi/sensenova-usage-dashboard)——它曾以 `upstream/sensenova-usage-dashboard` 的形式从 `~/.dsh/fork/` 移入此处，其算法（登录 OIDC 流、密码 JWE 封包、用量接口解析）已吸收进本插件的 Node 实现；**该本地副本现已不在本机**（`upstream/` 与 `~/.dsh/fork/` 均已无），需要时按本节末尾的命令 `git clone` 恢复。下表保留它与本插件的差异对照，作为「为什么最终不沿用那套形态」的记录。

| 维度 | `dsh-connect-agnes-token-plan`（本仓库） | `sensenova-usage-dashboard`（历史上的游 Python 工具，现不在本机） |
|---|---|---|
| 形态 | DSH 插件（Host 半边 + Client 半边） | 独立 Python 桌面应用（pywebview 原生窗口） |
| 语言 | Host 半边与 Client 半边均为 **TypeScript 源码**（`src/host/*.ts` + `src/client/*.ts`），经 `npm run build`（tsdown）构建为 `lib/`（Host 单条 ESM bundle + 动态切分 chunk）与根 `client.js`（Client IIFE 产物）；`lib/` 与 `client.js` 为纯构建产物、**随库提交**（git/市场直装克隆即可用——pnpm 的 `packageShouldBeBuilt` 见 main 在克隆里即跳过整条构建管线），删后可从 `src/` 重建 | Python（`dashboard.py` + `auth_login.py`） |
| 账号凭据 | 走 **DSH 凭据服务**（`~/.dsh/.credentials.yaml`），无明文文件 | 明文存 `accounts.json`（为支持自动重登） |
| 令牌续期 | **Agnes 不发 refresh token**：令牌失效即用存下的账号名 + 密码**重登一次** | JWT 过期后用明文账号密码**重登** |
| 登录节流 | 区分时间型 / 凭据型拒绝，防锁号 | 仅基础重试 |
| 与控制台交互 | `/api/usage/overview` / `/api/usage/series` / `/api/cn/user/subscription` / `GET /v1/models` | 商汤时代的 `pool-usage` 等接口 |
| 是否进本仓库历史 | 是（本仓库主开发目标） | **否**（gitignored，保持独立 git 历史与 remote） |

**为什么要这样放：** 上游 Python 工具是这套商汤控制台集成的「原始实现 / 参考源」，里面沉淀了接口字段、打包（`build_mac.sh` / PyInstaller `.spec`）、登录封包等可复用知识。把它以**被忽略的 `upstream/`** 形式容纳进本仓库，既能随时对照、复用其接口与打包经验，又不会污染本插件仓库的提交历史，也不会把明文凭据文件（`accounts.json`）带进版本库。插件在**构建期与运行期都不依赖 `upstream/`**——两者只是概念上的上下游，没有代码耦合。这条「容器」姿势此后被沿用成通用做法：AgnesCode 线的参照件与本机探测快照（含桌面端 `app.asar` 解包）同样落在 `upstream/` 下，一律不入库（见 [REFERENCES.md](./REFERENCES.md)）。

> 容器内每个 git 仓库各自完整，直接 `cd` 进去 `git` 操作即可，与外层仓库互不影响。**历史上游副本当前不在本机**，需要时按下面这条恢复（恢复后仍落在 `upstream/` 下、仍被忽略）：
> `git clone https://github.com/shaobingtongzhi/sensenova-usage-dashboard upstream/sensenova-usage-dashboard`

---

## 2. 插件内部结构：Host 半边 vs Client 半边

插件分两半，加载时机与改动代价完全不同：

| 半边 | 文件 | 加载时机 | 改动后如何生效 |
|---|---|---|---|
| **Host（服务端）** | `src/host/*.ts`（模块清单以该目录为准，另有 `src/host/token-store/` 与 video 家族等子级拆分；经 `npm run build` 构建为 `lib/`） | 启动时加载一次 | **重新构建 + 完全退出 DSH（含托盘）再启动**，`dsh web` 不会热重载 |
| **Client（前端）** | `src/client/*.ts`（前端模块，构建为根 `client.js`；模块清单以该目录为准） | 浏览器侧，随页面加载 | `npm run build:client` 重建后浏览器刷新即可 |

- `index.ts`：注册只读路由 `/api/dsh-connect-agnes-token-plan/snapshot`（聚合控制台数据，401 自动重登重试一次）+ 账号 / API Key / 模型清单 / 出图开关 / 视频开关 / AgnesCode 配置路由；模块装配与生命周期接线在 `lifecycle.ts`。
- `host-config.ts`：配置契约——`CONFIG_DEFAULTS`、`resolveSettings` / `resolveAuthOverrides`（含嵌套 `auth:` 块拒绝）、`isAdmitted` 同源闸、`hostName` 解析。
- `codes.ts`：全部错误码与平台原因码的唯一声明处。`agnes-auth.ts` 产出、`token-store.ts` 判定是否 parked、`routes/snapshot.ts` 判定是否属于「拿不到令牌」，三处都从这里取——新增一个平台原因只需改这一个文件。
- `token-store.ts` + `token-store/`：凭据服务里的令牌与账号存取、按期重登、401 拒绝记忆。子目录按职责拆成 `account` / `acquire` / `renewal` / `grant` / `throttle` / `state` 六块（拆分蓝图见 [TOKEN-STORE-SPLIT.md](./TOKEN-STORE-SPLIT.md)，行为由 `store-baseline.test.mjs` 冻结）。
- `throttle-store.ts`：登录节流状态，写在插件自己的状态文件（`$DSH_HOME/state/<plugin>/throttle.json`，原子写、0600），跨进程跨重启生效。
- `agnes-auth.ts`：**一跳**账号密码登录（`POST {consoleBase}/api/user/login`）+ 失败分类 + `Retry-After` 解析。`refresh()` 永远抛 `NO_REFRESH_TOKEN`，store 靠这个码落到重登。没有 OIDC / PKCE / JWE。
- `console-client.ts`：控制台与模型目录的网络请求，带信封解包（`{code,message,data}`）、短生命周期缓存与 single-flight（并发轮询只发一次请求）。
- `parsers.ts`：响应解析层——字符串数值 / epoch / ISO 归一、`checkShape` 漂移检测、`parseUsageSeries` 分桶求和、`quotaWindows` 四窗口、`matchCurrentPlan` 套餐匹配、`identifyVisionModel` 视觉模型识别。
- `snapshot-aggregate.ts`：快照路由的数据聚合（peer-free）——并行取数 / 解析 / 形状漂移 / 四窗口与累计用量组装 / vision 识别 / `llm` 状态块组装。HTTP 面在 `routes/` 家族（见下条），聚合逻辑在此，`test/routes.test.mjs` 可无容器地钉住每个分支。
- `routes.ts` + `routes/`：路由的门面与分册（2026-10 拆分，照 token-store 术式先冻结再搬——`routes.test.mjs` / `agnescode.test.mjs` / `wiring.test.mjs` 拆分前后计数一致零漂移）。`routes.ts` 只保留 `registerRoutes` 门面（wiring 注入、注册顺序、每个路由一个 `off()` 回执）；子目录按域拆成 `http`（`writeJson`、同源闸拒答、限额 body 读取等共享原语）/ `snapshot` / `account` / `api-key` / `provider` / `models` / `tool-switch`（draw 与 video 共用一份 handler 体）/ `agnescode`（switch / harvest，route 作用域状态）八块。
- `trace.ts`：登录 trace 落盘（成功/失败，值级脱敏，仅留最近 20 个，权限 0600）。
- `util.ts`：共享工具函数（`str` / `num` / `obj` 等类型安全读取器）。
- `admission-audit.ts`：同源闸的旁路审计——「不带 `Origin` 的写请求」记一笔（次数/时间/归一化方法名，不含任何头值），供 `doctor` 事后可见；放行结论不受它影响（见 [PITFALLS.md](./PITFALLS.md) §35）。
- `state-store.ts`：按 profile 分段的状态文件读写基建——版本载荷、temp+rename 原子写、0600/0700、短 TTL 读缓存、§23 一次性继承缝（见 [PITFALLS.md](./PITFALLS.md) §23）。
- `switch-store.ts`：**四个 opt-in 开关商店共用的一层**（provider / draw / video / AgnesCode）。「面板存过的值胜过配置默认值」+ 一个可选的 model 偏好，四份曾经互相复制；现在只有各自不同的事实（文件名、形状版本、偏好 wire key、报错措辞）留在 `provider-store.ts` / `draw-store.ts` / `video-store.ts` / `agnescode-switch-store.ts` 里，其余全在这一层（行为由 `test/switch-store.test.mjs` 对四者逐项冻结）。
- `switch-precedence.ts`：「**面板存过的值 vs 补丁声明的默认，谁说了算**」的唯一裁决处——`resolveSwitchEnabled` / `resolveSwitchValue` / `readPanelValue` 三个函数承载所有 opt-in 开关的优先级判定，并连同「值来自哪（panel / config / off）」一起返回（面板要拿来源告诉操作员哪一侧在生效）。此前这条规则被手抄在 11 处、有两种长得像但语义不同的方言（AgnesCode 因根本没有配置默认，无默认那一型必须落到 `off`）；统一到这里后，任何一处再自己拼 `?? settings.x` 都会由 `test/switch-precedence.test.mjs` 钉红（见 `test/switch-precedence.test.mjs` 的接线钉）。
- `publish-core.ts`：两个 provider publisher 共用的**发布控制面**（peer-free）——publish 队列（`publishChain` 串行化）、`disposed` 闸、单点 `registerProviderPair` 与回滚路径（PITFALLS §18/§19）、构建失败的脱敏描述与告警，以及「必须没有注册」的统一出口 `unregister`（它一并清 `state.built`——残留的旧 `built` 会成为下一次发布失败时的回滚目标，等于把一只已释放的适配器重新注册上去）。**故意不共享**的是 publish 闸与状态形状：Token Plan 侧读「开关 + 持久化目录 + 白名单」，AgnesCode 侧读「开关 + 采到的凭据 + 逐账号 base」，那属真实领域差异。拆分蓝图见 [PUBLISH-CORE-SPLIT.md](./PUBLISH-CORE-SPLIT.md)，行为由 `test/publish-core.test.mjs` 就地冻结。
- `provider-publish.ts`：Token Plan provider 的发布状态机**薄壳**（peer-free）——只保留本侧独有的两件事：publish 闸（面板开关优先、回落补丁 `registerProvider`，经 `switch-precedence.ts` 裁决）与状态形状（目录 / 白名单 / 额度耗尽集合）；机制在 `publish-core.ts`。从 `index.js` 抽出，使路由层保持轻量；`index.js` 驱动它，`test/wiring.test.mjs` 经此模块注入并发 publish 门控。
- `llm-models.ts` / `llm-adapter.ts` / `pi-ai-adapter-core.ts` / `llm-retry.ts` / `llm-error-fix.ts`：推理侧的纯逻辑映射（无 peer，离线可测）、依赖 peer 的适配器半边、**两条路由共用的适配器组装核心**、429 退避策略、以及 peer 对限频 429 的误判纠正（`isQuotaExceededError` 命中面过宽，带额度措辞的 429 被抢判成 `QUOTA` 而不重试）。后两者与 `llm-adapter.ts` 的关系是「机制共享、配置分离」：`pi-ai-adapter-core.ts` 装惰性 auth 平面、图像预算与两个图像 hook、以及 429 纠正 Proxy，两个 shell 只保留各自不同的事实（provider id、花名册构造、凭据解析器、profile 的 `reasoning` 默认）。**为什么不各自留一份**：那层 Proxy 是打在不可改 peer 上的补丁、带自己的到期日，手抄两份的结果是「改一处漏一处」，让某条路由带着 peer 的 429 误判继续上线——与 `publish-core.ts` 对两个 publisher 的处理同源。
- `draw.ts` / `draw-store.ts`：出图工具（`agnes_draw_image`）与它的面板开关。
- `video.ts` 家族（2026-10 四刀拆分，照 token-store 术式先冻结行为再搬——`test/video.test.mjs` 拆分前后对同一 barrel 全绿零漂移）：`video.ts` 保留 `agnes_video_generate` 工具定义与兼容 barrel 全表面；`video-protocol.ts` 装端点构造（含「国际站陷阱」与 `/v1` vs `/agnesapi` 路径不对称）、V2.0 帧制请求体、任务应答解析与失败分诊；`video-protocol-25.ts` 装 2.5 秒数制请求体（与 V2.0 字段互斥，混发必 400）；`video-models.ts` 装目录花名册与家族选型；`video-client.ts` 装「建任务 → 轮询」异步状态机（含刻意不设 30s 冷却门的裁定）。
- `agnescode*.ts`：桌面端上游（AgnesCode）——本机登录态采集（Chromium os_crypt + DPAPI，逐文件分诊）、逐账号 BFF base 钉域、独立 store / publisher / provider id / 开关，与主链路完全隔离（ROADMAP §6.3）。其 publisher 与主 provider **共用 `publish-core.ts` 的机制、不共用状态**，其 adapter 与主 provider **共用 `pi-ai-adapter-core.ts` 的组装机制、不共用 profile**：隔离针对的是状态实例（AgnesCode 的开关翻转/重采/目录漂移不可能注册、释放或扰动 Token Plan 那一对），把机制复制两份换不来隔离，只换来会分叉的两份回滚与两份补丁。**已知限制**：AgnesCode 无刷新端点（JWT≈28 天），续期须用户重开桌面 App 后重新采集，无自动续期路径——这是上游形态决定的限制，不是本插件能力缺口。
- `client.js`：Plugins 页内的配置卡与三个 tab（积分额度 / 接入 API / AgnesCode）+ 账号表单（React，纯主题令牌样式）。内部 `interpretSnapshot` 把 Host 的响应读成 `(data, error)` 对，再交给决策块。
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
   - 有数据 → 「我的额度」section（套餐身份 + 四窗口池 + vision 模型行）
      + 「套餐对比（{count} 档）」section（默认折叠，始终由用户点击开合）
      + 「我的用量」section（windowNote 诚实声明 + 账号累计用量 + 近 N 天柱图）
   - 控制台未连接（quota.consoleConnected:false）→ 额度 tab 内明说，
     并把登录卡展开；另两个 tab 不受影响
   - 需配置账号且完全没有 body → 额度 tab 内是 AccountForm
   - config_error / console_error → 纯文本提示（登录解不了的问题：
     前者是配置写错，后者是控制台没应答，下一轮通常自愈）
   - 顶栏是 shell，不是页面标题：barPlan 决定「更新于」/ 令牌 chip / 刷新
     按钮属于哪个 tab（AgnesCode 有自己的路由与 60s 节奏，由它自己发布
     自己的时间戳与 loader；接入 API tab 用的是同一份快照的 llm 块）
   - 登录表单的倒计时**来自 Host 下发的 auth 块**，不是组件本地 state：
     节流是跨进程跨 profile 共享的机器级状态（throttle.json），所以
     servedWaitMs(auth) 是「有没有在等」的唯一判定，AccountForm 用它播种
     并单调吸收后续窗口；已停车（needsUserAction：等待解决不了）时给的是
     一句话而不是倒计时。字段契约见 API.md「auth 块的两个节流字段」
```

关键点：**HTTP 永远 200**，成败靠 body 里的 `ok` 与 `code` 区分；`auth` 块会随失败一起下发，所以连不上控制台时面板也能说出「令牌是否能自愈」。

**为什么 `overview` 仍然单独先取、却不再是唯一致命的**：单独先取的理由没变——它是认证探针（最便宜的认证调用，任何已登录账号都能发），且**串行**放在其余取数之前，是因为它 401 时会先把令牌换新，后面的批量才拿着活令牌出门（`test/routes.test.mjs` B 组钉死了「死令牌只被出示一次」）；未登录时它失败在本地（`not_configured`，不发请求），所以这个串行不花任何往返，稳态下也通常命中缓存。

变的是它**不再把失败变成整个快照的失败**。它曾经是唯一致命源：失败即冒泡到路由的 catch，整个 body 走 `ok:false`，面板只剩登录表单——把 API Key tab（不读控制台）和 AgnesCode tab（连的是另一个上游、有自己的凭据）一起埋掉，正是 §5 不变量 3 禁止的形状。现在它失败只意味着 `quota.consoleConnected:false`：`quota.totals` 是 `null` 而不是零值块（否则一次读取失败会被渲染成「0 次请求」——把失败伪装成测量），面板在额度 tab 内点名「控制台未连接」，另外两个 tab 一个点击之外。

---

## 4. 登录与令牌生命周期

详见 [AUTH.md](./AUTH.md)。一句话版：

1. 用户首次在面板填一次账号密码，Host 向 `{consoleBase}/api/user/login` 发**一跳** POST；密码是明文 JSON，只过 TLS（Agnes 没有 JWKS / JWE 封包端点，没有任何东西可以把它包起来，所以**传输层是唯一的保护**，而「绝不落盘」是承重设计而非整洁）。
2. 账号名与 access token 存入 DSH 凭据服务（记录 kind 只能是 `grant`；**密码不落盘**，`AGNES_PASSWORD` 环境变量是唯一持久来源）；此后**令牌失效就用同一路径重登一次**——Agnes 不发 refresh token，`refresh()` 恒抛 `NO_REFRESH_TOKEN`，store 正是靠这个码落到重登。
3. 令牌寿命优先读 JWT 的 `exp`，读不出则按 `fallbackExpiresInSeconds`（默认 7 天）估；提前 `tokenSkewSeconds`（默认 120s）触发重登；控制台返回 401/403 时也重登并重试一次（**只一次，不递归**：刚换的令牌也被拒说明问题在账号，再试只会敲锁）。
4. 每一次登录尝试（**成功也算**）都落一份脱敏 trace 到 `$DSH_HOME/logs/`，否则「浏览器能登、面板不能」无法对照排查。

---

## 5. 生态定位：大统一——商汤全过程集成的单点入口（2026-09-29 定位变更）

> 本章只写**当前**定位与三条不变量（现状）；历次划界的裁定、举证与取代链进 [ADR.md](./ADR.md)（ADR-001～ADR-003），失效裁定原文在 [ARCHIVE-BOUNDARY-DECISIONS.md](./ARCHIVE-BOUNDARY-DECISIONS.md)，生态核实快照在 [ROADMAP.md](./ROADMAP.md) §6.1.1 / §6.3。改动定位前先回账本，勿在本章内联修订补丁。

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
- **只吸收与 Agnes 产品线直接相关的能力**（现行上游：Token Plan 控制台 + AgnesCode
  桌面端），不做跨 provider 通用聚合——§5.3 里 `dsh-provider-quota` / `dsh-musage`
  的定位边界就是本插件的边界。这条界线的划法改过三次（Key/账号线 → 厂商归属 →
  Agnes 线，两次复测依据见 [ROADMAP.md](./ROADMAP.md) §6.1.1），裁定沿革登记在
  [ADR.md](./ADR.md)（ADR-001 ～ ADR-003），已失效裁定的原文在
  [ARCHIVE-BOUNDARY-DECISIONS.md](./ARCHIVE-BOUNDARY-DECISIONS.md)。
- **一个模块缺席，不许把别的模块一起埋掉**（2026-10-01 补记）：第一条不变量的推论，
  本插件自己违反过一次——控制台（地基）读不到时整个快照走 `ok:false`，面板只剩登录表单，
  把 API Key tab（根本不读控制台）和小浣熊 tab（另一个上游、另一套凭据）一起带走。
  现已改为 `quota.consoleConnected:false` 的软降级 + 客户端 tab 栏无条件渲染，
  数据流见 §3；诚实性要求同时成立：读不到的用量是 `null`，不是零值块（登记见 [ADR.md](./ADR.md) ADR-004）。

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
识别依据：**已确认（拉真实响应）**——该判据原是商汤 `/v1/models` 的形态
（每个条目带 `input_modalities` / `output_modalities` 结构化字段），但
**Agnes 目录条目只有 5 个字段**（`id`/`object`/`created`/`owned_by`/
`supported_endpoint_types`，见 [AGNES-API.md](./AGNES-API.md) §7.1），
`input_modalities` **完全缺失** → `identifyVisionModel` 在 Agnes 上**恒 false**。
所以**只靠目录读不到**——**不是「没有可看图模型」，是「目录没暴露该能力」**；
官方文档明说 `agnes-3.0-flash` / `agnes-2.5-pro` / `agnes-2.5-flash` 支持
「文本 + 图像 URL 输入」。

**✅ 已落地（2026-10）**：按 `PROBED_EFFORT` 的既有纪律，在 `src/host/llm-models.ts`
加了硬编码 `PROBED_VISION` 表（`agnes-3.0-flash` / `agnes-2.5-pro` /
`agnes-2.5-flash`），并经 `visionOf(entry)` 接入 descriptor / roster /
snapshot / `provider-publish`——`visionModels` **不再是空的**。判定顺序：**目录字段
→ 名字兜底 → 硬编码表 → 非 vision**，平台将来补 `input_modalities` 会自动胜出。
详见 [AGNES-API.md](./AGNES-API.md) §7.1.1。

名字规律兜底（`vl` / `vision`）保留作为「平台若某天不返回模态字段」的退路，
标 `source: "name"` 注明是按名字推断。**商汤时代的例子**（`deepseek-v4-flash` /
`glm-5.2` / `kimi-k3` input 仅 `["text"]`；`Agnes-6.8-flash-lite` input 为
`["text","image"]`；`Agnes-u1-fast` / `Agnes-u1.5-lite` output 为 `["image"]`）
已随迁移**作废**——这些模型不在 Agnes 目录里，仅保留作「字段判定 vs 名字兜底」
的机制说明：只看 `input_modalities` 天然排除出图模型；名字兜底已删掉
`flash-lite` 以免误判。

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
`imageModelIds` 声明」对本插件读的这份目录**大体成立**：Agnes 的 `/v1/models` 也
不返回 `input_modalities`，所以本插件不能只靠目录——而是像上文 §5.1 已落地的那样，
在目录之外再叠一层「官方文档声明」的 `PROBED_VISION` 硬表，把这份算出来的清单按
DSH 的 settings 写路径交出去。

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
  false`（不设会自动探测成 true，该端点持续 403）；**`maxTokens` 钉实测平台
  上限 65536**（真机探针 2026-10-01：65536→200、131072→400「max_tokens 不能
  超过 65536」；旧「不声明」决策被 harness 兜底推翻——`dsh-llm-pi-ai` 对未
  声明值强制填 32768，未声明≠无上限而是减半上限，见 AGNES-API.md §7.3）。
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
- **peer 依赖懒加载**：`llm-adapter.ts` 直接静态 import Host 发行的
  `@earendil-works/pi-ai` / `@deepseek-ai/dsh-llm`（`@deepseek-ai/dsh-llm-pi-ai`
  是经 `pi-ai-adapter-core.ts` 间接依赖，不在此文件的直接 import 面），
  干净检出解析不到，所以 `index.ts` 只在开关开启
  且 `ctx.get("llm")` 存在时动态 `import("./llm-adapter.ts")`；无 llm
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
| `dsh-draw-router` | 绘图路由，含 `sensenova-u1-fast` 出图（商汤时代命名，现行 Agnes catalog 里**没有** `Agnes-u1-fast`——出图模型是 `agnes-image-2.1-flash` / `agnes-image-2.5-flash`） | 出图路由的对接参考（§5.4）；参考件放 `upstream/dsh-draw-router/` 作对照 |
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
| 识别质量 | 实锤会漏：现行出图模型 `agnes-image-2.1-flash` / `agnes-image-2.5-flash` 里，`/image/i` 能命中 `-image-`，但若平台改名/加后缀（如将来出现 `agnes-img-*`）`/image/i` 就漏了——商汤时代的 `Agnes-u1.5-lite` 正是这种漏（`/u1-fast/i` 一条正则都不命中） | 两把都识别 |
| 出图执行 | `buildEndpoint` 拼 `{base}/v1/images/generations`（line 72-79）→ `POST {model, prompt, n, response_format}` → 取 `data[0].url / b64_json`（line 209-261），约 80 行 | 已落地（见下文「接法 B 已落地」） |
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

**接法 B 已落地（2026-09-29，`draw.ts` + `lifecycle.ts` 接线）**：

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

**视频吸收（接法 B 对称，2026-10-01，`video.ts` + `lifecycle.ts` 接线）**：与出图共用同一套
「存私有状态 + 面板开关 + 挂载时读生效值」机制，差异只在协议——

- 工具名 `agnes_video_generate`，配置开关 `videoEnabled`（默认关）+ `videoModelId` +
  `videoTimeoutMs` / `videoWidth` / `videoHeight` / `videoNumFrames` / `videoFrameRate`；
  与 `agnes_draw_image` 同一挂载阶梯（`lifecycle.ts` 的 `mountAgentTool` 私有包装），
  **同一套降级**（无 tools 服务 / peer 加载失败 / 注册被拒 → 工具缺席、面板照常）。
- 图片**同步**返回、视频是**异步任务**：执行体是 `createVideoTask` →
  `pollVideoResult` 状态机（2026-10 拆分后在 `video-client.ts`，原 `video.ts`
  保留工具定义与兼容入口），而不是 `draw.ts` 的一次 `drawOnce`。端点构造与查询响应解析
  见 [AGNES-API.md](./AGNES-API.md) §7.5。
- 工具覆盖**两个参数家族**：V2.0（`width`/`height`/`num_frames`/`frame_rate`）与
  2.5（`mode`/`seconds`/`size`/`aspect_ratio`，OpenAI 秒数制）。两套字段互斥，混发
  400——所以 `defineVideoTool` 按 `isVideo25Family(model)` 分派到 `buildVideoBody`
  或 `buildVideoBody25`，两套字段永不同时发给同一模型。`pickVideoModel` 认全量
  视频模型（自动选择 V2.0 优先、无 V2.0 回落 2.5；面板偏好可指任一家族），
  2.5 家族仍进 `video25ModelIds` 单独上报，面板据此点名「这些走秒数制参数，
  工具已支持、自动换算」（flash 收敛：仅 720P、reference ≤5）。`test/video.test.mjs`
  直接覆盖这条分派。
- 视频**没有 30s 冷却门**：一次视频尝试耗时分钟级、且与出图共用同一视频限频池，
  协议自身延迟已远宽于 30 秒；冷却门在此是死代码（决策见 AGNES-API.md §7.5.2）。
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

### 5.5 边界裁定沿革（已外置到账本）

现行边界就是上面 §5 的不变量正文；历次划界的裁定、举证与取代链登记在
[ADR.md](./ADR.md)（ADR-001 ～ ADR-003），失效裁定的完整原文在
[ARCHIVE-BOUNDARY-DECISIONS.md](./ARCHIVE-BOUNDARY-DECISIONS.md)。本节不再承载
裁定正文——「修订（日期）」式内联补丁由 `docs.test.mjs` 检查 `ARCHAEOLOGY` 禁止，避免沉积
再次把现行文档变成地层。

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
