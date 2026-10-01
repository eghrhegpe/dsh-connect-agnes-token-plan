# 接口与端点（API）

分两层：本插件向 Harness Web UI 暴露的**本地路由**，以及它反向调用 **Agnes 控制台**的接口。

---

## 1. 本插件路由（Host 半边注册）

七条路由都经过**同源校验**：带 `Origin` 的请求必须与 Host 同源，因此只有本机 DSH 自己提供的页面能写入账号或 Key。请求体上限 **4 KB**。

### `GET /api/dsh-connect-agnes-token-plan/snapshot`

面板轮询的聚合结果。返回体（HTTP 恒为 200，成败靠 body 区分）：

```jsonc
{
  "ok": true,
  "now": 1790529234603,
  "consoleBase": "https://platform-backend.agnes-ai.cn",
  "cacheSeconds": 60,
  "pollSeconds": 30,
  "auth": {
    // 账号/令牌状态，永不含密码或令牌本身。hasRefreshToken 恒为 false：
    // Agnes 一跳登录不发 refresh_token，令牌过期就重新登录（见 §2）。
    "configured": true, "hasAccount": true, "autoRecoverArmed": true,
    "hasRefreshToken": false, "needsAccount": false, "ephemeral": false,
    "retryAfterMs": null, "needsUserAction": false,
    "expiresAt": 1790529234603, "error": null
  },
  "catalogAvailable": true,
  "catalogModels": ["agnes-2.5-flash", "..."],
  "visionModels": [/* 可看图模型（仅 catalogAvailable 时返回，否则整个字段省略） */],
  "quota": {
    // 当前套餐（识别不出时 plan: null，面板明说而不是猜一档）。
    // limits 是 planSummary 的投影，与 windows 同源，供「套餐对比」表格比较。
    "plan": { "uuid": "…", "planId": 3, "name": "高级版", "displayName": "高级版",
      "billingCycle": "monthly", "displayCycle": "月付", "priceMinor": 9900,
      "currency": "CNY", "usageLimitText": "30000 次模型请求 / 5 小时",
      "limits": { "requests5h": 30000, "requestsWindowH": 5, "requestsWeekly": 300000,
        "imagesDaily": 4000, "videoDaily": 500 } },
    // 四个账号级窗口上限。unit 为 "requests" / "images" / "video"；
    // video 刻意不带秒数主张（平台只给了 video_daily_limit，未说单位）。
    // 没有 used/remaining —— 控制台只提供累计用量，窗口内已用量拿不到。
    "windows": [{ "key": "requests5h", "unit": "requests", "limit": 30000, "windowHours": 5 }],
    // 账号累计用量（控制台口径）。刻意不与上面的上限相减：两者周期不同。
    // **读不到时是 null，不是零值块**——把没读到渲染成「0 次请求」就是把
    // 一次失败伪装成一次测量（面板显示「暂未读到」）。
    "totals": { "totalRequests": 12000, "totalTokens": 340000, "totalImages": 40,
      "totalVideoSeconds": 610, "activeDays": 12 },
    // 公开套餐目录的投影（六档：入门版/专业版/高级版 × 月付/年付）。
    // 它是唯一无需登录就能取到的额度来源，所以没登录时面板仍能展示它。
    "plans": [/* planSummary 投影 */],
    "expiresAt": 1790529234,
    // 鉴权半边是否答上了。false = 五个源里所有需要登录的都没回来，
    // 此刻面板只剩公开套餐目录可展示，它明说这一点，而不是让「读不到」
    // 读成「你什么都没用过」。与 auth.configured 是两回事：账号配好了但
    // 平台挂了也是 false，两者该给的下一步不同。
    "consoleConnected": true,
    // 第一个失败的来源（含 overview）的名字、wire code 与原因。
    "error": null
  },
  // 近 N 天的分桶用量。null = 该来源没取到（面板显示「暂未读到」）。
  "usage": { "days": 30,
    "windowTotals": { "totalRequests": 60, "totalTokens": 600, "totalImages": 3, "totalVideoSeconds": 31.5 },
    "buckets": [{ "bucket": "2026-09-30", "requestCount": 10, "textTokens": 100,
      "imageCount": 1, "videoSeconds": 0 }] },
  "llm": {
    // 推理 Key 状态（永远不回显 Key 本身）
    "hasApiKey": true, "keySource": "credentials", "ephemeral": false,
    // 直接注册开关 / Host llm 服务 / 当前是否已注册
    "registerProvider": false, "registerSource": "config", "llmAvailable": false,
    "providerRegistered": false, "providerId": "agnes-token-plan",
    // 实际注册了多少个（已按下面的允许清单过滤），以及其中多少个可看图；
    // thinkingDefault 是本提供方 profile 钉死的思考强度默认值（与 llm-adapter 同一
    // 常量）——provider 级常数，面板只在花名册头部说一次，不逐行重复
    "modelCount": 2, "visionCount": 1,
    "thinkingDefault": "high",
    // 模型选择器数据：整份可选目录（不受过滤影响）与当前生效的允许清单。
    // 空清单 = 不过滤 = 全部推送；["__hide_all__"] = 一个都不推送。
    // 每行附目录声明的 contextWindow / maxOutputLength（0 = 平台未声明）、
    // thinkingLevels（DSH 选择器实际可选档位，与 pi-ai getSupportedThinkingLevels
    // 同一规则算出；扩展档 xhigh/max 只对冻结契约表里实测过 200 的模型开放，
    // low/medium 按 live-contract 探针的逐模型实锤结果开放）；命中
    // trendMultipliers 的行再附 multiplier: number（伪倍率，非官方）。
    "models": [{ "id": "agnes-2.5-flash", "name": "agnes-2.5-flash", "vision": false,
      "available": true, "quotaExhausted": false, "contextWindow": 262144,
      "maxOutputLength": 65536, "multiplier": 1,
      "thinkingLevels": ["off", "low", "medium", "high"] }],
    "enabledModelIds": [],
    // quotaBlockedModelIds 是交给选择器剔除的 id 集。Agnes 下**恒为空**——
    // 平台不按模型分配额，账号级用尽由面板明说，而不是静默摘模型。
    "quotaBlockedModelIds": [],
    // 出图工具开关生效值与来源（0.4.2）；工具实际挂载在下一个 Host 启动时发生
    "drawEnabled": false, "drawSource": "config",
    // 一次出图调用实际会寻址的模型 id：用与工具本身相同的 pickDrawModel
    // 优先级（调用参数 > 配置的 drawModelId > 目录首个出图模型）从同一份
    // 目录算出，面板展示与工具行为不会分叉。目录缺席（无 Key）时整个字段缺席
    "drawModel": "agnes-image-2.5-flash",
    // 目录里 output_modalities 含 image 的条目：自动选择藏掉同侪时，候选让它可见
    "drawCandidateCount": 1,
    "drawCandidateIds": ["agnes-image-2.5-flash"]
  },
  "shapeWarnings": [/* 控制台返回结构与预期不符时非空 */]
}
```

- `ok:false` 是**兜底路径**，只在 `buildSnapshotBody` 之外失败时出现（路由挂掉、Host 不可达、`config_error`）。body 带 `code`（`not_configured` / `jwt_expired` / `auth_error` / `config_error` / `account_locked` 等）与 `auth` 块。
- **控制台读不到时 body 仍然是 `ok:true`**：`quota.consoleConnected:false` 加上 `quota.error.code`（`not_configured` / `auth_error` / `console_error`）。这样 API Key tab 和小浣熊 tab 仍然可达——它们一个不读控制台、一个连的是另一个上游，被一个缺席模块一起埋掉正是 `ARCHITECTURE.md` §5 禁止的。
- Host 内部：临近过期时用保存的账号重新登录一次；Agnes 不发 refresh_token，所以「续期」就是重登。
- `shapeWarnings` 非空说明控制台字段可能改名，面板会明说而非永远「暂无数据」。
- **额度与用量是两条独立事实**：`quota.windows` 是平台声明的上限，`quota.totals` 与 `usage` 是平台报出的累计量。滚动窗口内的已用量平台不提供，所以 Host 不做任何减法——`limit - total` 会相减两个不同周期。

### `GET /api/dsh-connect-agnes-token-plan/account`

返回账号状态（**不含密码**）：`configured` / `hasAccount` / `autoRecoverArmed` / `ephemeral` 等。

### `POST /api/dsh-connect-agnes-token-plan/account`

两种用途，靠 body 区分：

- 保存账号：`{ "username": "...", "password": "..." }` —— 触发一跳登录（`POST {consoleBase}/api/user/login`）并落库。
- 清除账号：`{ "forget": true }` —— 仅删账号引用，保留仍有效的令牌。

非法 body（非对象、JSON 数组、超 4 KB）返回 400；跨域 POST 返回 403 且不写入任何账号。

### `GET /api/dsh-connect-agnes-token-plan/api-key`

返回推理 Key 的**去密状态**（无 Key 值本身）：`hasApiKey` / `keySource`（`credentials` 凭据服务引用、`env` 环境变量、`memory` 无凭据服务时的进程内存、或 `null`）/ `ephemeral`。

### `POST /api/dsh-connect-agnes-token-plan/api-key`

两种用途，靠 body 区分：

- 保存 Key：`{ "apiKey": "sk-..." }` —— 以 `AGNES_TOKEN_PLAN_API_KEY` 引用写入 DSH 凭据服务（与手写 `llm-pi-ai` 行读取的是同一个引用名）；进程环境变量仍是兜底来源。下次轮询用新 Key 拉取模型目录并（开关开启时）重建已注册的 provider。
- 清除 Key：`{ "forget": true }` —— 仅删面板保存的引用并清空私有 catalog 缓存；环境变量 `AGNES_TOKEN_PLAN_API_KEY` **不**受影响，已注册 provider 的模型列表被清空。

响应同样只含去密状态；非法 body 返回 400，跨域 POST 返回 403。任何响应都不会回显 Key 明文。

### `GET /api/dsh-connect-agnes-token-plan/provider`

提供方注册开关的去密状态：`registerProvider`（**生效值**）、`registerSource`（`panel` 面板保存过 / `config` 沿用配置默认）、`providerRegistered`（当前是否真的注册着），注册失败时附 `providerError`。设计见 [PROVIDER-HOT-RELOAD.md](./PROVIDER-HOT-RELOAD.md)。

### `POST /api/dsh-connect-agnes-token-plan/provider`

`{ "enabled": true|false }` —— 把开关写入插件私有状态文件并在**同一请求内**重新发布 provider（立即生效，无需重启）。优先级：面板保存的值 > `cordis.patch.yml` 的 `registerProvider`。非布尔 `enabled` 返回 400；跨域返回 403。

### `POST /api/dsh-connect-agnes-token-plan/models`

`{ "enabledModelIds": ["model-a", ...] }` —— 替换本 Key 的**模型允许清单**：勾选后保存到私有 catalog 状态文件，并在**同一请求内**重新发布 provider（面板不需要等下一次轮询）。

清单语义与 `filterByEnabled` 一致：

- **空数组 `[]`** = 不过滤，目录里的模型全部推送；
- **非空数组** = 严格允许清单，只推送列出的模型；
- **`["__hide_all__"]`** = 一个都不推送（临时全部收起用的哨兵；空数组已表示「未筛选」，需要一个不同的写法表达「筛选后一个都不剩」）。

返回 `{ ok, enabledModelIds, registerProvider, providerRegistered, providerError? }`，不含模型明文号与 Key。缺字段 / 非数组 / 超过 500 项返回 400 且不写入任何值；跨域返回 403。清单只影响**推送给 DSH 的选择器**，`snapshot` 里的 `catalogModels` / `llm.models` 仍是整份目录，面板据此展示可勾选项。

### `GET /api/dsh-connect-agnes-token-plan/draw`

出图工具开关的去密状态：`drawEnabled`（**生效值**）、`drawSource`（`panel` 面板保存过 / `config` 沿用配置默认）。设计见 [PROVIDER-HOT-RELOAD.md](./PROVIDER-HOT-RELOAD.md) §7。

### `POST /api/dsh-connect-agnes-token-plan/draw`

`{ "enabled": true|false }` —— 把出图开关写入插件私有状态文件（`$DSH_HOME/state/<profile>/<plugin>/draw.json`，按 profile 分段、见 [PITFALLS.md](./PITFALLS.md) §23），与 `/provider` 走的是同一套「存私有状态」机制，但**不触发任何即时发布**——agent 工具的实际注册/缺席发生在下一个 Host 启动（或重新安装）时，由 `lifecycle.js` 的 `startSideEffects` 重读生效值。优先级：面板保存的值 > `cordis.patch.yml` 的 `drawEnabled`。非布尔 `enabled` 返回 400；跨域返回 403。

`{ "drawModelId": "agnes-image-2.5-flash" }`（或 `null` = 自动选择）—— 把出图模型偏好写入同一个 `draw.json`。生效时机与开关相同：`startSideEffects` 在下一次挂载时用它覆盖 `cordis.patch.yml` 的 `drawModelId`（优先级：面板 > 配置；面板清除后回落配置，配置也为空则自动取目录第一个出图模型）。非空字符串之外的非 null 值返回 400；跨域返回 403。`{ "forget": true }` 同时清除开关与模型偏好的面板保存值。

### `GET|POST /api/dsh-connect-agnes-token-plan/raccoon`

第二个上游（小浣熊网关）的开关与状态。它与 Token Plan **同属商汤旗下，但认证域互不相通**：凭据、store、publisher 全部隔离，改动它对本插件主链路的影响应恒为零。契约与复测表见 [ROADMAP.md](./ROADMAP.md) §6.1.2。

---

## 2. Agnes 控制台接口（插件反向调用）

全部走 `consoleBase`（默认 `https://platform-backend.agnes-ai.cn`），响应统一为
`{ code, message, data }` 信封；**HTTP 200 也可能带 `code: 401`**，所以鉴权拒绝在
HTTP 层与信封层各判一次。字段级事实与实测证据见
[AGNES-API.md](./AGNES-API.md) §1–§6。

| 接口 | 方法 | 用途 | 认证 |
|---|---|---|---|
| `/api/user/login` | POST | 一跳登录：`{username, password}` → `{access_token, user}` | 无（body 带密码） |
| `/api/usage/overview` | GET | 账号累计用量（请求数 / token / 生图 / 视频秒数 / 活跃天数） | `Bearer <控制台令牌>` |
| `/api/usage/series` | GET | 按平台分桶的区间用量（`start_date` / `end_date` 为**日期**） | `Bearer <控制台令牌>` |
| `/api/cn/user/subscription` | GET | 当前订阅（套餐身份与到期时间） | `Bearer <控制台令牌>` |
| `/api/cn/user/subscription/plans` | GET | 公开套餐目录（六档，含各档四项上限） | **无需登录** |
| `https://api.agnes-ai.cn/v1/models` | GET | 套餐覆盖模型里本 Key 真正能调哪些（只读、不计费、不占额度） | `Bearer <AGNES_TOKEN_PLAN_API_KEY>` |

**五个源一律软失败**：任何一个缺席，面板照常显示已到的部分，并在 `quota.error` 里点名缺席的那一个。
`overview` 曾经是唯一致命源（它失败即整个 body 走 `ok:false`），那条路把三个 tab 一起埋掉——
包括一个不读控制台的 API Key tab，和一个连的是**另一个上游**的小浣熊 tab。现在它只是五个源里
的第一个：失败时 `quota.consoleConnected:false`，`quota.totals` 为 `null`（**不是零值块**），
面板在额度 tab 内明说「控制台未连接」并把登录卡展开，另两个 tab 一个点击之外。
`plans` 匿名可读，所以它是唯一在未登录时也照样能展示的额度来源。

登录端点与令牌细节见 [AGNES-API.md](./AGNES-API.md) §1；
推理侧（`/v1/models`、思考档位、请求约束）见同文件 §7。

---

## 3. 配置端点清单（cordis.patch.yml）

完整字段与默认值见 [SETUP.md](./SETUP.md) §3。端点类字段（`consoleBase` / `apiBase`）仅在镜像或代理时指向别的主机才需改动；任意非法 http(s) 绝对地址会在挂载时报 `config_error`。

登录流的覆盖项是**顶层键**，不是嵌套 `auth:` 块——嵌套块会被静默忽略，面板随后拿着出厂默认值打到**真平台**（这条已经锁过一次号，见根 [AGENTS.md](../AGENTS.md) 红线 3）。
