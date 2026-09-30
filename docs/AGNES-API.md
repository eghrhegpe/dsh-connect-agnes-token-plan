# Agnes 推理接口（Agnes API，OpenAI 兼容 `chat/completions`）

本插件第三步以 provider `agnes-token-plan` 直连 `https://api.agnes-ai.cn/v1`
注册 OpenAI 兼容适配器（见 [ARCHITECTURE.md](./ARCHITECTURE.md) 与
[SETUP.md](./SETUP.md) 的 `registerProvider`）。本文记录**已确证的 Agnes 适配事实**
与**待 live-contract 实测**的部分——它对应
[SENSENOVA-API.md](./SENSENOVA-API.md) §7 的 Agnes 适配版。

> ⚠️ 本插件同时承载两条链路：**配额展示**走 SenseNova 控制台
> （`consoleBase: https://platform.sensenova.cn`，OIDC+PKCE 登录，详见
> [SENSENOVA-API.md](./SENSENOVA-API.md) §1–§6），**推理通道**走 Agnes
> （`apiBase: https://api.agnes-ai.cn/v1`，`AGNES_TOKEN_PLAN_API_KEY`）。
> 二者认证域互不相通，凭据各走一套——本文件只覆盖 Agnes 推理这一片。
> 出图（draw，[SENSENOVA-API.md](./SENSENOVA-API.md) §7.4 / `draw.ts`）默认关闭，
> 其 `images/generations` 端点也随 `apiBase` 落在 Agnes；启用前需确认 Agnes 提供该端点。

## 0. 适配范围与已经确证的事实

改造面严格限定在「模型适配器 + Key + 模型目录拉取」，**不**涉及 OIDC/PKCE/JWE 登录、
quota 池、出图、raccoon（见根 [AGENTS.md](../AGENTS.md) 三条事实）。

以下事实来自源码常量，无需真机即可断言：

| 事实 | 值 | 出处 |
|---|---|---|
| provider id | `agnes-token-plan` | `src/host/llm-models.ts` `LLM_PROVIDER_ID` |
| 面板展示名 | `Agnes Token Plan` | `LLM_DISPLAY_NAME` |
| API Key 引用名 | `AGNES_TOKEN_PLAN_API_KEY` | `src/host/api-key-store.ts` `API_KEY_REF` |
| OpenAI 兼容 base | `https://api.agnes-ai.cn/v1` | `src/host/host-config.ts` `CONFIG_DEFAULTS.apiBase` |
| 默认思考档位 | `high` | `DEFAULT_REASONING_EFFORT` |
| 单 token 价 | 哨兵 0（额度池计费，非按 token 价） | `NO_COST` |
| 兜底上下文窗口 | `128_000`（目录声明优先） | `FALLBACK_CONTEXT_WINDOW` |
| 看图判定 | 仅看 `input_modalities` 含 `image` | `identifyVisionModel` |
| 出图/视频排除 | `output_modalities` 含 `image`/`video` 即非对话 | `isChatModel` |

> `apiBase` 的生效路径：`cordis.patch.yml` 的 `apiBase` 若非空会**覆盖**
> `CONFIG_DEFAULTS.apiBase`（见 `resolveSettings` 的
> `str(source.apiBase, CONFIG_DEFAULTS.apiBase)`）。因此部署时 `cordis.patch.yml`
> 的 `apiBase` 必须为空或显式写成 `https://api.agnes-ai.cn/v1`——否则 provider
> 注册与 `/v1/models` 轮询会打到旧的 SenseNova 网关（用 Agnes key 必 401）。
> 本仓库 `cordis.patch.yml` 已对齐为 Agnes 端点。

## 7.1 模型目录 `GET /v1/models`

需 `Bearer <API Key>`（本机推理 key，非控制台 JWT）。返回 `data[]`；
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

## 7.2 思考档位（未探测模型的 safe-set）

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

## 7.3 请求 / 响应（已知约束）

- `model`：固定目录 id；`messages[].role` 无 `developer`（`supportsDeveloperRole:false`，否则请求 403）。
- `max_tokens`：只钉字段名，不钉值（避免截断长回复）；目录 `max_output_length` 仅展示。
- `reasoning: true` + `thinkingLevelMap`：DSH 思考强度选择器照常工作。
- 思考字段拼写、逐模型 `reasoning_effort` 支持面、图像输入方言：**待 Agnes 真机
  probe**，未实测前不写死（参见 [PITFALLS.md](./PITFALLS.md) 关于「文档须说实话」的纪律，形式全绿而语义已漂是踩过的坑）。

## 7.4 live-contract 护栏（漂移检测）

[../test/live-contract.mjs](../test/live-contract.mjs) 不在 `npm test` 内，需真机
`AGNES_TOKEN_PLAN_API_KEY`，由 `npm run test:live:contract` 触发。它把
[../test/baselines/agnes-contract.json](../test/baselines/agnes-contract.json)
冻结的契约回放到 Agnes `/v1/models` 与少量推理探针：

- 目录漂移（字段改名、模态拼写变化）先在这里变红，先于面板静默降级。
- 一次 `/v1/models` 轮询 + 每模型 `low`/`medium` 两档探针（2s 退避，`429` 记
  INDEFINITE 不当判读，仅 4xx 参数拒绝算红）。
- 红 = 信息而非回归：修复落在本文 §7 注释层 + 刷新基线 JSON，绝不改 `llm-models.ts`
  逻辑。
