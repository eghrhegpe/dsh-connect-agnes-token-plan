# 提供方热开关（Provider Hot-Reload）

本文记录「模型接入（API Key）」区的注册开关从**配置字段 + 重启**改为**面板开关 + 立即生效**的设计决策、调研依据与实现边界。0.3.1 引入。

---

## 1. 背景：原设计为什么被改

0.3.0 把「注册 Agnes LLM 提供方」做成 `cordis.patch.yml` 里的 opt-in 配置字段 `registerProvider`（默认 `false`）。理由当时是成立的——注册模型源是 Host 级变更，不该装个插件就默默改了全局行为。代价是文案必须解释「这不是面板开关，改配置、重启 Host 才生效」，用户实测读不懂（面板上「直接注册未开启」的措辞被误认为 UI 开关）。

目标：把「是否注册」变成面板上一个**真的开关**，切换立即生效、无需重启，同时保留「默认关」的 opt-in 语义和已有的部署级配置。

## 2. 同类插件的调研结论（2026-09-28，本机安装版本）

四个参考对象**全部是单包**（adapter 与面板同包），「适配器独立化」在 DSH 生态的真实形态是**包内分层**，不是拆包：

- **`@mars-sea/dsh-commandcode-provider`（desktop, 0.11.16）**：`CommandCodeAdapter` 是纯类，不 import 任何 DSH/cordis 类型，options、凭据解析、多账号轮换全是注入回调（lib/index.js:3016、8356-8374）。Config schema 全字段 volatile，设置页改动热生效。凭据一律走凭据服务 seam（`role("credential-ref")`），模型目录远端拉取 + 磁盘原子缓存 + Host 代理下发。
- **`dsh-connect-trae`（web）**：provider **常驻注册** + 注册句柄保存，开关切换用 `AdapterRegistrationHandle.replace([])` 热撤路由，同一同步段内同时 replace adapter 与 directory（lib/index.js:4333-4342），立即生效、无需重启。依赖 0.1.7 的 volatile 字段活引用（`{get(): T}`），为解包踩了一整套坑（`unwrapVolatile`、写后回读校验、schemastery ≥3.18.3，见其 CHANGELOG 141-146 段）。
- **`dsh-connect-workbuddy`（web, 2.1.0）**：同样是「常驻注册 + `replace()` 换空列表」（lib/index.js:1326-1335）；adapter 与目录注册**原子成对**（try/finally 回滚，lib/index.js:1390-1412）；`settingsNs` 必须从 `ctx.fiber.entry.options.id` 推导。没有「是否注册 provider」的总开关——provider 常驻，只有 per-region 开关。
- **`@eghrhegpe/dsh-connect-qoder`（desktop, 0.3.2）**：**条件注册 + 事务式重发布**——按「已成功启动的区域」动态重建 adapter 并整体重新注册，失败回滚到上一个注册对（lib/index.js:720-775）；区域开关存在**插件自有偏好状态**（preferences.js），不在 cordis 配置里；「无 peer 依赖纯函数模块层」与「宿主接线层」分离（README.md:254-256）。

对本仓库最直接的两条启示：其一，`index.ts` 的 `publishProvider()` 已经是 qoder 式「事务发布 + 失败回滚」，且每次轮询都重读开关——**热生效的执行机制本来就在**，缺的只是「面板 → 开关状态 → 立即触发发布」这最后一公里。其二，纯模块层（`src/host/llm-models.ts` / `llm-adapter.ts` / `catalog-store.ts` / `api-key-store.ts`）与 qoder 的分层同构，「适配器独立化」的地基已就位。

## 3. 设计决策：不走 volatile 路线，走自有状态 + 自有路由

trae/workbuddy 的 volatile 路线（把 `registerProvider` 标成 Config schema 的 volatile 字段、面板经宿主 settings 写入）能做，但代价是：锁定宿主 ≥0.1.7-rc.1 与 schemastery ≥3.18.3、全链路活引用解包、写后回读校验——trae 用一整轮回归测试才踩平。

本插件选择更贴合自身架构的路径，与 qoder 的偏好存储同构：

1. **开关状态存插件私有状态文件** `state/<profile>/<name>/provider.json`（新模块 `provider-store.ts`，完整性纪律与 `catalog-store.ts`/`throttle-store.ts` 一致：版本化、临时文件 + 原子改名、损坏即读作未设置；按 profile 分段，见 [PITFALLS.md](./PITFALLS.md) §23）。
2. **优先级**：面板保存过的值 > `cordis.patch.yml` 的 `registerProvider`（后者降级为「出厂默认」）。从未动过面板开关的部署，行为与 0.3.0 完全一致。
3. **面板开关 → `POST /api/<name>/provider`**（同源围栏 + body 上限，与账号/api-key 路由同一信任形状）→ 存状态 → **立即** `publishProvider(当前目录, 当前允许清单)` → 返回去密状态。不用等下一个轮询周期。
4. 快照 `llm.registerProvider` 回显**生效值**（不再是 patch 直读），新增 `registerSource`（`"panel"` / `"config"`）说明当前值来自哪一侧。

不选 volatile 的另一条理由：volatile 是「配置文档可写」机制，而「是否向 Host 注册一个模型源」是运维意图而非配置项——把它放进 patch 层正是 0.3.0 文案混乱的根源。状态文件让它归位为「插件自己的运行时状态」。

## 4. 改动清单（0.3.1）

| 文件 | 改动 |
|---|---|
| `provider-store.ts`（新增） | 开关状态文件读写；无 peer 依赖，干净检出可测 |
| `index.ts` | 生效值解析（面板 > 配置）、新路由 `GET/POST /api/<name>/provider`、快照 `llm` 块回显生效值与来源、dispose 清理 |
| `client.js` | `ProviderStatus` 区新增开关控件（POST 后刷新快照）；中英文字典同步 |
| `package.json` / `docs/DSH-PLUGIN.md` | `files` 增补 `provider-store.ts`，教学快照同步 |
| `test/provider.test.mjs` | `provider-store` 纯逻辑用例（归一、读写、版本拒绝、损坏忽略、forget） |
| `test/routes.test.mjs` | 新路由用例（GET/POST、立即发布、403/405/400、回退配置默认） |

语义保持不变的红线：**默认关**（`registerProvider: false` 的部署在未触碰面板时零行为变化）；**凭据不入库**纪律不动（开关不是凭据）；`registerProvider` 仍是合法配置字段，注释指向本文。

## 5. 已知边界

- 开关只控制「是否注册」，不控制「勾选哪些模型」。后者在 0.3.2 起有独立路由 `POST /api/<name>/models`（见 [API.md](./API.md) §1），与开关走的是同一套「存私有状态 + 立即发布」的机制，存的是同一份 catalog 状态文件里的 `enabledModelIds`。
- 两个 Host 进程共享同一状态目录时，后写者胜（与节流/目录文件一致的语义）。
- `POST /provider` 触发的发布失败会回滚到上一个注册对并带错误原因返回，面板显示 `llm.providerError`；不拖垮已在服务的模型。

## 6. 0.3.2 增量：模型允许清单

面板新增「勾选哪些模型推送到 DSH」，四个决策需要记录理由：

1. **空清单 = 不过滤**（沿用 WorkBuddy 约定，`catalog-store.normalizeEnabledIds` 已如此）。首次安装没有任何历史清单，若「空 = 一个都不推」，新装用户会看到一个空的模型选择器，只能靠猜才会去勾。
2. **「一个都不推」必须有独立写法**。空清单已经被上一条占用了，所以需要一个不会被任何真实模型命中的哨兵 `__hide_all__`：它让清单非空（因此走严格允许清单分支），同时又匹配不到任何模型。没有它，用户想临时把全部模型收起来就做不到——只能删掉 API Key。
3. **面板与 Host 各持一份同一字面量**。浏览器侧的 `client.js` 只能 require 包名，import 不到本仓库的 `llm-models.ts`，所以 `HIDE_ALL_MODELS` 在两侧各写一次。这是一处**故意的重复**：`test/provider.test.mjs` 把两份字面量做相等断言，任一侧改名都会当场红，而不是等上线后静默变成「全部模型都推送」。
4. **POST 只改清单，不改目录**，并在同一请求内 `publishProvider(当前目录, 新清单)`。同时把 `providerState.signature` 设成新清单的签名——否则每次轮询都会看到「签名变了」而重复发布一次，把一次点击变成每 30 秒一次的注册抖动。
5. **只推勾选的，目录仍全量可见**。`snapshot.llm.models` 是整份目录（不受过滤影响），`modelCount` / `visionCount` 才是**实际注册**的数量（按清单过滤后）。两者分开，面板才能一边说「注册了 1 个」一边让用户看到还能勾选哪 6 个。

## 7. 0.4.2 增量：出图工具开关（drawEnabled）

出图吸收（§5.4 接法 B）的 agent 工具 `agnes_draw_image` 也走同一套「存插件私有状态 + 面板开关」的机制：

| 文件 | 改动 |
|---|---|
| `draw-store.ts`（新增） | 出图开关状态文件 `$DSH_HOME/state/<profile>/<plugin>/draw.json`；完整性纪律与 `provider-store.ts` 完全一致 |
| `index.ts` | wiring 里增补 `drawStore`；传给 `registerRoutes` 与 `startSideEffects` |
| `lifecycle.ts` | `registerDrawTool` 改为读「面板保存值 > 配置默认值」的生效值，而不是直接读 `settings.drawEnabled` |
| `routes.ts` | 新增 `POST /api/<name>/draw`，与 `/provider` 同一信任形状 |
| `snapshot-aggregate.ts` | 快照 `llm.drawEnabled` / `llm.drawSource` 回显生效值与来源 |
| `client.js` | `ApiKeyForm` 区新增「出图工具」卡片，含 `DrawSwitch` 控件 |

与 provider 开关的一个**语义差异**需要说明：provider 开关改的是「当前请求立刻重新发布注册对」，改完立即生效；draw 开关改的是「挂载时是否注册 agent 工具」，**当前 Host 进程里已经注册的工具不会因为改开关而消失或出现**——要真正生效需要在**下一个 Host (re)mount**（即重启 `dsh web` 或重新安装插件）时，`lifecycle.ts` 的 `startSideEffects` 重新读生效值。面板开关本身是「立即生效、无需重启」的**状态读写**；工具的实际挂载/卸载要等到下次 Host 启动。面板文案里「立即生效」指的是**开关值**本身，不是 agent 工具的实时性。

**已知边界**：两个 Host 进程共享同一状态目录时，后写者胜（与 provider / throttle / catalog 文件语义一致）。`POST /draw` 只改开关值，不直接操作 tools registry——这是有意的：tools registry 没有 `unregister` 语义（见 `lifecycle.ts` 注释），强行卸载要等 Host 生命周期自然结束。

## 8. 0.4.3 增量：视频工具开关（videoEnabled）

视频吸收（与 §5.4 接法 B 对称）的 agent 工具 `agnes_video_generate` 走**同一套**机制——同一个 store 形状、同一个路由处理器（`registerToolSwitchRoute`，draw 与 video 共用一份）、同一个「面板保存值 > 配置默认值」生效规则。

| 文件 | 改动 |
|---|---|
| `video-store.ts`（新增） | 视频开关状态文件 `$DSH_HOME/state/<profile>/<plugin>/video.json`，与 `draw-store.ts` 逐字镜像 |
| `video.ts`（新增） | 视频纯逻辑层：`agnes_video_generate` 工具定义、建任务/轮询状态机、V2.0 与 2.5 两套请求体构造与校验（按模型家族分派） |
| `index.ts` | wiring 里增补 `videoStore` |
| `lifecycle.ts` | `registerVideoTool` 与 `registerDrawTool` 是同一私有 `mountAgentTool` 的两层薄包装（共享降级阶梯，二者不可能降级不同） |
| `routes.ts` | 新增 `POST /api/<name>/video`，与 `/draw` 共用 `registerToolSwitchRoute` |
| `snapshot-aggregate.ts` | 快照 `llm.videoEnabled` / `videoSource` / `videoModel` / `videoCandidateIds` / `video25ModelIds` 回显 |
| `client.js` | 「接入 API」区新增「视频工具」卡片，含 `VideoSwitch` 控件（`ToolSwitch` 与 `DrawSwitch` 共用同一私有体） |

**隔离是唯一的额外约束**：draw 与 video 共用一份路由处理器，把它们的状态分开的**只有键名**（`drawModelId` / `videoModelId`）与各自闭包捕获的 store。少写错一处键名，两个工具就会**静默共用一个模型**——所以 `routes.test.mjs` 组 S 专门钉了交叉投递与各自回读（`AGNES-API.md` §7.5 也复述了这条）。

**视频没有 30s 冷却门**（draw 有）：这是决策不是遗漏。一次视频尝试耗时分钟级、与出图共用同一视频限频池，协议自身延迟已远宽于 30 秒。

---

> **结构沿革注记**：本节两张改动表是 0.4.x 各增量落地时的定格记录，表中「新增」文件此后又经历过收敛与拆分。查现行结构以 [ARCHITECTURE.md](./ARCHITECTURE.md) §2 为准；与上表直接相关的三处：
>
> - **video 逻辑层已拆分**：表中的单文件 `video.ts` 现在只保留 `agnes_video_generate` 工具定义与兼容 barrel；建任务/轮询状态机在 `video-client.ts`，V2.0 与 2.5 两套请求体分别在 `video-protocol.ts` / `video-protocol-25.ts`，目录花名册在 `video-models.ts`。
> - **两个开关 store 不再逐字镜像**：重复体已收敛到 `switch-store.ts`（provider / draw / video / AgnesCode 共用一层），`draw-store.ts` 与 `video-store.ts` 只剩各自的文件名、形状版本、model wire key 与报错措辞。事故与收敛过程见 [PITFALLS.md](./PITFALLS.md) §34。
> - **draw / video 共用的路由处理器**现在落在 `routes/tool-switch.ts`，由 `routes.ts` 门面统一注册。

