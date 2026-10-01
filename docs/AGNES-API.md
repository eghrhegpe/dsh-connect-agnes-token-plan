# Agnes 接口全集（控制台额度侧 + 推理侧）

本插件与 Agnes 有**两条互不相通的链路**，凭据各走一套，本文件是它们共同的事实源：

| 链路 | 源站 | 凭据 | 覆盖 |
|---|---|---|---|
| **额度展示**（「积分额度」tab） | `consoleBase` = `https://platform-backend.agnes-ai.cn` | 账号密码换来的控制台 access token | §1–§6 |
| **推理通道**（「接入 API」tab） | `apiBase` = `https://api.agnes-ai.cn/v1` | `AGNES_TOKEN_PLAN_API_KEY`（`sk-` Key） | §7 |

> ⚠️ 登录协议细节（一跳 POST、无 refresh token、密码明文过 TLS、防锁号节流）不在这里重复，见
> [AUTH.md](./AUTH.md)。本地路由与控制台端点的对照表见 [API.md](./API.md)。
> **SenseNova 控制台**（`platform.sensenova.cn`，OIDC+PKCE）已不是本插件的任何一条链路，
> 其接口原文留在 [SENSENOVA-API.md](./SENSENOVA-API.md) 作历史档——小浣熊上游与
> `upstream/` 仍属商汤体系，那份档仍被它们引用。
> 出图（draw，`draw.ts`）默认关闭，其 `images/generations` 端点随 `apiBase` 落在 Agnes；
> 启用前需确认 Agnes 提供该端点。

## 0. 已经确证的事实（源码常量，无需真机即可断言）

| 事实 | 值 | 出处 |
|---|---|---|
| provider id | `agnes-token-plan` | `src/host/llm-models.ts` `LLM_PROVIDER_ID` |
| 面板展示名 | `Agnes Token Plan` | `LLM_DISPLAY_NAME` |
| API Key 引用名 | `AGNES_TOKEN_PLAN_API_KEY` | `src/host/api-key-store.ts` `API_KEY_REF` |
| 控制台后端源站 | `https://platform-backend.agnes-ai.cn` | `src/host/host-config.ts` `CONFIG_DEFAULTS.consoleBase` |
| 登录路径 | `/api/user/login` | `src/host/agnes-auth.ts` `AUTH_DEFAULTS.loginPath` |
| OpenAI 兼容 base | `https://api.agnes-ai.cn/v1` | `CONFIG_DEFAULTS.apiBase` |
| 默认思考档位 | `high` | `DEFAULT_REASONING_EFFORT` |
| 单 token 价 | 哨兵 0（按窗口限流计费，非按 token 价） | `NO_COST` |
| 兜底上下文窗口 | `128_000`（目录声明优先） | `FALLBACK_CONTEXT_WINDOW` |
| 看图判定 | 仅看 `input_modalities` 含 `image` | `identifyVisionModel` |
| 出图/视频排除 | `output_modalities` 含 `image`/`video` 即非对话 | `isChatModel` |

> 端点类字段的生效路径：`cordis.patch.yml` 里的同名值若非空会**覆盖**
> `CONFIG_DEFAULTS`（见 `resolveSettings` 的 `str(source.X, CONFIG_DEFAULTS.X)`）。
> 因此部署时 `consoleBase` / `apiBase` 必须为空或显式写成 Agnes 端点——否则面板会打到
> 别的平台（用 Agnes 凭据必 401）。本仓库 `cordis.patch.yml` 已对齐为 Agnes 端点。

---

## 1. 认证（额度侧）

一跳：`POST {consoleBase}/api/user/login`，请求体 `{username, password}`，返回
`data.access_token`。没有 OIDC 跳转、没有 refresh token、没有 JWE 封包。
完整说明见 [AUTH.md](./AUTH.md)。

## 2. 额度侧端点

| 端点 | 鉴权 | 返回的 `data` |
|---|---|---|
| `POST /api/user/login` | 无 | `{access_token, user}` |
| `GET /api/usage/overview` | Bearer | 账号**累计**用量（唯一致命源，见下） |
| `GET /api/usage/series?range=custom&start_date=…&end_date=…` | Bearer | `{items:[…]}` 分桶用量 |
| `GET /api/cn/user/subscription` | Bearer | 当前账号的套餐信息（**形状未观测**，见 §6） |
| `GET /api/cn/user/subscription/plans` | **无**（公开） | 套餐目录数组，六档 |

`/api/cn/user/subscription/plans` 的 `/cn/` 段是必需的，少了就是 404。它同时是
**唯一无需登录**的额度来源：面板可以在没有账号时照常回答"升级能买到什么"，也是
认证半边整体失败时唯一还能显示的内容。

**`usage/overview` 是唯一致命源。** 它是认证探针——最便宜的认证调用，任何已登录账号都能发，
所以它的失败是"令牌不可用"的唯一信号，必须冒泡到路由的 catch（那里才决定显示登录表单）。
其余三个源（series / subscription / plans）全部**降级**：失败只写进 `quota.error`，
面板渲染已经到手的部分，而不是整页报错。

## 3. 响应信封

Agnes 后端所有路由统一包一层：

```json
{ "code": 200, "message": "ok", "data": { } }
```

两条后果：

1. **HTTP 200 也可能带 `code: 401`**（`"Not logged in or invalid token"`），所以鉴权拒绝要在
   HTTP 层与信封层**双重**识别。`console-client.ts` 把解包做在唯一一处，任何调用方都不必再
   记信封的形状。
2. 信封码不是 200 就是拒绝，`message` 是平台自己的话（`"Not logged in or invalid token"`
   vs `"plan not found"`），原样带给用户，不替换成码表。

例外：`GET /v1/models` 走的是网关（§7），**没有信封**，就是 OpenAI 的 `{data:[…]}`。

## 4. 额度模型：账号级四窗口

Agnes 的 Token Plan **不是积分余额，而是按窗口限流**，账号级、无按模型配额。四个维度：

| 面板窗口 key | 上限字段 | 窗口字段 | 单位 |
|---|---|---|---|
| `requests5h` | `concurrency_limit` | `concurrency_window_h`（各档均为 5） | `requests` |
| `requestsWeekly` | `text_weekly_limit` | 固定 168 小时 | `requests` |
| `imagesDaily` | `image_daily_limit` | 固定 24 小时 | `images` |
| `videoDaily` | `video_daily_limit` | 固定 24 小时 | `video` |

- 平台自己的 `usage_limit_text` 把第一档渲染成「1500 次模型请求 / 5 小时」，5 小时窗口就是从这里来的。
- `video` 单位**不主张秒数**：上限字段叫 `video_daily_limit`，而用量侧计的是 `video_seconds`，
  平台从未声明这个上限是"次"还是"秒"。面板因此只印裸数字。
- 上限为 0 或缺失的维度**被丢弃**而不是显示成「0 / 日」——没声明过的上限不能被读成"你什么都不许做"。
- 三档套餐的 `image_daily_limit`（4000）与 `video_daily_limit`（500）**完全相同**，
  真正拉开差距的只有请求维度（1500/7500/30000 与 15000/75000/300000）。

**「剩余」不可计算，所以不计算。** 控制台只提供**累计**用量（overview）与**分桶**用量（series），
滚动窗口内的已用量拿不到。`上限 − 累计` 是跨周期的减法，算出来的数没人能负责——
面板把上限与累计作为两个独立事实并排显示，并明说不可相减（`quota.windowNote`）。

## 5. 套餐目录

`GET /api/cn/user/subscription/plans` 公开返回六档：入门版 / 专业版 / 高级版 × 月付 / 年付。
`data` 是**数组**（Agnes 唯一一处如此），`checkShape` 描述不了，所以它的漂移在
`snapshot-aggregate.ts` 里单独查（非数组即报 `{api:"plans", missing:"array"}`）。

当前账号落在哪一档，由 `matchCurrentPlan` 从 `/api/cn/user/subscription` 里推断，两个信号、
强者在先：

1. **uuid**——36 字符的套餐 uuid 可以**任意位置**匹配，平台上没有别的东西长这样。
2. **名称**——只在 `PLAN_IDENTITY_KEYS` 列出的键下面找，**绝不**全量扫描：订阅对象里还有用户
   自己的 `name`、订单列表、甚至整份套餐目录，全量扫会在一个「高级版」账号上匹配到「入门版」。

数字型套餐 id **故意不算信号**：id 是 1–6，而订阅对象里全是小整数，`planId === 1`
会在几乎每个账号上"匹配"到入门档。名称命中会同时打中月付与年付两档，平手时用 payload 里
写明的 `billing_cycle` 破平（`annual` 读作 `yearly`），都没写就默认月付。

## 6. 尚未观测 / 待实测

- **`/api/cn/user/subscription` 的真实形状未观测**（没有可用的会话令牌去看），所以
  `EXPECTED_SHAPES.subscription` **故意是空数组**：给一个没人见过的契约编期望，会让每一次轮询
  都报形状漂移。到期时间也同理——`readSubscriptionExpiry` 按可能性顺序试九个键名，
  一个都不中就返回 `null`（面板什么都不画），而不是编一个 1970。
- **窗口内的已用量**：平台不提供，见 §4。

---

## 7. 推理侧（`chat/completions`）

本插件第三步以 provider `agnes-token-plan` 直连 `https://api.agnes-ai.cn/v1`
注册 OpenAI 兼容适配器（见 [ARCHITECTURE.md](./ARCHITECTURE.md) 与
[SETUP.md](./SETUP.md) 的 `registerProvider`）。本节记录**已确证的 Agnes 推理事实**
与**待 live-contract 实测**的部分——它是 [SENSENOVA-API.md](./SENSENOVA-API.md) §7 的 Agnes 适配版。

### 7.1 模型目录 `GET /v1/models`

需 `Bearer <API Key>`（本机推理 key，非控制台 access token）。返回 `data[]`；
`console-client.ts` 整条原样保留，插件识别：

| 字段 | 用途 |
|---|---|
| `id` | 模型 id |
| `input_modalities` | 看图判定（`identifyVisionModel` 只看 input） |
| `output_modalities` | 含 `image`/`video` 则非对话，被 `isChatModel` 排除 |
| `context_length` | 上下文窗口——`contextWindowOf` 命名字段（缺则兜底 128k） |
| `max_output_length` | 单次响应上限（仅展示，不设为请求参数） |

> ⏳ **待 live-contract 实测**：Agnes 真实返回的字段名、`deepseek-v4.1-flash`
> 是否在 Agnes 目录、以及各模型的 `reasoning_effort` 支持面尚未用真机核验。先以
> [../test/baselines/agnes-contract.json](../test/baselines/agnes-contract.json)
> 的 seed 基线占位；跑 [../test/live-contract.mjs](../test/live-contract.mjs)
> （`npm run test:live:contract`，设 `AGNES_TOKEN_PLAN_API_KEY`）后回填。

### 7.2 思考档位（未探测模型的 safe-set）

`thinkingLevelMapFor` 对**未知模型 id**（不在 `PROBED_EFFORT` 表）给出 Agnes
safe-set，保证选择器不空：

| 选择器档位 | 派发值 | 说明 |
|---|---|---|
| `off` | `none` | 关思考（平台不接受 `off` 拼写，需发 `none`） |
| `minimal` | `null` | 未在该网关验证，不提供 |
| `low` | `low` | 提供 |
| `medium` | `medium` | 提供 |
| `high` | `high` | 平台默认，恒提供 |
| `xhigh` | `null` | 待 per-model probe 证明 |
| `max` | `null` | 待 per-model probe 证明 |

已知 id（在 `PROBED_EFFORT` 表，如 `deepseek-v4.1-flash`）走表分支：仅 `high`
恒开，`low`/`medium` 按表开关（`deepseek-v4.1-flash` 当前全 `false` → 关），
`xhigh`/`max` 恒关直到真机 200 证明。

> ⏳ `PROBED_EFFORT` 目前仍载 SenseNova 时代的模型 id 与实测结论；Agnes 真实目录
> 拿到后需按 [`test:live:contract`](../test/live-contract.mjs) 回放刷新该表与基线
> `driftLog`，**不得臆造**。未知模型走上面的 safe-set，选择器永不空。

### 7.3 请求 / 响应（已知约束）

- `model`：固定目录 id；`messages[].role` 无 `developer`（`supportsDeveloperRole:false`，否则请求 403）。
- `max_tokens`：只钉字段名，不钉值（避免截断长回复）；目录 `max_output_length` 仅展示。
- `reasoning: true` + `thinkingLevelMap`：DSH 思考强度选择器照常工作。
- 思考字段拼写、逐模型 `reasoning_effort` 支持面、图像输入方言：**待 Agnes 真机
  probe**，未实测前不写死（参见 [PITFALLS.md](./PITFALLS.md) 关于「文档须说实话」的纪律，形式全绿而语义已漂是踩过的坑）。

### 7.4 live-contract 护栏（漂移检测）

[../test/live-contract.mjs](../test/live-contract.mjs) 不在 `npm test` 内，需真机
`AGNES_TOKEN_PLAN_API_KEY`，由 `npm run test:live:contract` 触发。它把
[../test/baselines/agnes-contract.json](../test/baselines/agnes-contract.json)
冻结的契约回放到 Agnes `/v1/models` 与少量推理探针：

- 目录漂移（字段改名、模态拼写变化）先在这里变红，先于面板静默降级。
- 一次 `/v1/models` 轮询 + 每模型 `low`/`medium` 两档探针（2s 退避，`429` 记
  INDEFINITE 不当判读，仅 4xx 参数拒绝算红）。
- 红 = 信息而非回归：修复落在本文 §7 注释层 + 刷新基线 JSON，绝不改 `llm-models.ts`
  逻辑。
