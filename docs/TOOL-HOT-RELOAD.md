# 出图 / 视频工具热挂载（Tool Hot-Mount）

本文记录 0.13.x 起出图 / 视频 agent 工具（`agnes_draw_image` / `agnes_video_generate`）的**热挂载机制**：面板开关、模型偏好的每次写入都**就地**收敛工具的注册 / 撤下 / 换模型，无需重启 Host。**路由与开关的现行契约以 [API.md](./API.md) §1（`/draw` / `/video` 路由段）为准，provider 注册开关的决策记录见 [PROVIDER-HOT-RELOAD.md](./PROVIDER-HOT-RELOAD.md)，本篇侧重机制与边界。**

---

## 1. 为什么 0.4.x 时期不热

出图（0.4.2）与视频（0.4.3）工具开关落地时，「面板开关 + 立即生效」的语义只兑现了一半——**开关值本身**即时读写，工具的实际挂载 / 缺席要等**下一个 Host 启动**时 `startSideEffects` 重读生效值。三个成因，全部是本插件自己的接线选择，不是宿主能力边界：

1. 开关状态存插件私有状态文件（`draw-store.ts` / `video-store.ts`），由自有路由 `POST /api/<name>/draw|video` 写入——路由只做**持久化 + 回显**，从不同步宿主注册表。
2. 旧的一次性 `mountAgentTool` 把宿主 `tools.register()` 返回的卸载句柄直接丢弃（fire-and-forget），工具「挂载一次」后进程内无法撤下。
3. 一条过时的注释（「the tools registry has no unregister call」）让「宿主没有卸载能力」当成了已知事实——**这是错的**。宿主 `tools.register(definition)` 本就返回一个 `() => void` 的 disposer；同族插件 workbuddy 的 image / video 工具长期以「常驻注册 + 保留句柄 + 开关切换时 live 卸载 / 换模型」的形态跑在生产。

## 2. 机制

### 2.1 宿主能力

`HostCtx.tools.register(definition)` 返回 `(() => void) | undefined`（`types.ts` 把返回类型从 `unknown` 收紧为 `(() => void) | undefined`）。返回 `undefined` 的宿主（不提供卸载路径）下工具退化为**粘性挂载一次**——那是宿主能力边界，行为与 0.4.x 一致，不是缺陷。

### 2.2 每工具一个热挂载协调器

`createToolMount`（`src/host/lifecycle.ts`，替代旧的一次性 `mountAgentTool`；`registerDrawTool` / `registerVideoTool` 是它的两个薄包装，差异只有开关键、模型键、fetch 与工厂，降级阶梯写一份，两个工具**不可能降级不同**）。每个协调器持有自己的闭包状态：

| 状态 | 含义 |
|---|---|
| `tools` | 缓存的宿主 tools 服务（`resolveServiceWithRetry` 找到一次后复用；没找到时每次 `sync()` 重新探测，晚到的服务能被后续协调接住） |
| `registered` | 宿主是否真的持有该工具的一份副本 |
| `disposer` | 撤下句柄；宿主不给卸载路径时为 `null`（粘性） |
| `regModel` | 当前注册所用模型偏好（面板保存值 > 配置默认） |
| `chain` | **同一条 promise 链**：所有协调（挂载种子、开关 POST、模型 POST、forget、teardown 前在途调用）串在这条链上，并发触发不会重复注册同一工具；链上每跑一次都**重读当前生效值**再收敛，排队的旧协调照样落到最新态 |

收敛规则（`sync()` 每跑一次）：

- **关** → 有 disposer 就撤下（清状态后 `safeCall(disposer)`）；没有则保持粘性，不动。
- **开且与已注册模型一致** → 幂等，不动。
- **开但模型变了** → 有 disposer 先撤旧再注新（模型偏好也即时生效）；无 disposer 保持首次注册值。
- 挂载路径：读 tools 服务 → 懒加载 tools peer（`defineTool`）→ 工厂构造工具定义（目录**调用时**读取：活目录缺席回落 `catalogStore.list()`，目录刷新落地不需要重注册）→ `tools.register(definition)`（catch：拒绝的注册表降级为工具缺席）→ 捕获 disposer。

**双降级纪律不变**：无 tools 服务 / peer 装载失败 / 注册表拒绝——每一档都是**静默**降级：面板与 provider 照常，工具只是缺席，没有任何一行日志把失败打成配置错误。

### 2.3 句柄与触发点

句柄落在接线袋（`wiring.drawToolMount` / `wiring.videoToolMount`，`startSideEffects` 填充）。开关路由（`src/host/routes/tool-switch.ts` 的 `registerToolSwitchRoute`，draw 与 video 共用一份处理器）在**每次成功的 POST 写入后**（`enabled` / `forget` / 模型偏好三处）调用协调器 `sync()`：

- 协调是 **fire-and-forget**，不阻塞 HTTP 响应；失败自吞（面板状态永远是对的，工具注册跟不跟上取决于宿主能力）。
- **GET 只读路径绝不协调**——读不应改写宿主注册表。

## 3. teardown 顺序

卸载顺序按 [PITFALLS.md](./PITFALLS.md) §18 钉死：`stop → dispose → release → tools → off`。两个工具协调器的 `dispose()` 在路由 `off()` **之前**执行（撤下活工具 + 关闭句柄），让在途的开关 POST 无法再往一个正在离场的宿主里同步工具；句柄关闭后，队列里未跑的 `sync()` 变成 no-op 而不是迟到的注册。

## 4. 边界与失败形状

- **宿主不给卸载句柄**（`register` 返回 `undefined`）：工具对本进程**粘性**——开关 / 模型改动能被协调器读到，但没有句柄可撤，注册保持首次值；行为与 0.4.x 完全一致。面板开关的状态读写永远即时生效。
- **两个 Host 进程共享同一状态目录**：后写者胜（与 provider / throttle / catalog 状态文件语义一致）。
- **协调失败自静默**：tools 服务缺席、peer 装载失败、注册表拒绝——面板与 provider 零影响，工具缺席即可；没有任何一行日志为它点名。

## 5. 测试锚点

- `test/routes.test.mjs`：开关路由的无 tools 服务降级路径（假宿主 ctx 无 `tools` 服务）与键名隔离（组 S 交叉投递 / 各自回读，[API.md](./API.md) §1 `/draw` / `/video` 段引注）。
- **已知缺口**：disposer 路径（挂载 / 撤下 / 换模型）尚无离线套件——需要向挂载缝注入一个返回 disposer 的假 `tools` 服务；补套件前先冻结现状。
- 工具纯逻辑（失败分诊 / 冷却 / hints）由 `test/draw.test.mjs` 等覆盖，与挂载无关。

---

> 跨链：决策记录（为何不走 volatile、开关语义沿革）见 [PROVIDER-HOT-RELOAD.md](./PROVIDER-HOT-RELOAD.md) §7–§9；出图对接点（ARCHITECTURE §5.4 接法 B）见 [ARCHITECTURE.md](./ARCHITECTURE.md) §5.4；「为何自己造工具」的 runtime 取证见 [DSH-UNIFIED-INTERFACE-AUDIT.md](./DSH-UNIFIED-INTERFACE-AUDIT.md)。
