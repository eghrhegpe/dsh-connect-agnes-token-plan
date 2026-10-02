# DSH 插件开发指南：LLM / Provider 接入

把「某个大模型平台」接成 DSH 里可用的 **provider**（出现在模型选择器里、能被对话调用）是本插件「接入 API」tab 做的事。这份指南写**怎么做对**，样例全部取自本插件真实代码与真实踩坑；`[DSH-PLUGIN.md](./DSH-PLUGIN.md)` 讲的是「插件如何被加载」这一层，这份往下钻一层，讲**provider 注册与 descriptor 契约**。

> 为什么单独写一份：provider 接入是本插件里 peer 依赖最重、最容易在**运行时才炸**、且炸完离原因最远的一块（[PITFALLS.md](./PITFALLS.md) §19/§20）。把这块的方法论与契约钉下来，别的插件作者可以照抄；下次再接新 provider 时，也不需要重读一遍 peer 源码。

---

## 1. 三个 peer 各管什么（先认清分工，再写代码）

DSH 的 LLM 栈不是一个大包，是三层，职责分得很清楚。**写 provider 之前先分清哪一行代码依赖哪一层**——这决定了你的逻辑能不能被离线测试覆盖。

| Peer | 管什么 | 含不含 DSH 概念 |
|---|---|---|
| `@earendil-works/pi-ai` | 纯模型逻辑：请求/响应方言、options 构造、思考档位、图像解析、`clampMaxTokensToContext`、错误分类 | 不含。它就是「怎么和某个 OpenAI 兼容网关说话」 |
| `@deepseek-ai/dsh-llm` | DSH 侧的模型路由、provider HTTP、凭据接入、重试策略解析（`resolveRetryPolicy` / `resolveImageAttachmentAccess`） | 含 |
| `@deepseek-ai/dsh-llm-pi-ai` | 桥：`PiAiAdapter`、profile、`resolveEntry` 与校验、`registerAdapter` 语义、`classifyPiAiError` | 含 |

**承重纪律**：把「依赖 peer 的组装」与「peer-free 的 descriptor 映射」拆成两个模块（本插件是 `llm-adapter.ts` 与 `llm-models.ts`）。后者不得 `import` 任何 `@deepseek-ai/*`，这样纯逻辑层才能被离线套件在干净检出下跑起来（peer 由 Host 运行时提供，装不到也解析不到，见 [PITFALLS.md](./PITFALLS.md) §16）。

---

## 2. 注册三件套：把 provider 接进选择器

注册走 `ctx.llm`（cordis 服务）。**一次注册 = adapter 注册 + 面板目录行注册**，两件事都做，且都要留下 release 函数：

```ts
// publish-core.ts 的 registerProviderPair（真实实现）
target.releaseAdapter = llm.registerAdapter(built.providerIds, built.adapter);

target.releaseDirectory = typeof llm.registerConfigurableProviders === "function"
  ? llm.registerConfigurableProviders([{
      provider: providerId,
      displayName,
      settingsNs: pluginName,   // 本插件自己的 row 命名空间
      settingsPath: [],
      declared: false           // row 以 patch 形式存在，不是 provider 声明的 schema
    }])
  : null;
```

四个要点，每条都对应一次真实故障：

- **release 必须落到 state 上，而不是返回**。如果目录行注册在 adapter 注册之后抛错，adapter 的 release 仍然要够得着，否则 adapter 会活得比插件久。发布路径和回滚路径共用这一份实现，避免两处漂移（[PITFALLS.md](./PITFALLS.md) §19）。
- **不要把 Promise 交给 `registerAdapter`**。adapter 工厂一旦变 async，`built.adapter` 就是 `undefined`，Host 照单全收——故障出现在模型路由，离原因很远。要么保证工厂同步，要么先 `await` 再注册（[PITFALLS.md](./PITFALLS.md) §19）。
- **注册后要 `emit("llm/adapters-updated")`**，让选择器刷新。catalog 或 key 变化时要**换一个全新的 adapter 实例**重新注册，而不是改旧的——`PiAiAdapter` 内部按 profiles 引用做 memoize。
- **provider id 撞车 = 静默消失**。与其它插件（含姊妹插件 `dsh-connect-sensenova-token-plan`）用同一 id 注册，会被 `registerAdapter` 以 `DUPLICATE_ADAPTER` 拒绝，其中一个 provider 从选择器**悄无声息**地不见。id 命名空间必须互不相交（本插件统一 `agnes-*`）。

### 目录行是可选的

老一点或精简的 runtime 可能没有 `registerConfigurableProviders`。adapter 注册本身就能让模型可用，目录行只是让它有设置页的一行。所以 `registerProviderPair` 里那个 `typeof … === "function"` 的判空不是防御性装饰——没有它，老 Host 上插件直接挂。

---

## 3. adapter 长什么样

一个可用的 adapter 由三块拼起来：

```ts
const provider = {
  ...createProvider({
    id: LLM_PROVIDER_ID,
    name: LLM_DISPLAY_NAME,
    auth: { apiKey: { name: "…", resolve: async ({ credential }) => … } },
    models,                       // descriptor 数组，见 §4
    api: openAICompletionsApi()   // OpenAI 兼容方言
  }),
  getModels: () => models
};

const inner = new PiAiAdapter({
  profiles: () => profiles,           // Map<providerId, profile>
  auth: INERT_AUTH,                   // 见下
  resolveApiKey: async () => resolveApiKey(),
  resolveAttachments: () => get?.("attachments"),
  resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(…)
});
```

### 关键：**inert 的 auth 平面**

`INERT_AUTH` 让 pi-ai 的凭据生命周期对这个 route 彻底失效——`read`/`list`/`modify`/`delete` 全是空操作或返回空。理由：

- 真实 key 从**插件自己的 store**按请求解析（`resolveApiKey`），pi-ai 绝不能替这个 route 制造凭据；
- `modify` 被设计成「顺手持久化最新凭据」的可选钩子，正常请求过程中 pi-ai **可能**会调它——这里写成 no-op 而非 throw，否则一个本来正常的对话会被 500。凭据生命周期归 `api-key-store.ts`，不归 adapter。

### 图像 hooks 是**硬要求**，不是可选优化

`streamWithSnapshot` 在消息带图片而 `resolveAttachments()` 返回 `undefined` 时会直接抛 `UNSUPPORTED_CONTENT`。所以 descriptor 声明 `input: ["text","image"]` 的模型，**两个 hook 都必须接**，否则「面板上有 vision 模型、一贴图就挂」——故障发生在会话中途，最难排查。

### profile 里常被忽略的三项

- `streamIdleTimeoutMs`：一次流读悬空的空闲上限。
- `configuredMaxTokens: new Map()` / `modelErrors: new Map()`：adapter 的解析器会往里读写。
- `reasoning`：选择器「Default」钉到哪个档位。**如果平台默认就思考，这里必须钉平台默认值**——不钉的话，用户没选档位时 effort 传成 `map.off`，思考会被**静默关掉**。本插件钉 `DEFAULT_REASONING_EFFORT`（high）。

---

## 4. descriptor 契约：最容易翻车的地方

`models` 数组里每一项是一个 **descriptor**，pi-ai 的 `resolveEntry` 按它构造真实请求。**这一层是踩坑重灾区**，因为「看起来无害的缺省」往往在运行时静默改变行为。

| 字段 | 作用 | 坑 |
|---|---|---|
| `id` / `name` | 模型身份与显示名 | id 决定选择器里的模型 id，跨源去重也靠它 |
| `api` | 请求方言 | 本插件走 `openai-completions` |
| `provider` / `baseUrl` | 归哪个 provider、打到哪 | baseUrl 必须是合法 http(s) 绝对地址 |
| `input` | 模型接受什么输入 | 声明 image 就必须接 §3 的图像 hooks |
| `reasoning` + `thinkingLevelMap` | 是否思考 + 档位→wire 拼写映射 | 档位映射错 = 每请求 400；`off` 映射错 = 思考被静默关 |
| `cost` | 计费（面板用） | 未知填 `NO_COST`，别猜 |
| `contextWindow` | 窗口（**pi-ai 拿它做算术**） | 留 `undefined` = 当 **0** 用，max-token 计算直接崩 |
| `maxTokens` | 每请求输出上限 | **本插件最贵的教训，见 §4.1** |
| `compat` | wire 方言开关集 | 见 §4.2 |

### 4.1 maxTokens：不声明 ≠ 无上限

这是整份指南里**性价比最高的一条**，值得单独写。

直觉上「不声明 `maxTokens` 就不会截断」——**错**。`dsh-llm-pi-ai` 的 `resolveEntry` 解析链是：

```js
// @deepseek-ai/dsh-llm-pi-ai/lib/index.js
const DEFAULT_MAX_TOKENS = 32768;
// defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS)
const maxTokens = entry.maxTokens ?? base?.maxTokens ?? request.defaultMaxTokens;
```

descriptor 不声明 → `??` 一路落到 `request.defaultMaxTokens` = **32768**。校验器要求正整数，所以你**根本没得选**「不设上限」——只能选「平台上限的一半」或「平台上限」。

- 后果：思考（默认 `high` 档）与回答挤在 32k 预算里，长回合**先截思考**。旧决策以为「声明值会变成截断点」，真实代价是**上限减半**。
- 修法：把 `maxTokens` 钉到**实测的平台上限**，不是平台的文档默认值。本插件钉 `PROBED_MAX_TOKENS = 65_536`，来自 2026-10-01 真机探针：`32768`/`65536`/缺省不发均 200，`131072` → 400 平台原文「max_tokens 不能超过 65536」——**上限由平台自述，不靠猜**。
- 每轮实际上限是 `min(declaredMaxTokens, contextWindow − prompt − 4096)`。那个 `4096` 是 pi-ai 的 `clampMaxTokensToContext` 安全余量（`@earendil-works/pi-ai` `simple-options.js` 的 `CONTEXT_SAFETY_TOKENS`）。

### 4.2 compat：wire 方言开关集

`compat` 是一组**承重的**开关，两个对大多数网关都命中的：

- **`maxTokensField`**：输出上限字段的 wire 名。填错 = 参数静默不生效，或直接被拒。
- **`supportsDeveloperRole: false`**：网关不支持 `developer` role。**留默认 true 而网关不支持，每个请求都 403**——本插件实测（`reasoning_effort: high`）：`role: "developer"` 直接 403。这条不设就是「每请求必失败且报错模糊」的经典形态。

compat 还有一长串（thinking 相关、工具相关、cache 相关…），但**只用得上你网关真的需要的那些**，其余保持默认。`resolveEntry` 会校验你声明的 compat 字段是否在 peer 认识的名字里，写错字段名会直接报 `assertOfferedCompatFields` 一类错误——这层是**会炸的**，不是可选的。

---

## 5. 三条纪律：把踩过的坑固化成规则

写 provider 前先记住这三条，比记住任何具体字段都值钱。

**① catalog 值是线索，不是契约（[PITFALLS.md](./PITFALLS.md) §20）。** 官方文档与平台实际行为不一致是常态（本插件踩过：文档写 `thinking:"disabled"` 实际 400、文档列 `max` 实际 400）。凡是**要钉死的值**（`maxTokens`、思考档位支持面、thinking 字段拼写、图像输入拼写），一律以 **live-contract 探针实测**为准，并配**双向护栏**：实测值须仍被接受、两倍须仍被拒绝。改表必须附平台响应原文（本插件把证据原文留在契约基线的 `driftLog` 里）。

**② peer-free 才可测（[PITFALLS.md](./PITFALLS.md) §16）。** 所有能离线断言的行为——descriptor 映射、vision 判定、窗口回退、允许清单过滤——都放进不 import peer 的模块。peer 依赖的组装层留给 wiring / e2e。这样 `npm test` 才能在没联网、没 peer、干净检出时跑，也才能在 peer 缺席时**优雅降级**而不是炸。

**③ peer 解析链只有一条，别自己发明。** Node 裸模块解析只向上找 `node_modules`。npm 装进 profile 的插件天然满足；开发期用 symlink/junction 塞进 profile 的检出不满足（Node 把链接解成 realpath），现象是**面板一直说 provider 缺席而离线套件全绿**。

---

## 6. 排查速查（现象 → 根因 → 查哪）

| 现象 | 根因 | 查哪 |
|---|---|---|
| 每个请求都 403，报错含糊 | `supportsDeveloperRole` 没设 false | `compat.supportsDeveloperRole` |
| 长回答被截在 32k 附近 | `maxTokens` 未声明，吃了 peer 兜底 | `maxTokens` + §4.1 |
| 面板有 vision 模型，一贴图就 `UNSUPPORTED_CONTENT` | 图像 hooks 没接 | `resolveAttachments` / `resolveImageAccess` |
| 模型从选择器**静默消失** | provider id 与其它插件撞车 | 注册的 `providerIds` |
| 面板一直说 provider 缺席，离线套件全绿 | peer 解析不到（symlink 检出） | [PITFALLS.md](./PITFALLS.md) §16 |
| 思考档位不生效 / 思考被关 | `thinkingLevelMap` 的 `off` 映射错，或 profile `reasoning` 未钉 | `thinkingLevelMap` + profile |
| 带 "budget/credits" 字眼的 429 不重试 | peer 的 `classifyPiAiError` 把限频抢判成 QUOTA | `classifyPiAiError` 分类面 |

---

## 7. 最小可跑骨架（顺序）

1. `peerDependencies` 加齐三个 LLM peer + `@earendil-works/pi-ai`（版本区间对齐 Host 发行）。
2. 建 **peer-free** 的 `llm-models.ts`：catalog 归一化 → `toPiDescriptor(entry)` → descriptor 数组。
3. 建 peer 侧的 `llm-adapter.ts`：`createProvider` + `openAICompletionsApi` + `PiAiAdapter`，只做组装。**若同时还要接第二条 provider**（如本仓的 AgnesCode 桌面端上游），把两份组装里**相同**的部分（惰性 auth 平面、图像预算与两个图像 hook、429 纠正 Proxy）抽进一个共享核心（本仓的 `pi-ai-adapter-core.ts`），两个 shell 只留各自不同的事实：provider id、花名册构造、凭据解析器、profile 差异（如 `reasoning` 默认）。**别复制**：那层 Proxy 是打在不可改 peer 上的补丁、带到期日，两份手抄必然分叉。
4. `registerProviderPair` 里同时调 `registerAdapter` 与 `registerConfigurableProviders`，把 release 落到 state。
5. 写测试：descriptor 映射在离线套件里钉（`maxTokens`/`compat`/`contextWindow` 各一条）；注册对在 wiring / e2e 里钉；**opt-in 关闭时不注册**。
6. 接 provider 前跑一轮 **live-contract 探针**，把你打算钉死的每个值都实测并留证据。

---

## 8. 相关文档

- [AGNES-API.md](./AGNES-API.md) §7 — 推理侧接口事实源（descriptor、`reasoning_effort` 支持面、live-contract 护栏）
- [PROVIDER-HOT-RELOAD.md](./PROVIDER-HOT-RELOAD.md) — provider 开关从「配置 + 重启」到「面板开关 + 立即生效」
- [ARCHITECTURE.md](./ARCHITECTURE.md) §5 — 提供方边界与三条不变量
- [PITFALLS.md](./PITFALLS.md) §16/§19/§20 — peer 解析、adapter 注册竞态、文档与平台不一致
- [DSH-PLUGIN.md](./DSH-PLUGIN.md) — 插件机制总览（bundle / patch / peer 由 Host 提供）
- [TESTING.md](./TESTING.md) — 各套件覆盖面与门禁链
- [REFERENCES.md](./REFERENCES.md) — `upstream/` 参照件索引与「只吸收事实不复制代码」红线