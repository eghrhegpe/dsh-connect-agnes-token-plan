# agnescode.ts 拆分蓝图（协议层 + 加密采集层 + BFF 三端点）

> 来源：2026-10 代码锐评 P1-2 —— `src/host/agnescode.ts` 已长至近千行，跨 **6 类职责**
> 挤在一个文件：路径解析 / 文件族分类 / base 信任钉死 / 会话解析 / JWT 解期 / 请求头 /
> **DPAPI 解密（九档分诊）** / **本机采集 walk** / 目录拉取 / 余额 / **积分流水分页**。
>
> 前置护栏：[`test/agnescode.test.mjs`](../test/agnescode.test.mjs)（离线检查，注入 io/fetchers，不触真 DPAPI/网络）、[`test/agnescode-ledger.test.mjs`](../test/agnescode-ledger.test.mjs)、[`test/agnescode-dpapi.test.mjs`](../test/agnescode-dpapi.test.mjs)、[`test/agnescode-stats.test.mjs`](../test/agnescode-stats.test.mjs)。
> 拆分门禁 = 以上四套全绿且**行为零漂移**（本模块纯函数 + 依赖注入，离线可全测）。
>
> **状态（锐评落地前）：本文是拆分的事前蓝图，尚未执行。引用 [ADR-005](./ADR.md) 吸收准入门槛——新能力在「装不下」时先出拆分蓝图、冻结行为基线、再实现。本文件即对该门槛的回执：先申报，不直接拆。**
> 同款术式先例：[TOKEN-STORE-SPLIT.md](./TOKEN-STORE-SPLIT.md)（按「块」拆）、[PUBLISH-CORE-SPLIT.md](./PUBLISH-CORE-SPLIT.md)（共享控制面收敛）。

---

## 0. 为什么不直接拆：两条正交的变更轴

`agnescode.ts` 当前是「协议层」和「本机采集层」的合体，但两者的**漂移来源不同**：

- **加密 / 采集轴**（§1）：随**桌面端版本**漂移——`app.asar` 解包（`upstream/AgnesCode-desktop-1.0.68/`）一旦升级，os_crypt 前缀、会话文件名族、`bffPublicBaseUrl` 形状都可能变；九档分诊（`FILE_MISSING` … `UNSUPPORTED_PLATFORM`）每一档都是真实踩过的桌面端形态。这块的稳定性锚点是「本机快照 + 逆向件（基于 1.0.17）」，与平台无关。
- **BFF 三端点轴**（§2）：随**平台契约**漂移——`/api/v2/subscription/credits-balance`（余额）、`POST /api/v1/subscription/credits-transactions`（流水，分页 `page_size=100`、`MAX_PAGES=5`、`WINDOW_DAYS=30`）、`{bff}/models`（目录，v2 比 v1 多 `auto`）。这块的稳定性锚点是「live 探针（`test/live-agnescode.mjs`）+ ROADMAP §6.3.1」。

混在一个文件里意味着「改余额解析要重读 DPAPI 解密层」——这正是 ADR-005 想拦的「结构债事后锐评」的反面：把两轴的基线冻结成两个独立模块，改其中一个时另一轴的测试不必重读。

红线约束（[AGENTS.md](./../AGENTS.md) 红线①/③）在两轴**都不变**：采集侧写权限为零（`agnescode*.ts` 无 `writeFile`/`rename`/`rm`，写入面只在 `state-store.ts` 的原子临时文件 + rename），任何拆分不得引入对桌面 App 目录的写。

---

## 1. 加密 / 采集轴（新 owner：`agnescode-harvest.ts` + `agnescode-crypto.ts`）

| 现行归属（`agnescode.ts`） | 职责 | 新 owner |
|---|---|---|
| `resolveAgnescodeAppDirs`（:89）/ `AGNESCODE_APP_DATA_CANDIDATES`（:99）/ `AGNESCODE_SESSION_FILE_PATTERN`（:104）/ `AGNESCODE_SESSION_FAMILY_PATTERN`（:115） | 路径解析 + 文件族分类 | `agnescode-harvest.ts` |
| `trustAgnescodeBffBase`（:166） | base 信任钉死（https + `*.agnes-ai.cn`/`.com`，无端口） | `agnescode-harvest.ts` |
| `classifyAgnescodeSessionFiles`（:107） | 文件族分诊（strict vs loose） | `agnescode-harvest.ts` |
| `parseAgnescodeSession`（:195）/ `decodeAgnescodeJwtExpMs`（:243） | 会话 JSON 解析 / JWT 解期 | `agnescode-harvest.ts` |
| `agnescodeHeaders`（:257）/ `AGNESCODE_BASE_HEADERS`（:30） | 请求头（含 `X-App-Id`/`X-Platform` 网关闸） | 网关闸留 `agnescode-harvest.ts`；匿名变体 `agnescodeRequestHeaders` 已在 `agnescode-models.ts` 复用，不挪 |
| `decryptAgnescodeSessionBlob`（:272）/ `unwrapAgnescodeLocalStateKey`（:297）/ `dpapiChildEnv`（:344）/ `defaultDpapiUnprotect`（:359） | **DPAPI 解密（九档分诊核心）** | `agnescode-crypto.ts` |
| `surveyAgnescodeStorage`（:427）/ `harvestAgnescodeLocalSession`（:481） | 采集 walk + 九档分诊（`FILE_MISSING` … `UNSUPPORTED_PLATFORM`） | `agnescode-harvest.ts` |

`agnescode.ts` 拆后收口为 **薄 facade**：`createAgnescodeProtocol(options)` 组装 `agnescode-harvest` + `agnescode-crypto` + 三端点函数，导出原公共 API（`fetchAgnescodeCatalog`/`fetchAgnescodeBalance`/`fetchAgnescodeLedger`/`harvestAgnescodeLocalSession` 及全部常量 re-export）。`agnescode-lifecycle.ts` / `agnescode-publish.ts` / `routes/agnescode.ts` 的 import 一行不动。

---

## 2. BFF 三端点轴（新 owner：`agnescode-bff.ts`）

| 现行归属（`agnescode.ts`） | 端点 | 新 owner |
|---|---|---|
| `agnescodeApiRoot`（:221）/ `fetchAgnescodeCatalog`（:629） | `{bff}/models`（v2，多 `auto`） | `agnescode-bff.ts` |
| `fetchAgnescodeBalance`（:706） | `GET {bff}/api/v2/subscription/credits-balance`（订阅池信封，**非** Token Plan 语义） | `agnescode-bff.ts` |
| `fetchAgnescodeLedger`（:773） | `POST {bff}/api/v1/subscription/credits-transactions`（分页 `page_size=100`、`MAX_PAGES=5`、`WINDOW_DAYS=30`、`AGNESCODE_FALLBACK_ASOF`） | `agnescode-bff.ts` |

信封契约（锐评 P1-1 已先行抽为 `agnescodeEnvelopeData()`，见 `agnescode.ts`）随三端点一起搬入 `agnescode-bff.ts`，保持单点。第三处独立断言（`test/live-agnescode.mjs` 的申诉信封判定）是活契约探针，不在搬运范围。

---

## 3. 拆分门禁（落地前必须先全绿）

1. `npm run typecheck` 零错误。
2. `test/agnescode.test.mjs` / `test/agnescode-ledger.test.mjs` / `test/agnescode-dpapi.test.mjs` / `test/agnescode-stats.test.mjs` 全绿（四套，roster 钉死），且 **断言计数零漂移**（DOM/注入形态已离线覆盖九档分诊与分页边界）。
3. `npm run build` 重建 `lib/` + `client.js` 同 commit（[ADR-008](./ADR.md)）；`build-gate` 双向比对通过。
4. `npm test` 全量 33 suites + 5 gates（含 `dup-gate`：拆分不得新增 `agnescode.ts` 之外的克隆；`tsc-gate`；`composer-slot-gate`）。

> 注意：本蓝图是「申报」，不要求本次立即执行。若后续在 `agnescode.ts` 内新增能力（如新的 BFF 端点或新的桌面端形态），按 ADR-005 的债务控制阀——先评估落点，落不进现有两轴时回到本蓝图填块，再实现。
