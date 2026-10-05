# 安装与配置（Setup）

本插件随 Host（桌面版或 `dsh web`）运行，没有独立启动入口。

---

## 1. 前置条件

- **Node.js `^22.19.0 || >=24.0.0`**：仅用于跑测试（`npm test`）；`package.json` 的 `engines` 已钉此范围，运行时由 Host 提供运行时，无需本机装 Node 来跑插件本身。
- **DSH 运行时**：插件装在某个 DSH profile 下，由 Host 在启动时加载 `index.ts` 等 Host 半边文件。
- **凭据服务**：Host 需具备 `@deepseek-ai/dsh-credentials` 能力，账号与令牌才能落库。没有它时面板仍可打开，但账号只存内存（重启需重登，见 [AUTH.md](./AUTH.md)）。

---

## 2. 安装

**Web 与桌面端通用**。由带 `plugin_manager` 的会话（Creator 模式）执行，或在 **Web 的「插件」页**粘贴同一 target；较新版本 CLI 为 `dsh plugin --profile <profile> add <target>`（`web` / `desktop` 皆可）。target 三种形态：

| target 形态 | 值 | 适用场景 |
|---|---|---|
| npm 包名（推荐） | `dsh-connect-agnes-token-plan`（可钉版本，如 `dsh-connect-agnes-token-plan@0.10.0`） | 普通用户，无需 clone |
| git 地址 | `https://github.com/eghrhegpe/dsh-connect-agnes-token-plan` | 不经 registry 直接装 |
| 本地路径 | 本检出目录的绝对路径（如 `~\.dsh\plugins\dsh-connect-agnes-token-plan`） | 开发调试 |

```powershell
plugin_manager { action: "install_bundle", target: "dsh-connect-agnes-token-plan" }
```

- npm 形态装的是预构建 tarball：本包无安装脚本、无打包依赖（DSH 运行时走 peer，由 Host 提供），不需要 `allowBuilds` 构建授权；
- 安装器依次询问 profile 配置的 registry 与备用源（默认含 `registry.npmmirror.com`）；刚发布的新版本在镜像源同步可能有几分钟延迟，官方源 `registry.npmjs.org` 立即可用；
- 安装后，Harness **Plugins 页**出现本插件的配置卡（页内内联，不是侧边栏入口）；首次打开会提示连接 Agnes 控制台；
- **装完必须完全退出 DSH（含托盘）再启动**——Host 半边只在启动时加载一次；只改 `client.js` 时浏览器刷新即可。

### 环境隔离（历史注记）

2026-09-27 本插件曾作为**桌面端必需启动项**（`dsh.profile.bundles`），因往共享凭据库写入宿主不认识的 `kind: throttle` 记录，把桌面端直接炸到 startup failed（爆炸半径是整机插件全卡死）。该问题已修复——节流迁到插件自己的状态文件 `throttle-store.ts`（原子写、0600），凭据服务只认 `grant`/`api-key` 两种 kind（见 [PITFALLS.md](./PITFALLS.md) §6）。**2026-09-29 双端实测：web 与桌面端均可正常挂载运行，不再有任何 profile 限制。**

---

## 3. 配置

配置面就是本目录的 **`cordis.patch.yml`**，改完重新安装 / 重载生效；也可在 profile 的 `cordis.patch.yml` 里用 `- id: dsh-connect-agnes-token-plan` 覆盖同名字段。

| 字段 | 默认 | 说明 |
|---|---|---|
| `consoleBase` | `https://platform-backend.agnes-ai.cn` | 控制台**后端**源站（登录与额度接口的起点）。注意不是控制台前端 `platform.agnes-ai.cn`——那边 `/api/*` 是 Next.js 404 外壳 |
| `apiBase` | `https://api.agnes-ai.cn/v1` | OpenAI 兼容推理源站（模型目录与可选出图） |
| `usageDays` | `30` | 用量柱图回看天数（1–365）。**天不是小时**：控制台的 series 端点收 `start_date` / `end_date` 两个**日期** |
| `trendMultipliers` | `{}` | 模型花名册的**伪倍率**（自定义对比用，非官方数据）：键为模型 id 的大小写不敏感子串（按书写顺序首个命中生效），值为正数。面板以 `×N` 角标显示并附「非官方」说明。**默认为空是刻意的**——倍率原本用来缩放每模型积分消耗，而 Agnes 完全不公布按模型的用量，剩下的只是你自己的标注，没有可发布的默认值；显式设 `{}` 即全部关闭。非法条目（键空 / 值 ≤0 或非数字）被静默丢弃 |
| `cacheSeconds` | `60` | Host 侧缓存秒数；面板脚注直接引用此值 |
| `pollSeconds` | `30` | 面板轮询间隔，由 Host 下发、面板跟随（不再硬编码 30s） |
| `consoleTimeoutMs` | `15000` | 单次控制台请求超时（下限 1000） |
| `tokenSkewSeconds` | `120` | 提前多久续期，避免撞过期边界 |
| `allowedHosts` | `[]` | 追加可信 `Host` 名（默认 `localhost` / `127.0.0.1` / `::1`，**只增不替**） |
| `loginPath` | `""` → `/api/user/login` | 登录路径，平台哪天改了才需要动 |
| `loginTimeoutMs` | `0` → `15000` | 单次登录尝试的超时。登录要带密码、可能被限流，所以与 `consoleTimeoutMs` **不是同一个数**。`requestTimeoutMs` 是它的旧名，只在只设旧名时仍然生效 |
| `fallbackExpiresInSeconds` | `0` → `604800` | access token 不是可读 JWT 时假定的寿命（7 天）。**方向是刻意的**：估短了每轮轮询都要花一次真实登录，而 Agnes 有失败次数锁定 |
| `writeImageModelIds` | `false` | 视觉第二步（§5.1）：**opt-in**，是否把识别出的可看图模型清单写进本插件自己的 DSH settings row（`imageModelIds` / `visionModels` 两个字段），供后续 LLM connect 插件读取。默认关，纯读信息层 |
| `registerProvider` | `false` | 第三步（§5.2）：**opt-in**，是否由本插件直接向 DSH 注册 OpenAI 兼容 LLM provider（id `agnes-token-plan`，直连 `apiBase`）。开启后在面板「接入 API」保存 API Key 即可（免费版 `sk-` 或 Token Plan `cpk-` 皆可），catalog 轮询自动建/刷新模型列表；Agnes 目录**不带** `input_modalities`，看图识别恒为 false（见 `AGNES-API.md` §7.1），所以模型不带图片输入是「读不到」而非「测过没有」；catalog 与允许清单只存插件私有状态文件。默认关——注册模型源是 Host 级变更 |
| `drawEnabled` | `false` | 出图吸收（§5.4 接法 B）：**opt-in**，是否给 agent 注册 `agnes_draw_image` 工具（POST `{apiBase}/images/generations`，用面板保存的 `AGNES_TOKEN_PLAN_API_KEY`）。出图模型由 catalog 的 `output_modalities` **当平台声明时**识别，未声明时退回模型 id 里 `image` 段匹配（Agnes 目录**不带**这个字段，见 `AGNES-API.md` §7.1，名字兜底才是实际命中的路径）；Key 每次调用现取；失败后 30s 冷却。默认关——agent 工具是 Host 级变更；无 tools 服务的 Host 上该工具静默缺席。面板「接入 API」区有真开关（`POST /api/<name>/draw`），勾选保存后在插件私有状态文件里记录，立即生效、无需重启 Host |
| `drawModelId` | `""` | 首选出图模型 id；留空 = catalog 里第一把出图模型（按 `output_modalities` 字段 / `agnes-image-*` 名称判定，不写死示例）。工具调用显式传 `model` 时以调用为准 |
| `drawTimeoutMs` | `120000` | 单次出图请求超时（出图模型很慢，别用对话级超时）；下限 5000 |
| `videoEnabled` | `false` | 视频吸收（与 §5.4 接法 B 对称）：**opt-in**，是否给 agent 注册 `agnes_video_generate` 工具（**异步任务制**——建任务 POST `{apiBase}/videos`，轮询 `GET {host}/agnesapi`，协议细节见 `AGNES-API.md` §7.5）。覆盖 **V2.0 与 2.5 两个参数家族**：工具按选中模型分派请求体（V2.0 帧制 / 2.5 秒数制，互斥字段永不同时发出，见 §7.5.1 / §7.5.1b）。与出图同理：无 tools 服务的 Host 上静默缺席；面板「接入 API」区有真开关（`POST /api/<name>/video`）。默认关 |
| `videoModelId` | `""` | 首选视频模型 id（**V2.0 或 2.5 家族的 id 均可**）；留空 = catalog 里第一个 V2.0 视频模型，目录没有 V2.0 时回落到第一个 2.5 模型。工具调用显式传 `model` 时以调用为准 |
| `videoTimeoutMs` | `600000` | 一次视频**轮询**预算（分钟级；下限 30000）。工具截止 = 该预算 + 建任务截止（`VIDEO_REQUEST_TIMEOUT_MS` = 120s），覆盖「建任务 + 轮询」的最坏总时长——截止早于总时长会让 agent 丢失仍在服务端跑的任务的 video_id（2026-10-03 收口，原 60s margin 小于建任务截止） |
| `videoWidth` | `1152` | V2.0 帧宽，直传（2.5 模型只拿它做画幅就近匹配） |
| `videoHeight` | `768` | V2.0 帧高，直传（2.5 模型只拿它做画幅就近匹配） |
| `videoNumFrames` | `121` | V2.0 帧数，必须 ≤ 441 且 `8n+1`（81/121/161/241/441）；非法值被**拒绝**而非夹取（`AGNES-API.md` §7.5.1 解释原因）。2.5 模型未显式传 `seconds` 时用它就近换算整秒 |
| `videoFrameRate` | `24` | 帧率，1–60（2.5 模型未显式传 `seconds` 时参与秒数换算） |

端点类字段仅在企业镜像 / 预发环境指向别的主机时才需要动；全部不配即等于平台默认值。任意端点覆盖若不是合法的 http(s) 绝对地址，插件在**挂载时**就报 `config_error`（面板顶部显示），而不是等到第一次轮询才变成莫名其妙的网络错误。

> 上表主机层字段的默认值（含 `allowedHosts` 的 `localhost`/`127.0.0.1`/`::1`）统一定义在 `host-config.ts` 的 `CONFIG_DEFAULTS`，并由 `test/config.test.mjs` 与 `cordis.patch.yml` 双向钉住；登录类字段留空即表示"使用平台默认"，其生效值定义在 `agnes-auth.ts` 的 `AUTH_DEFAULTS`，不在此重复。
>
> **登录覆盖项是 patch 行的顶层键**（`loginPath`、`loginTimeoutMs`、`fallbackExpiresInSeconds`），**不是嵌套的 `auth:` 块**。嵌套块会被 loader 接受、被插件静默忽略，面板于是拿着出厂默认值打到**真平台**——这条已经锁过一次号，`resolveAuthOverrides` 现在对嵌套块直接抛错，别放宽它。

### AgnesCode 续期限制（已知，非特性）

AgnesCode tab 走的是桌面端登录态采集，**没有刷新端点**：会话 JWT 寿命 `exp−iat ≈ 28 天`，上游的 `auth-token-refresh-reservation` 只做失效检测、无续期实现。因此**续期是用户手动仪式，不是自动能力**——每约 28 天需重开桌面 App、再在 tab 里点「检测本机登录态」重新采集；插件无法在后台自动续期。这是上游形态决定的已知限制，别把它写成「点一下就永久好」的特性向用户描述（详见 `ROADMAP.md` §6.3 与 `ARCHITECTURE.md` 的 AgnesCode 线）。

---

## 4. 改动后必须重启 Host

**Host 半边（`index.ts` / `token-store.ts` / `agnes-auth.ts`）在启动时加载一次。** 改完这些文件，运行中的 `dsh web` 不会自动重载，必须完全退出 DSH 再启动（**托盘也要退**）。只改 `client.js` 时，浏览器刷新页面即可。

自查是否跑的是新代码——看快照接口的返回：

```powershell
(Invoke-RestMethod http://127.0.0.1:19387/api/dsh-connect-agnes-token-plan/snapshot).auth
```

- 有 `auth` 字段 → 新代码在跑；
- 没有 `auth`、而是 `totals` / `recent` 之类 → **跑的还是旧代码**，需要重启。

> 注意本机可能同时存在多个 dsh 进程：桌面版（默认 19387）与 `dsh web`（常见 3080）用的是**不同的 profile**。确认你打开的 GUI 连的是哪一个。

---

## 5. 首次使用

1. 打开 Plugins 页的插件卡，切到「积分额度」tab。
2. 点「连接 Agnes 控制台」，填一次账号与密码，点登录。
3. 之后令牌失效会自动重登（Agnes 不发 refresh token），无需再操作。面板底部可清除已保存账号。

登录失败的排查见 [AUTH.md](./AUTH.md)。

---

## 6. 常见信号与处置

| 面板 / 接口信号 | 含义 | 怎么做 |
|---|---|---|
| 面板顶部 `config_error` | 配置面有非法端点地址等挂载期错误 | 检查 `cordis.patch.yml` 的端点类字段（§3），改后重装 / 重载 Host |
| 快照带 `shapeWarnings` | 控制台返回结构与预期不符（如字段改名） | 对照 [AGNES-API.md](./AGNES-API.md) §2 核对接口字段——这是接口变更的第一信号，不是「暂无数据」 |
| 面板 `console_error` | 控制台没应答 | 通常是下一轮轮询自愈；持续出现再查网络与控制台状态 |
| `quota.error` 指名某个 source | 那一个额度源降级了（series / subscription / plans / overview），其余照常 | 看 `message` 里平台自己的话；当前实现将五个源一律软失败，`overview` 失败时面板会显示 `consoleConnected:false` 并保留其他来源数据。旧文曾写「overview 是致命源」，现已改为软降级（见 [ADR.md](./ADR.md) ADR-007 及 [ARCHITECTURE.md](./ARCHITECTURE.md) §5 不变量）。 |
| 快照接口没有 `auth` 字段 | 跑的还是旧代码 | 完全退出 DSH（含托盘）再启动（见 §4） |
| 面板提示需要重新登录 | 令牌被拒且环境里已无密码 | 面板表单填一次账号密码即可 |
| 面板「可看图」一行缺失，但 `/v1/models` 有模型 | 没有 API key，模型目录没拉（`catalogAvailable: false`），视觉清单随之不显示 | 在面板「API Key」卡粘贴 API Key 保存（免费版 `sk-` 或 Token Plan `cpk-` 皆可；写入 DSH 凭据服务引用），或在用户级 env 变量层配 `AGNES_TOKEN_PLAN_API_KEY`；下一轮 poll 自动亮起来，无需重启 |
| 「可看图」清单为空但 catalog 有模型 | Agnes 目录条目**不带** `input_modalities`（§7.1 实测只有 `id`/`object`/`created`/`owned_by`/`supported_endpoint_types` 五个字段），`identifyVisionModel` 只能读目录 → 恒 false | **这是「读不到」，不是「没有」**——官方文档（`docs/AGNES-API-docs/`）明说 `agnes-3.0-flash` / `agnes-2.5-pro` / `agnes-2.5-flash` 支持「文本 + 图像 URL 输入」。空清单不能当作「真没有可看图模型」的证据；要补 vision 需按 §7.1.1 的硬编码清单路线 |
| `quota.planUnknown`（界面文案键） | 订阅 payload 没有可匹配的套餐身份（uuid / 名称）时，面板用 i18n 文案键 `quota.planUnknown` 渲染一行说明——**它是 client 侧的渲染文案键，不是快照信号字段**；套餐对比卡照常显示（公开目录），当前套餐上限需要 `/api/cn/user/subscription` 返回可识别的套餐名或 uuid，见 [AGNES-API.md](./AGNES-API.md) §5 |
