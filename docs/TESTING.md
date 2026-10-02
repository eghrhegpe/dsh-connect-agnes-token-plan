# 测试体系（Testing）

本插件以**离线单元测试**为主：网络层全部打桩，绝不向真实平台发请求。目标是守住三条关键路径——登录/重登、令牌存储、路由与面板决策。

---

## 1. 运行

```powershell
npm test                    # 全量离线门禁：请见 `test/_roster.mjs` 与 `node test/run.mjs --list`（磁盘所有 *.test.mjs 自动构成名册）；末尾 build-gate（重建 src/ 全部源码并验证 lib/ 与 client.js 产物；无 tsdown 则 SKIP）+ e2e-gate（无 dsh CLI 则 SKIP）
npm run test:e2e            # 只跑端到端：真 Host + 假平台，需 dsh CLI 在 PATH
npm run test:live:contract  # 仅 live-contract.mjs，需联网 + AGNES_TOKEN_PLAN_API_KEY，重放推理契约
```

**套件名册的事实源只有一个**：`test/_roster.mjs` 的 `listSuites()`（对 `test/*.test.mjs` 逐文件扫描）。`package.json#scripts.test` = `"node test/run.mjs"`，`run.mjs` 直接 `import roster`；CI offline job 与 `package.test.mjs` 三方钉死一致性。**本行枚举不再维护第二份清单**。如需查看当前套件列表，运行：`node test/run.mjs --list`。

套件清单以 `package.json#scripts.test` 为准（不在本文件背书数字）。测试**无需 `npm install`**：`@deepseek-ai/dsh-credentials` 是 Host 里的 peer 依赖，由 `test/peer-roots.mjs` 在 DSH 运行时里就地解析（`$DSH_HOME` → 插件 `node_modules` → 默认安装位置 `~/.dsh/dsh-asar-unpacked` → 打包安装目录）。找不到时会列出每个候选根**各自失败的原因**，而不是静默跳过或只报搜索路径。`config.test.mjs` / `parsers.test.mjs` / `contract.test.mjs` / `retry.test.mjs` 不依赖任何 peer，干净检出即可跑。

---

## 2. 各测试文件职责

| 文件 | 守什么 |
|---|---|
| `test/agnes-auth.test.mjs` | Agnes 一跳登录：请求形状（JSON body、`x-user-language`）、成功/拒绝信封解析、`classifyLoginFailure` 分类（错密码 / 锁号 / 限频 / 验证码，**平台原话优先于状态码**）、`parseRetryAfterMs`（`Retry-After` 头 + 中英文「N 分钟后重试」）、`refresh()` 必须抛 `NO_REFRESH_TOKEN`、**登录 trace 成功与失败都要上报**、错误码 taxonomy 一致性 |
| `test/store.test.mjs` | 令牌存储与重登、并发轮询只触发一次刷新、401 拒绝记忆、节流状态跨进程、env 账号识别、内存态 ephemeral、**真实凭据服务解析器校验写入记录**（非 `grant` kind 即红） |
| `test/store-baseline.test.mjs` | **token-store 全行为冻结基线**：15 个场景、42 帧，把凭据服务调用序列（read/modify/delete/resolve/set/unset）、节流存储读写、grant/ref 落盘、错误码与完整 `state()` 逐帧冻结在 `test/baselines/token-store-behavior.json`；拆分/改动 token-store 前后必须零漂移（见 §5） |
| `test/routes.test.mjs` | 把面板的判断逻辑**原样跑在真实接口响应上**，专门守住「无凭据服务时表单仍可达」这条路径；同源校验、body 上限、跨域拒绝、**一个请求只答一次**；api-key 路由（credentials/memory/env 三来源、不回显、forget 不动环境变量）、快照 `quota`/`usage` 块与 provider 注册/签名去抖/无 llm 降级（假 adapter 工厂经 apply 第三参注入，不碰真 peer） |
| `test/panel.test.mjs` | 面板「显示什么」的决策，**直接从 `src/client/` 的真实模块取用**（见 `panel-decision.js`），而不是手写副本——逻辑一变测试自动跟；**中英文字典键集一致**；控制台故障不伪装成登录表单；**AgnesCode tab 自己的渲染决策**（`agnescodeView`：错误行 / 凭据卡 / 是否已关联——该 tab 走自己的路由与节奏，不经 `decidePanelView`，但决策同属「显示什么」，故归本套件而非 `render.test.mjs`） |
| `test/render.test.mjs` | 面板「数字怎么上屏」的渲染，`panel-render.js` 从真实模块取用 `PlanCard` / `QuotaWindowCard` / `UsageTotals` / `UsageChart` / `SectionCard`、以记录型 `h` 在 Node 求值：**额度卡头条必须是上限而不是百分比**、进度条色阶错档、柱高未按最大桶缩放、除零 NaN 都会红 |
| `test/parsers.test.mjs` | **控制台响应解析层**（纯函数、无网络）：字符串数值与 epoch/ISO 归一、`"0"` 不得读成 1970、`checkShape` 双向漂移检测（`shapeWarnings` 的来源）、`parseUsageSeries` 分桶按时间序排序且 totals **跨桶求和**、`quotaWindows` 四窗口顺序与「0 上限被丢弃」、`matchCurrentPlan` 的 uuid/名称信号与「裸数字 id 不是信号」、`usageWindow` 的日期窗口、`identifyVisionModel` 只看 input 模态 |
| `test/provider.test.mjs` | **推理侧纯逻辑层（无 peer、干净检出可跑）**：`llm-models` descriptor 映射（vision 自动识别、`supportsDeveloperRole:false`、不声明 maxTokens 值、contextWindow fallback、去重、允许清单空=不过滤）、`catalog-store`（版本号拒绝、损坏即忽略、原子往返、只读目录降级内存）、`provider-store`（开关归一、面板值持久与重挂载读取、版本号拒绝、非布尔即未设置、forget 回退配置默认）、`api-key-store`（credentials→memory→env 优先级、save/forget、forget 不动环境变量、凭据服务故障穿透） |
| `test/config.test.mjs` | **配置单一事实源钉子**：`CONFIG_DEFAULTS` 与 `cordis.patch.yml` 不得静默漂移；`resolveAuthOverrides` 只认顶层键、**嵌套 `auth:` 块必须抛错**；`hostName` / `isAdmitted` 的白名单形态（含裸 IPv6）；不依赖 peer，干净检出即可跑 |
| `test/package.test.mjs` | **打包清单 + 门禁名册双钉子**：从 `main`/`exports` 走静态 import 闭包，可达模块必须在 `files` 里（曾漏 5 个 → tarball 加载即崩）；反向钉住"`files` 里却无人引用"的死重；**钉住「磁盘上的 `*.test.mjs` ↔ `npm test` 链 ↔ CI 离线 job」三处一致**，并额外钉住「联网档必须是裸 `.mjs`（不带 `.test.` 后缀）」「`live-contract.mjs` 不进默认门禁」；不依赖 peer，干净检出即可跑 |
| `test/docs.test.mjs` | **文档一致性钉子**：内部链接全部可解析、同一张表格不出现在 ≥2 个文件（防多源事实）、根 `README.md` 行数上限、`DSH-PLUGIN.md` 教学快照与 `package.json` 同步、**`API.md` 快照示例与契约键集一致**、README 覆盖每一个 tab、自述的 UI 位置与 client 槽位注册一致、`screenshots.json` 指到的图真实存在、**考古纪律**（现行正文禁「修订（日期）」式内联补丁，`docs/ADR.md` 账本形状受检）、**peer 静态边界**（静态 `@deepseek-ai/*` import 只许两个 llm adapter 壳——「内核 peer-free 才能缺席降级」承诺的静态面）、**活文档计数护栏**（现行文档不得写死会随代码漂移的模块数/规模/行数，历史·账本·研究档豁免）；不依赖 peer，干净检出即可跑。**扫描面纪律**：`collectMd` 统一排除 `upstream/`、`.git/`、`node_modules/`、`AGNES-API-docs/` 与 **`tmp/`**，判据是「**凡是 gitignored 的目录，都不该进任何活文档一致性检查的扫描面**」。`tmp/` 是纪律允许的探针/草稿落点（见 `PITFALLS.md` §10），它曾只在 `COUNT_GUARD` 内部被逐条豁免、其余检查仍受审——于是一份**不进版本库的草稿**能让全量门禁判红。现已收敛到 `SKIP_DIRS` 一处，**别再往单个检查里加局部豁免**（那正是这次扫描面不一致的来由） |
| `test/contract.test.mjs` | **Agnes 推理契约回归（离线档）**：`test/baselines/agnes-contract.json` 驱动 `llm-models.ts` 的 `toPiDescriptor` / `isChatModel` / `buildDescriptors` / `rosterWithAvailability` / `thinkingLevelMapFor` / `supportedThinkingLevels` 与 `parsers.ts` 的归一、`llm-retry.ts` 的 429/quota 分类。基线里每格是**三值**：`true` = 必须提供、`false` = 必须不提供、`"pending"` = **按未证实处理、与 `false` 同等关闭**；红 = 代码偏离冻结契约，修法走 `AGNES-API.md` §7 + 基线刷新 |
| `test/retry.test.mjs` | **429 自愈逻辑层（peer-free）**：`buildRetryPolicyConfig` 形状（排除 QUOTA/ACCOUNT_QUOTA、保留 RATE_LIMIT）、**`blockedIds` 是传进来的数组**（不再从 pool 派生）、`buildDescriptors` 排除借尽模型、`rosterWithAvailability` 标记；peer 可达时追加断言 `resolveRetryPolicy` 的解析结果 |
| `test/draw.test.mjs` | **出图模块（peer-free，如 `provider.test.mjs`）**：端点拼接（`apiBase` 各种写法归一）、模态判定（声明优先、名字兜底、`isChatModel` 方向统一）、挑选优先级、wire body 钳制、响应解析、失败分诊（429 配额 vs 限频）、`drawOnce` 对假 fetch（成功/分类失败/超时）、失败冷却门、`defineDrawTool` 用直通 `defineTool` + 假 store 端到端 |
| `test/video.test.mjs` | **视频模块（peer-free）**：与出图同构，**异步任务制**——建任务 + 轮询状态机。端点构造（含 `/v1` 剥除）、帧数/帧率规则、`8n+1`、V2.0/2.5 双家族分派（`pickVideoModel` 认全量视频模型，自动 V2.0 优先、无 V2.0 回落 2.5；面板偏好可指 2.5）、`buildVideoBody`（V2.0，非法显式值**抛错**而非夹取）与 `buildVideoBody25`（秒数制：`seconds` 4–12 整数、`size` 白名单 + flash 收敛 720P、`aspect_ratio` 白名单/就近匹配、`image`/`keyframes` → `mode`/media、flash reference ≤5、`negative_prompt` 不转发）、建任务/查询解析（含 `metadata.url` 两层兼容、`progress:0` 保持）、失败分诊、轮询状态机（含非前进时钟的 `VIDEO_MAX_POLLS` 防呆）、`defineVideoTool` 端到端（每调用现取 Key、按模型家族分派请求体） |
| `test/doctor.test.mjs` | `tools/doctor.mjs` 的只读诊断：干净机器、provider/draw/video 三种开关状态与各自的 model 偏好、跨 profile 读各自的私有状态文件、损坏/外来版本文件被点名而非静默丢弃、机器级 AgnesCode 存储盘点（drift 点名、健康噤声、未知平台如实跳过；只看文件名，绝不读内容） |
| `test/switch-store.test.mjs` | **四个 opt-in 开关商店的同一份行为清单**（provider / draw / video / AgnesCode）：未触碰即未设置、save/forget 往返与形状版本、损坏与外来版本读未设置、**模型偏好与开关互不牵连**（forget 开关不清偏好）、§23 一次性继承（含「继承后重开 Host 仍读得到」）、两 profile 互不覆盖。四者**逐项跑同一组断言**，所以「三份修了、第四份没修」会红而不是静默 |
| `test/switch-precedence.test.mjs` | **「面板值 > 配置默认」这一条优先级的唯一裁决处**：它曾被手抄在 11 处、且有两种长得几乎一样的方言——有默认（`panel ?? settings.x`）与无默认（`panel === true`，AgnesCode 专用，它根本没有配置默认，未设置必须落到 `off` 而非某个凭空认的默认）。本套件钉住**两种语义的分界**，并顺带锁死四件被这次收敛暴露的真实缺陷：① `??` 与 `===` 优先级误读（`panelValue ?? x === true` 实际是 `panelValue ?? (x === true)`，看似对的写法诱导错误编辑）；② `snapshot` 里值与来源各读一次、中间一翻就 `true` 标成 `config`；③ 缺席的 store 上对 `null` 调 `.catch` 抛 `TypeError` 而非回答 `null`；④ 把 B 型误写成 A 型会让 AgnesCode 在补丁多出默认值的那天自己注册起来。任何一处仍自己拼装优先级、或 AgnesCode 三处传了配置默认，即红 |
| `test/admission-audit.test.mjs` | 同源闸审计：放行结论与 `isAdmitted` 逐位相同；「放行 + 无 Origin + 会改状态」留痕，带匹配 Origin 的写 / 被拒的写 / 同站 GET 都不留痕；落盘不含任何头值；写路由接审计版闸、只读 `snapshot` 走原闸（新增写路由接错会红） |
| `test/agnescode.test.mjs` | 桌面端上游（AgnesCode）：BFF base 钉域、os_crypt 解密与 Local State 密钥解封（AES-GCM 真轮转 + 注入 DPAPI）、采集步进的逐文件分诊全 9 档（file_missing / format_drift / unreadable / malformed / no_key / decrypt_failed / no_token / untrusted_base / unsupported_platform）+ 格式漂移分类与 doctor 盘点的离线档 + tier↔i18n 双语跨层钉 + catalog/balance 的 URL 精确断言 + 钉域拒非默认端口、订阅池余额解析、逐账号 base 进描述符与签名、独立 publisher 三门、store 拒绝无 base 保存、客户端面花名册（会员徽标） |
| `test/wiring.test.mjs` | **真实 Cordis 容器**里的装配：`inject` 解析、服务注册、路由挂载与卸载、配置错误；推理侧的可选 `ctx.get("llm")` 注册对（`registerAdapter` + `registerConfigurableProviders`，id `agnes-token-plan`）、opt-in 关闭不注册、fiber dispose 释放注册对与全部路由 |
| `test/error-fix.test.mjs` | `llm-error-fix` 对 429 误判的纠正（peer 的 `isQuotaExceededError` 把带额度措辞的限频 429 抢判成 `QUOTA`，本层在出流前纠正回 `RATE_LIMIT`）；末段钉这层补丁的**离线删除闹钟**（peer 下界 + 删除面） |
| `test/peer-contract.test.mjs` | 与真 peer 包（pi-ai / dsh-llm*）的契约：可达时逐值比对，不可达时 SKIP；§E 退出证执行 peer 未导出的 `classifyPiAiError` 判定"补丁是否已退化"（打印 `EXIT-PROBE:` 行） |
| `test/live-contract.mjs` | （仅 `test:live:contract`）重放 `test/baselines/agnes-contract.json` 对 Agnes 推理端点：`/v1/models` 目录核对 + 少量 `reasoning_effort` 探针（限流友好，每格 1 请求不重试）；红 = 平台方言漂移，**不是回归**，修法走 `AGNES-API.md` §7 注释层。**它必须是裸 `.mjs`**（不带 `.test.` 后缀），否则会被扫进默认门禁 |

不碰真实账号的保证：网络层打桩，`routes.test.mjs` 用真实响应形状但全 stub，`e2e.mjs` 指向本机假平台。

---

## 3. `panel-decision.js` / `client-surface.js` 为何特殊

面板的渲染决策与渲染组件**不是手写副本、也不是从源码抠字符串**：`client-surface.js` 装一个捕获型 `window.__ModuleLoader__`，导入真实的 `src/client/index.ts`，给它的工厂喂一个记录型 React 替身，拿到工厂物化出的 `panel` 测试面（`interpretSnapshot` / `viewOf` / `barPlan` / 字典 / 错误码表 / 样式令牌 / 组件），`panel-decision.js` 与 `panel-render.js` 再从这个真实对象上取用。若 client 的结构变了，检查跟着变——测的始终是浏览器真正跑的那段代码。

> 机制有两代：早期一版是手写 `panelDecision` 副本（会漂移，且漏了节流字段）；再一版是从 `client.js` 源码用平衡括号抠函数体、`new Function` 求值（锚点绑死源码排版）。现版把 client 物化成模块后两者都取代了。

---

## 4. 已知缺口与已知环境问题

文档比代码先过期也是一类缺陷，所以这里只保留仍然真实的条目：

- **`AccountForm` / `ModelPicker` 的渲染没有被测到。** 它们建立在 `useState`/`useEffect` 之上，React 替身只会无脑返回初值——测的会是那个假件。宁可留着缺口也不假装覆盖；表单的行为部分由 `store`/`routes` 套件在 Host 侧守住。`ModelPicker` 的**可测部分**已被拆出来守住：勾选行的 `ModelRoster`（不依赖 hook）由 `test/render.test.mjs` 覆盖，「勾选 → 允许清单」的推导（含空清单折叠与 `__hide_all__` 哨兵）由 `test/provider.test.mjs` 以面板与 Host 两侧逐值相等钉死。
- **本机的 `AGNES_*` 环境变量被测试隔离。** `index.ts` 在挂载时从 `process.env` 读 API key，一台真配了它的机器会走进套件从未打桩的分支（真去拉模型目录，并把一个非控制台 token 混进断言）。只在一台干净机器上绿、在作者机器上红的套件不叫离线，叫「通常离线」——`test/peer-roots.mjs` 的 `isolateHostEnv()` 负责这件事（`AGNES_TOKEN_PLAN_API_KEY` / `AGNES_USERNAME` / `AGNES_PASSWORD`）。
- **`credentialKey` 形状有双保险。** 它是 `index.ts` 一处照抄 `@deepseek-ai/dsh-credentials` 格式（`"scope/id"`）的 shim，为让测试不解析 peer 就能跑。`config.test.mjs` 在**任何机器**（含干净检出）钉死其字面形状，`store.test.mjs` 在 peer 可解析的机器上再断言与真实实现**逐值相等**——格式一变，无论是插件这侧手抖还是 peer 包升级改了分隔符，都会红。
- **路由测试用的是假 `response`，不是真实的 `http.ServerResponse`。** 它会计数写入次数（这是抓住「保存账号答了两次」的原因），但不会复现真实对象的 `ERR_HTTP_HEADERS_SENT`、`setHeader` 顺序与流语义。
- **端到端已进 `npm test` 门禁，但依赖 dsh CLI。** `test/e2e.mjs` 拉起**真 Host 进程**（`dsh web`）+ 一个 127.0.0.1 上的**假 Agnes 平台**（`test/fake-platform.mjs`，自带独立 `$DSH_HOME`、零真实凭据、全部端点重定向到本机），断言登录、四类额度窗口、累计用量、分桶柱图、套餐 uuid 匹配、provider 注册等端到端行为。`npm test` 末尾接 `test/e2e-gate.mjs`：探到 dsh CLI 就实跑（失败即红），探不到就打醒目 SKIP 并退出 0。缺 CLI 不是回归，但一次绿跑若跳过了端到端，装配路径就没被真正验过——`.github/workflows/ci.yml` 把它列为**独立的硬门禁 job**，并由 gate 自身发出一条 `VERDICT=PASSED` / `SKIPPED` / `FAILED` 判词写进 job summary，正是为了让「绿」与「跳过」不再同义（`live-contract` 才是真正的 best-effort，见 §2）。**它自己也开着 `registerProvider: true` 并断言 provider 真的注册上了**（含目录/vision/去密状态），同时把 `AGNES_TOKEN_PLAN_API_KEY` / `AGNES_USERNAME` / `AGNES_PASSWORD` 从子进程环境里删掉（PITFALLS §17）。
  - 假平台**真校验**两件事，而不是有问必答：三条控制台路由只接受它自己签发的那枚 token（否则 401 + 信封 `code:401`），`/api/usage/series` 会把收到的查询串记下来供断言（窗口必须是**日期**）。有问必答的假平台是 bug 直达用户的通道。
  - **令牌死亡没被 e2e 覆盖。** `freshJwt()` 的 `exp` 是登录时刻加一小时，整轮不到十秒；假平台也只拒绝它没签过的那枚 token，不模拟中途吊销。所以「401 → 失效 → 重取 → 重试恰好一次」这条自愈链只在 `token-store` 基线里以纯函数语义被验证过，没有一轮 e2e 走它。补它需要把令牌改成登录即刻过期、再把快照缓存等过去（`cacheSeconds` 下限 5 秒，公开套餐目录另有 300 秒地板），代价是套件时长翻倍；权衡后留作已知缺口。
  - **client 产物只做挂载冒烟，没有行为级验证。** `test/build-gate.mjs` 第 5 步真的把 `client.js` 当 ESM 导入、注册并物化工厂，再跑几条真实决策断言（`interpretSnapshot`、`viewOf`、双语字典、组件表）——但那只是冒烟。面板的**决策**与**渲染组件**的完整行为由 `panel.test.mjs` / `render.test.mjs` 经捕获型 loader 导入真实的 `src/client/` **源码**验证，而不是这份产物；源码与产物由同一个 `clientFactory` 生成，所以逻辑一致，但「源码逻辑正确」并不等于「产物在浏览器里能跑起来」。e2e 也不兜这个：它的调用方是一个读 JSON 的 `fetch`，不是浏览器，从不取 `/`、也不取 `client.js`，所以产物在挂载时崩溃，Host 仍会照常答 200、照常返回正确 JSON，e2e 依然全绿。这条缺口与本节首条的 `AccountForm` / `ModelPicker` 同属一类、且位置更靠外。
  - **本机环境注记**：`e2e.mjs` 的 `cliRuntimeModules()` 用 `npm root -g` 找 CLI 的安装树来共享运行时包。若 `dsh` 装在系统 npm 的前缀（`%APPDATA%\npm`）而 PATH 上的 `npm` 来自另一个 Node 发行版，这里会找不到树、真 Host 起不来（表现为 154 个宿主插件 import 失败）。显式对齐前缀即可：
    ```powershell
    $env:npm_config_prefix="$env:APPDATA\npm"; node test/e2e.mjs
    ```

---

## 5. 行为冻结基线（`store-baseline.test.mjs`）

`token-store.js` 计划拆成登录 / 重登 / 节流 / 迁移四块，但四块共享闭包状态、迁移挂在读路径上，纯搬文件极易静默改掉细语义。`store.test.mjs` 的手写 check 只断言「作者想到的语义」；`store-baseline.test.mjs` 把 store 的**完整可观察面**冻结在 `test/baselines/token-store-behavior.json`：15 个场景、42 帧，每帧记录凭据服务调用序列（read/modify/delete/resolve/set/unset）、节流存储读视图、grant/ref 落盘内容、抛出的 `{code,message}` 与完整 `state()` 对象。

- **驱动方式**：只走公开 API（`getToken`/`invalidate`/`saveAccount`/`forgetAccount`/`state`），注入脚本化 `auth`、内存凭据服务、共享内存节流存储（第二个 store 实例模拟「重启」）、虚拟时钟；无网络、无 peer、无墙钟，干净检出可跑。
- **已钉死的阴沟语义**：`not_configured` 绝不写节流；parked 跨重启零新登录；本地退避 60s→120s 翻倍且关窗后 attempt 保留；平台声明的 2h 窗口不被 30 分钟本地帽截断；并发轮询单飞（恰好一次 refresh）；compare-and-set 慢者赢（并发旋转的 grant 不被覆盖）；`refresh_rejected` / `no_refresh_token` 两条都落到重登，且**无账号时回收 grant**而不是留着孤儿对；被拒令牌不复播；旧命名空间 grant/节流一次性收养（节流只收养第一条、第二条等 `clearThrottle` 扫）；密码不落盘（`autoRecoverArmed` 只报布尔）；无凭据服务降级并标记 `ephemeral`。
- **门禁纪律**：拆分后该套件必须零漂移。有意改动 store 行为时，先逐帧评审、再显式重生成，并在提交信息写明原因：

  ```powershell
  $env:UPDATE_BASELINE='1'; node test/store-baseline.test.mjs; Remove-Item Env:UPDATE_BASELINE
  ```

  重生成不是「让测试变绿」的手段。套件与基线同进 `npm test` 链与 CI 离线 job（三方名册由 `package.test.mjs` 钉住）。
