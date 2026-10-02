# publish-core 拆分方案（两个 provider publisher 的共享控制面）

> 来源：2026-10 代码锐评 P1 —— `provider-publish.ts` 与 `agnescode-publish.ts` 起于同
> 一份拷贝：agnescode 的头注释自己写着它的三段承重语义是 **"restated"**，靠「一个文件里的
> 注释指着另一个」保持一致。**这不是整洁问题**：两份拷贝里已经有一边漏了半句（见 §3），
> 而漏掉的那半句落在**回滚路径**上——它只在别处已经出错时才跑，是发现分叉的最坏时机
> （[PITFALLS.md](./PITFALLS.md) §19）。
>
> 前置护栏：`test/publish-core.test.mjs`（共享原语自己的契约钉子）、`test/wiring.test.mjs`
> （并发语义，PITFALLS §18）、`test/agnescode.test.mjs`（第二个 publisher 全行为）。
> 门禁 = 这三套 + `test/store-baseline.test.mjs` + `npm run typecheck` 全绿且**零漂移**。
>
> **状态（2026-10-02）：蓝图已定，按下表 §4 分步落地（本提交只落蓝图本身）。**
> 同款术式先例：[TOKEN-STORE-SPLIT.md](./TOKEN-STORE-SPLIT.md)（按「块」拆 token-store）、
> `switch-store.ts`（四个 opt-in 开关共用一层）、`state-store.ts`（四个 writer 共用一层）。
> 这是同一份收敛清单上最后一格。

---

## 0. 划线：什么共享，什么**不许**共享

隔离纪律（[ARCHITECTURE.md](./ARCHITECTURE.md) §5.5 / [ROADMAP.md](./ROADMAP.md) §6.3）要的是
**状态实例隔离**——「AgnesCode 的动作永远不能注册/释放/扰动 Token Plan 的 provider」。
它要的**不是**代码复制。把复制当隔离，会同时失去隔离的两个好处（改一处两边生效、行为可
就地冻结），却留下两套会分叉的实现。所以划线是：

- **共享：机制**（队列、disposed 闸、单点注册、回滚、构建失败的诊断）。
- **不共享：判定与状态形状**（谁该注册、注册什么、回滚要还原哪些 domain 字段）。

判定与状态不共享不是将就，是刻意的：两边读的事实根本不同 —— Token Plan 侧是
「开关 + 持久化目录 + 白名单」，AgnesCode 侧是「开关 + 是否采到凭据 + 该凭据的逐账号 BFF base」。
把它们折成一个参数化状态机，代价是**每读一次 publish 都得先读配置才知道它在干什么**。

---

## 1. 共享原语清单（新 owner：`publish-core.ts`）

| 原语 / 常量 | 语义 | 钉它的测试 |
|---|---|---|
| `createPublishQueue()` | 并发 publish 串行化（慢者不再赢）+ `disposed` 闸 | `publish-core.test.mjs`「publish queue」组；`wiring.test.mjs` F3 |
| `createPairReleaser(state)` | 幂等释放；一个释放抛错不拖累下一个 | `publish-core.test.mjs`「release + unregister」组 |
| `registerProviderPair(llm, built, target, identity)` | 单点注册 adapter + settings 页目录行 | `publish-core.test.mjs`「registerProviderPair」组；`wiring.test.mjs` |
| `createAdapterFactoryResolver(load, exportName)` | peer 适配器工厂的加载 + memoize | `publish-core.test.mjs`「factory + shape」组 |
| `isBuiltAdapter(built)` | 工厂返回值形状校验（PITFALLS §19） | 同上（含形状矩阵） |
| `describeBuildFailure(error)` | 脱敏 + `ERR_MODULE_NOT_FOUND` 补救提示 | 同上 |
| `warnBuildFailure(logger, label, described)` | 两处同形的构建失败告警 | 同上 |
| `resolveRegistrationService({state, getLlm, release})` | 「Host 有没有 llm 服务」——**理由与状态一起落地** | `publish-core.test.mjs`「stale `built`」组 |
| `unregister({state, release, error})` | 「必须没有注册」的统一出口（清 `registered` + `built`） | 同上 |
| `swapRegistration({…})` | 换注册 + 失败还原上一对（回滚的唯一一份） | `publish-core.test.mjs`「swapRegistration」组；`agnescode.test.mjs` 回滚项 |
| `emitAdaptersUpdated(emit)` | `llm/adapters-updated` 事件（容忍拒绝） | 同上 |
| `ADAPTERS_UPDATED_EVENT` / `NO_LLM_SERVICE_ERROR` / `BAD_FACTORY_SHAPE_ERROR` | 三个共享常量：事件名、无 llm 措辞、形状校验措辞 | `publish-core.test.mjs` |

**纪律**：原语只碰 `PublisherState` 里属于「机制」的六个字段（`llmAvailable` / `registered` /
`error` / `releaseAdapter` / `releaseDirectory` / `built`）。domain 字段的还原一律由调用方通过
`onRollback` 交回来 —— 共享层不假装知道 `entries` 是什么。

---

## 2. 故意不共享的两处（逐条对照）

| 关注点 | Token Plan（`provider-publish.ts`） | AgnesCode（`agnescode-publish.ts`） |
|---|---|---|
| publish 闸 | 面板开关（**回落到**补丁 `registerProvider`，经 `switch-precedence`）+ 持久化目录 + 白名单 | 面板开关（**无配置默认**，unset 即 off）+ 逐账号 BFF base |
| 无凭据的语义 | 不适用（额度面板本身可用） | `not_configured`（面板据此显示「重新检测」） |
| 状态形状 | `entries` / `enabledIds` / `unavailableIds` / `signature` / `quotaSignature` | `rows` / `bffBase` / `signature` |
| 回滚还原 | `entries` + `enabledIds` + `unavailableIds` | `rows` + `bffBase` |
| 构建告警的 label | `Agnes` | `AgnesCode` |

**`signature` 的归属不对称是既有事实，原样保留**：Token Plan 侧由调用方写（目录轮询、
花名册保存、种子），AgnesCode 侧在 `publishProviderOnce` 内写。这不是共享层的职责——
共享层不知道「哪次改动该让签名失效」。

---

## 3. 收敛同时修掉的两处真实缺陷

两处都不是本次重构引入的，而是**复制**的直接产物；两者在兄弟插件
`dsh-connect-sensenova-token-plan` 里已被 `publish-core.ts` 的 `unregister` 修掉
（其注释记着 "The Raccoon publisher's 'no credential' branch used to leave it standing"）。

1. **`!llmAvailable` 分支漏清 `state.built`**（两侧都有）。残留的 `built` 会成为**下一次**
   publish 的回滚目标，于是回滚把一只「释放函数已经被调用过」的适配器重新注册上去，
   Host 开始供一份过期目录。修法：`resolveRegistrationService` 改走 `unregister`
   （兄弟插件这里只清了另外两处分支，`!llmAvailable` 那支的洞仍在——本仓不跟着留）。
2. **AgnesCode 的 `not_configured` 分支同样漏清 `built`**。同一个洞的第二个入口：
   「先成功注册、再丢凭据」是最容易踩到它的真实路径，已在 `test/agnescode.test.mjs`
   以端到端用例钉住（先注册 → 丢凭据 → 断言 `built === null`）。

顺带收敛的一处**文案漂移**：`ERR_MODULE_NOT_FOUND` 的补救提示，Token Plan 侧写着
「install this plugin where they resolve (or link them into its own node_modules)」，
AgnesCode 侧少了后半句（复制时漏的）。共享后统一为完整版——这是诊断信息，没有测试钉死，
统一只会多一句可执行的补救。

---

## 4. 分步落地（每步独立提交、独立可回滚）

| 步 | 内容 | 门禁 | 状态 |
|---|---|---|---|
| 1 | 新建 `publish-core.ts`（原语与常量）+ `test/publish-core.test.mjs`（共享层的契约钉子）；**尚未接线**，故现有套件零接触 | `publish-core.test.mjs` 全绿 + `npm run typecheck` | ✅ |
| 2 | `provider-publish.ts` 改成薄壳：只留 gate / 状态形状 / 目录身份 / 签名 | `wiring` + `provider` + `store-baseline` + `typecheck` 零漂移 | ✅ |
| 3 | `agnescode-publish.ts` 改成薄壳：只留三门闸 / 花名册与 base 还原 | `agnescode` + `wiring` + `store` + `typecheck` 零漂移；新增丢凭据回归项 | ✅ |

每步**只搬不写**：闸的次序、状态字段的赋值次序、工厂调用的参数、事件 emit 的时点，
全部原样移动。本方案允许的新代码只有两处：共享原语本身，以及 §3 记录的两处修复。

---

## 5. 红线核对表（拆分前后逐条过）

- [x] 并发语义不变：队列串行、`disposed` 后不再注册、慢者不再赢（`wiring.test.mjs` F3 原样通过）。
- [x] 回滚语义不变：单点 `registerPair`、工厂结果 await + 形状校验、失败还原**上一对**
      （`agnescode.test.mjs` 回滚项断言 `state.built` 仍是上一只 v1）。
- [x] 「构建失败不动已注册的那一对」不变：build 抛错时 `built`/`registered`/释放函数保持原样。
- [x] 状态字段名不变（`state.built` 有测试读者，不能改名）：`built` / `releaseAdapter` /
      `releaseDirectory` / `registered` / `error` / `llmAvailable`。
- [x] 对外返回面不变：`createProviderPublisher` 仍返回 `{state, publish, release, dispose,
      isDisposed}`；`seedPublisherFromCatalog` / `catalogSignature` / `agnescodeSignature`
      仍从原文件导出（调用方 `index.ts` / `lifecycle.ts` / `snapshot-aggregate.ts` /
      `routes/models.ts` 一行未改）。
- [x] peer-free 不变：`publish-core.ts` 只 import `util.ts` 与 `host-config.ts`，无静态
      `@deepseek-ai/*`（`docs.test.mjs` 检查 13）。
- [x] 隔离不变：两侧 publisher 仍是各自的 `state` 实例，`registerPair` 各绑自己的
      provider id 与 display name；AgnesCode 的动作无法触达 Token Plan 的状态。

---

## 6. 已知边界与后续候选（本次**不做**）

- **`getLlm` 返回 `undefined` 不被容忍**：`llm !== null && typeof llm.registerAdapter === …`
  在 `undefined` 上会抛（原先如此，本次原样保留）。改成宽松判断能多一层降级，但那是另一个
  行为改动，不塞进「只搬不写」的重构里。
- **AgnesCode 的 `state.signature` 目前只写不读**：重建判定实际由 `agnescode-lifecycle.ts`
  比较 `bffBase` 做。它要么该被删，要么该被某个读者用起来——留给下一次判定，不在本次动。
- **`HostDeps` 仍是宽包**：主通道 `createProviderPublisher(deps: HostDeps)` 的字段是 `any`，
  而 AgnesCode 用的是专用 deps 类型。收紧它属类型围栏议题（与 `routes/` 那次同类），
  与「机制收敛」无关，故不在本次。
