# Agnes 接口全集（控制台额度侧 + 推理侧）

本插件与 Agnes 有**两条互不相通的链路**，凭据各走一套，本文件是它们共同的事实源：

| 链路 | 源站 | 凭据 | 覆盖 |
|---|---|---|---|
| **额度展示**（「积分额度」tab） | `consoleBase` = `https://platform-backend.agnes-ai.cn` | 账号密码换来的控制台 access token | §1–§6 |
| **推理通道**（「接入 API」tab） | `apiBase` = `https://api.agnes-ai.cn/v1` | `AGNES_TOKEN_PLAN_API_KEY`（免费版 `sk-` Key 或 Token Plan `cpk-` 密钥均可） | §7 |

> ⚠️ 登录协议细节（一跳 POST、无 refresh token、密码明文过 TLS、防锁号节流）不在这里重复，见
> [AUTH.md](./AUTH.md)。本地路由与控制台端点的对照表见 [API.md](./API.md)。
> **SenseNova 控制台**（`platform.sensenova.cn`，OIDC+PKCE）已不是本插件的任何一条链路，
> 其接口原文留在 [SENSENOVA-API.md](./SENSENOVA-API.md) 作历史档——小浣熊上游与
> `upstream/` 仍属商汤体系，那份档仍被它们引用。
> 出图（draw，`draw.ts`）与视频（video，`video.ts`）两个 agent 工具默认关闭，其
> `images/generations` 与 `videos` + `agnesapi` 端点均已真机确证存在且可用
> （见 §7.5），模型识别走 `modality.ts`（见 §7.1）。视频 **V2.0 与 2.5 两个参数体系都覆盖**，
> 按选中模型分派请求体；互斥规则与双向混发防护见 §7.5.1 / §7.5.1b。

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
| 看图判定 | 仅看 `input_modalities` 含 `image`（Agnes 目录不带该字段，故恒为 false——见 §7.1） | `identifyVisionModel` |
| 模态判定唯一出处 | `src/host/modality.ts`：`output_modalities` 字段优先 → `agnes-image-*` / `agnes-video-*` 名称兜底 → 默认 `text` | `outputModalitiesOf` |
| 出图/视频排除 | 产出含 `image`/`video` 即非对话 | `isChatModel`（与 `isImageGenModel` 同源） |

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

需 `Bearer <API Key>`（本机推理 key，非控制台 access token；免费版 `sk-` Key 与 Token Plan `cpk-` 密钥都可作为此处的 key）。返回 `data[]`；
`console-client.ts` 整条原样保留（不剥信封、不改字段）。

**真机确证（2026-10-01）：Agnes 的条目只带 5 个字段，没有任何模态 / 能力元数据。**

```json
{"id":"agnes-image-2.5-flash","object":"model","created":1626777600,
 "owned_by":"custom","supported_endpoint_types":["openai"]}
```

`success: true` + `supported_endpoint_types` 是 new-api 血统的签名。当时目录 11 条：
`agnes-2.0-flash`、`agnes-2.5-flash`、`agnes-2.5-pro`、`agnes-2.5-pro-alpha`、
`agnes-2.5-pro-beta`、`agnes-3.0-flash`、`agnes-image-2.1-flash`、
`agnes-image-2.5-flash`、`agnes-video-2.5`、`agnes-video-2.5-flash`、`agnes-video-v2.0`。

因此 **SenseNova 的那一套字段名在这里一个都不存在**——下表右两列才是 Agnes 的实况：

| 字段 | SenseNova 目录 | Agnes 目录 | 插件的读取方式 |
|---|---|---|---|
| `id` | ✅ | ✅ | 模型 id |
| `input_modalities` | ✅ | ❌ | `identifyVisionModel` 只看它 → Agnes 上**恒 false**；面板「0 个支持图片输入」的含义是「读不到」，不是「测过没有」 |
| `output_modalities` | ✅ | ❌ | `modality.ts` 的第一优先；缺则退回名称兜底 |
| `context_length` | ✅ | ❌ | `contextWindowOf` 命名字段，缺则兜底 `128_000`——面板显示的是**兜底值**，不是平台声明 |
| `max_output_length` | ✅ | ❌ | 同上 |
| `supported_features` | ✅ | ❌ | 无字段可读，`reasoning: true` 改为无条件设置 |
| `supported_endpoint_types` | ❌ | ✅ | 无判别力（11 条全是 `["openai"]`） |

**模态判定（`src/host/modality.ts`）**——Agnes 上唯一可用的信号是 id 自己的命名：

| 层级 | 依据 | 结果 |
|---|---|---|
| 1 declared | `output_modalities` / `outputTypes` 是数组 | 原样采用；平台将来补字段即自动生效，无需改码 |
| 2 inferred | id 含独立的 `image` / `video` 段 | `agnes-image-*` → image；`agnes-video-*` → video |
| 3 assumed | 以上都没有 | `["text"]`，即对话模型 |

名称模式**只匹配完整段**（`(?:^|[-_])image(?:[-_]|$)`），不是子串匹配——
`dsh-draw-router` 的 `/u1-fast/i` 漏掉 `u1.5-lite` 正是这个坑，见
[ARCHITECTURE.md](./ARCHITECTURE.md) §5.4。

> **平台自述的模态藏在错误信息里**：把出图模型打到对话端点，平台回
> `400 模型 agnes-image-2.5-flash 是 image 模型，请使用 /v1/images/generations`；
> 视频同理指向 `/v1/videos`。这是目前唯一由平台直接声明模态的来源，但只能**逐次探测**
> 才拿得到（要花请求、且随套餐变化），不适合当目录判定的依据。

> ⏳ **待 live-contract 实测**：各模型的 `reasoning_effort` 支持面尚未用真机核验。先以
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

### 7.5 出图 / 视频端点（真机确证 2026-10-01）

图片与视频**不是同一种协议**：图片同步返回，视频是异步任务制。这条差异是
`draw.ts` 的执行体无法直接复用到视频的根本原因。

| 用途 | 端点 | 形状 |
|---|---|---|
| 出图 | `POST {apiBase}/images/generations` | **同步**：一次请求直接拿到结果 |
| 视频建任务 | `POST {apiBase}/videos` | 返回任务标识，**异步** |
| 视频查任务 | `GET {host}/agnesapi?video_id=…&model_name=…` | 查询任务状态；空查询回 `{"code":"task_not_exist"}` |

**查任务的路径不在 `/v1` 下**——它在站点根上多一级 `agnesapi`。`video.ts` 的
`buildVideoQueryEndpoint` 专门剥掉版本段（`hostRootOf`）就是为了这个：把 `/v1`
拼上去会 404。建任务侧，`POST /v1/video/generations`（单数）与
`POST /v1/videos` 都通，但 `POST /v1/videos/generations`（复数 + `generations`）
回 `Invalid URL`；本插件固定走 OpenAI Videos 兼容的 `{apiBase}/videos`。
两条端点与上游 `dsh-agnes` 的实现逐字一致（其 `AGNES_VIDEO_API_URL` /
`AGNES_VIDEO_QUERY_URL` 两个常量）。

出图真机响应（`agnes-image-2.5-flash`，`response_format: "url"`）：

```json
{"data":[{"url":"https://cos-platform-outputs.agnes-ai.cn/images/t2i/task_…/output_….png",
          "b64_json":"","revised_prompt":""}],
 "created":1790817333,"task_id":"task_…"}
```

`parseDrawResponse` 只读 `data[0].url` / `b64_json` / `revised_prompt`，顶层多出的
`task_id` 被忽略——即当前解析器与真实形状**已经对齐**，出图链路无需改动。

**出图请求体字段去向**（`buildDrawBody` 的 wire shape）：

| 字段 | wire 位置 | 备注 |
|---|---|---|
| `model` / `prompt` / `n` / `size` / `response_format` | 顶层 | `response_format` 顶层写法经 live probe ③ 确证有效，不迁 `extra_body`；`size` 接受精确 `WIDTHxHEIGHT`（32 的倍数）与 `2K` / `4K` 档位常量——两种写法均已 live probe ⑤ 确证生效，工具参数描述已随实测恢复档位表措辞 |
| `ratio` | `extra_body.ratio` | Agnes 方言；live probe ⑤ 确证端点接受 `extra_body.ratio`（16:9 出图成功） |
| `image` | `extra_body.image` | Agnes 方言；live probe ⑤ 确证端点接受 `extra_body.image`（参考图走 img2img，输出任务段由 `/t2i/` 切到 `/i2i/`，证实参考图真实生效而非被忽略） |
| `return_base64` | `extra_body.return_base64` | Agnes 方言；live probe ⑤ 确证端点接受 `extra_body.return_base64`（`url` 返回空串、`b64_json` 携带 base64 载荷——即该字段改变了返回形态而非被丢弃）；`response_format` 保持顶层、不迁 |

> **live probe（2026-10-01，子代理真机）**：用真实 Key 实跑确认了四点——① `n` **必须为 1**，传 `n:2` 直接 `400 n 必须为 1`，故 `buildDrawBody` 现在只转发 `1`；② 不传 `model` 时自动发现选中 `agnes-image-2.1-flash` 并成功出图，证明「省略 model 走目录默认」逻辑是对的；③ 顶层 `response_format:"url"` **仍返回 url**（与本节真机记录一致），故维持顶层写法、不迁 `extra_body`；④ `agnes-u1-fast` 在真机是 **chat 模型**（报 400「是 chat 模型，请使用 /v1/chat/completions」），印证旧描述里的示例 id 是错的——已在上轮提交移除。
>
> **live probe ⑤（本次补全，`test/probe-draw-fields.mjs` 真机 5/5 通过）**：上一版「⏳ 待补」清单里的四个字段全部转正——
> `size: "1024x1024"`（精确 `WIDTHxHEIGHT`）、`size: "2K"`、`size: "4K"`（档位常量，即 2026-10 版工具描述误判「未确认」的那条——SenseNova U1.5 档位表在这端点确实有效）、
> `extra_body.ratio: "16:9"`、`extra_body.image`（参考图，任务段由 `/t2i/` 切到 `/i2i/`，证明 img2img 真实生效）、`extra_body.return_base64: true`（返回形态切实变化：`url` 空串 + `b64_json` 载荷）——
> 均为 200 + 成功出图。四个字段在 Agnes 出图端点的接受性全部确证，无需删除或改写法。

#### 7.5.1 视频 V2.0 请求体与校验规则

`buildVideoBody` 的输出字段与**校验**（非法显式值一律**抛错**，不夹取）：

| 字段 | 类型 / 范围 | 缺省 | 非法时的行为 |
|---|---|---|---|
| `model` | 字符串 | `agnes-video-v2.0` | 直传 |
| `prompt` | 字符串 | — | 直传 |
| `width` | 正整数 | `1152` | 抛错 |
| `height` | 正整数 | `768` | 抛错 |
| `num_frames` | ≤ 441 **且** `8n+1` | `121` | 抛错（并给出最接近的较大合法值） |
| `frame_rate` | 1–60 | `24` | 抛错 |
| `seed` | 整数 | 不发送 | 抛错 |
| `negative_prompt` | 非空字符串 | 不发送 | 空串视为未提供 |
| `image` | 公共 `http(s)://` URL | 不发送 | 抛错（平台无法抓取相对路径） |

`8n+1` 的常用取值是 `81 / 121 / 161 / 241 / 441`；`121 @ 24fps ≈ 5 秒`。

> **为什么抛错而不夹取**：`buildDrawBody` 对 `n` 是**夹取**的，视频这里刻意相反。
> 夹取帧数会**静默改变视频时长**——而一次生成要几分钟才回结果，用户拿到 3 秒而不是
> 5 秒时已经无从追溯。宁可当场报错。

**V2.0 与 2.5 的参数体系互斥**：名字含 `2.5` 的模型
（`agnes-video-2.5` / `agnes-video-2.5-flash`）走 `mode` / `seconds` / `size` /
`aspect_ratio`（OpenAI Videos 兼容的秒数制），把 V2.0 的
`width` / `height` / `num_frames` / `frame_rate` 发给它会被 **400** 拒绝，反之亦然。
所以 `pickVideoModel` 可以选中**任一**家族（显式请求 / 面板偏好认全量视频模型；
自动选择优先 V2.0，目录没有 V2.0 时回落到第一个 2.5），`defineVideoTool` 按
`isVideo25Family(model)` 分派到对应的请求体构造器（V2.0 → `buildVideoBody`，
2.5 → `buildVideoBody25`），两套字段永不同时发给同一模型。2.5 家族仍单独进
`video25ModelIds` 上报面板，面板据此点名「这些走秒数制参数，工具已支持、自动换算」。

#### 7.5.1b 视频 2.5 请求体与校验规则（`buildVideoBody25`）

| 字段 | 类型 / 范围 | 缺省 | 非法时的行为 |
|---|---|---|---|
| `model` | 字符串 | 2.5 家族 id | 直传 |
| `prompt` | 字符串 | — | 直传 |
| `mode` | `text` / `keyframe` / `reference` | 按 media 推导 | 白名单外抛错 |
| `seconds` | 整数 4–12（wire 上为字符串） | `5`（或由 `num_frames` / `frame_rate` 就近换算） | 抛错 |
| `size` | `720P` / `960P` / `2K`；**flash 仅 `720P`** | `720P` | 抛错（flash 非 720P 也抛错） |
| `aspect_ratio` | `21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16` | 由 `width` / `height` 就近匹配 | 白名单外抛错 |
| `first_frame` / `last_frame` / `images` | 公共 `http(s)://` URL；flash 的 reference ≤ 5 张 | 按 media 推导 | 抛错 |
| `seed` | 整数 | 不发送 | 抛错 |

翻译规则（工具参数 → 2.5 wire）：显式 `seconds` 优先；未给 `seconds` 时由
`num_frames` / `frame_rate` 就近换算（`121 @ 24fps → 5s`，夹取到 4–12——这是**刻意夹取**，
因为 2.5 平台只收整秒，夹取落在合法值上而非 400）；`image` / `keyframes` 推导
`mode`（无 media → `text`，单张 image / 两张 keyframes → `keyframe`，3+ 张 →
`reference`，且与 image 互斥）；`negative_prompt` **不转发**（2.5 无对应字段，
多一个顶层未知字段就是 400）。参考约束取自上游 `dsh-agnes` 的 2.5 实现
（flash 仅 720P、reference ≤5、秒数 4–12）。

**双向混发防护**（`defineVideoTool` 层，不是构造器层）——两个方向的处理刻意**不对称**：

- V2.0 帧数字段 → 2.5 模型：**换算，不报错**。`num_frames` / `frame_rate` → 最接近的整秒，
  `width` / `height` → 画幅就近匹配。这是给 agent 的退路：它不必判断家族、照旧传 V2.0 形状
  也能拿到合理出片（`121 @ 24fps` → 16:9 / 5s）。
- 2.5 专有字段（`VIDEO25_ONLY_FIELDS` = `seconds` / `size` / `aspect_ratio` / `mode` /
  `keyframes`）→ V2.0 模型：**当场抛错并点名修法**。`buildVideoBody` 只解构 V2.0 字段，
  静默丢弃会让「要 10 秒 2K」变成「拿到 5 秒 720P」且**没有任何信号**——与 §7.5.1 的
  throw-not-clamp 同一纪律。报错逐字段点名被拒项并给出两条出路（`model` 指向 2.5 家族，
  或改用 `num_frames` / `frame_rate`）。
- `negative_prompt` 发到 2.5 模型仍**静默不转发**：它是软偏好不是输出规格，且工具描述已
  声明；与上面两个方向的可观测性不同，故不走抛错。

2.5 家族的每个校验错误都经 `video25ErrorContext()` 带上**实际解析到的模型 id 与所属体系**，
例如 `模型 agnes-video-2.5-flash（2.5 秒数制）：无效的 seconds 3：须为 4–12 的整数秒`。
此前只说「2.5 系列」——点名了家族，却没点名 agent 实际打到的是哪个模型，得回读 catalog
才知道。

#### 7.5.2 视频任务的状态机与响应

建任务响应读 `video_id` / `task_id` / `id`（三个都可能出现，优先 `video_id`，
查询用它）。查询响应 `parseVideoQuery` 读：

```json
{"video_id":"…","task_id":"…","status":"in_progress","progress":0,
 "seconds":"5","size":"1152x768","url":"…","metadata":{"url":"…","error":null}}
```

- `status` 终态只有 `completed` 与 `failed`（`VIDEO_TERMINAL_STATUSES`）；
  `queued` / `in_progress` 都继续轮询。
- `url` 两层兼容：顶层 `url` 优先，回落到 `metadata.url`。
- `progress: 0` **必须保持 0**：`num()` 坚持正值，会把合法的 0% 读成「缺失」，
  所以这里直接读数字。
- 轮询间隔 5 秒，整体超时默认 600 秒；另有 `VIDEO_MAX_POLLS = 1000` 的防呆上限，
  防的是**时钟不前进时 `remaining <= 0` 永不可达**而空转（写这个模块自己的单测时
  第一次撞到的失败模式）。
- 视频工具**没有 30 秒冷却门**（`draw.ts` 有）。这是决策不是遗漏：一次视频尝试
  耗时分钟级、且与出图共用同一个视频限频池，协议自身的延迟已远宽于 30 秒。

