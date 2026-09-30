# 更新日志（Changelog）

本文件只记**公开行为变化**（新增能力、破坏性改动、重要修复）。实现细节、重构与测试加固请直接看 `git log`。

## [Unreleased]

### 可见性修复三连：登录态常显 + provider 注册 pending 态 + 小浣熊错误不再被开关藏起

同族问题——「状态翻成某个值后，操作入口/错误行跟着消失，用户拿不到重入路」：

- **登录态与账号编辑器无条件可见**（中间态不再是死路）：此前「连接商汤控制台」区卡只在 `hasAccount || needsAccount` 时出现——中间态（已点过「清除账号」、grant 仍在静默续期）下整卡消失，要等 refresh_token 彻底失效才重新拿到重输入口。现改为**只要快照携带 auth 块就常显**，积分额度页底部永远有该卡（默认折叠、一键展开）：随时可核对登录态、重输账号改指仍有效的 grant、或再清一次账号。头部「需要重新登录」chip 的 tooltip 在 Host 没给 reason 时回落 guidance 文案，不再留空白。
- **provider 注册 pending 态**：开关已开、服务在、无 error，但注册没落地时，原文案谎报「未注册——勾选上方开关」（指向已勾选的开关）；新增 `llm.registeredPending` 直说 pending。同时修分支序：具体失败（providerError）优先于能力缺失（noService），两者同时成立时不再吞错误。
- **小浣熊 tab 注册状态行不再被开关门控**：providerError 原来只在 `enabled === true` 时渲染，开关一关报错就消失；现 `state !== null` 即渲染，失败行与开关解耦。
- **构建修复**：`qr.ts` 内 8 处 `x?.y = v`（可选链左值赋值）是解析错误，tsdown 直接挂掉——改为先索引后赋值。
- **测试**：`test/panel.test.mjs` B2 组翻转（中间态/死 grant 态都钉 `canManageAccount === true`）；`panel-decision.js` 镜像同步去门控；`render.test.mjs` 新增 pending 态与 error 优先序 2 项 pin。

### 运维诊断 doctor（PITFALLS §22 的欠账）

回答「这台机器的 provider / 出图开关到底开没开」——此前唯一答案在一个 JSON 状态文件里，不在任何配置文件、任何路由、任何 CLI。

- **新增 `src/host/doctor.ts`（peer-free 纯读层）+ `tools/doctor.mjs` CLI**：读 `$DSH_HOME/state/<name>/` 与每个 `<profile>/<name>/` 下的 `provider.json` / `draw.json` / `catalog.json`，报「面板保存值 > 部署默认值」的生效开关、模型允许清单、以及「文件存在但读不成」时**点名**是哪个文件（损坏/外来版本不会静默变空）。`npm run doctor`（人读）/ `npm run doctor:json`（机器读）。
- 与「大统一」定位对齐：单点入口必须可查，doctor 是第一条查询通道；它不写任何文件、不碰凭据，只在磁盘上读，Host 没起也能跑。
- **测试**：`test/doctor.test.mjs`（23 项，离线门禁）——三套 payload 解析器的「损坏/外来版本读作未设」方向、profile 分段与 shared 布局互不误认、干净机器/损坏文件的人读文案；进 `npm test` 与 CI offline 档。

### 文档修正：撤销 ROADMAP §0 被证伪的前提

- [ROADMAP.md](docs/ROADMAP.md) §0 与 §2 引言原写「本插件已是双 profile 的 `agent-default-model`——即这台机器的**默认推理通道**，故障域已升级为推理可用性」。该论断 2026-09-29 已被 [IMPROVEMENTS.md](docs/IMPROVEMENTS.md) §1.2 撤销（`agent-default-model` 是宿主的选择记录服务，原引用不可复现），但 ROADMAP 未同步。现改为「**能力事实**：可注册 provider `sensenova-token-plan`；是否默认通道由 profile 与用户模型选择决定；一旦某 profile 选它作默认，故障域才从面板升级为推理可用性（条件性爆炸半径）」。两份文档不再正面矛盾。

### 仓库结构规范化：src/ 全源码，lib/ 纯产物

- 全部源码收敛到 `src/`（`src/host/*.ts` 27 个 Host 模块 + `src/client/*.ts` Client 半边）；`lib/` 与根 `client.js` 降为纯构建产物并加入 `.gitignore`——删掉后 `npm run build` 一条命令从源码完整重建。
- 对外行为无变化：`main`/`exports` 指向不变（`./lib/index.js`、`./client: ./client.js`），`files` 白名单同步，`npm publish` 经 `prepack` 自动构建；`exports` 收敛为 `.` 与 `./client` 两个子路径。

### 出图工具面板开关（drawEnabled）

与 provider 开关同机制的「面板开关 + 立即生效」，出图吸收（§5.4 接法 B）不再需要改配置重启：

- **面板新增「出图工具」卡片**（`client.js` 的 `DrawSwitch` 控件）：勾选保存后写入插件私有状态文件 `$DSH_HOME/state/<plugin>/draw.json`，与 `provider-store.js` 走完全相同的完整性纪律。优先级：面板保存值 > `cordis.patch.yml` 的 `drawEnabled`；从未动过面板的部署，行为与 `false` 一致。
- **新增 `POST /api/<name>/draw` 路由**（`routes.js`）：与 `/provider` 同一信任形状（同源围栏 + 4 KB body 上限），`{ enabled: true|false }` 或 `{ forget: true }`。
- **快照 `llm.drawEnabled` / `llm.drawSource`**：`snapshot-aggregate.js` 在 llm 块里回显出图开关的生效值与来源，面板无需单独调 `/draw` 就能读到当前状态。
- **`lifecycle.js` 的 `registerDrawTool` 改读生效值**：不再直接读 `settings.drawEnabled`，而是「面板保存值 ?? 配置默认值」。工具的实际挂载/缺席发生在**下一个 Host 启动**时（agent tools 没有 unregister 语义），开关值本身是立即生效的。
- **测试**：`test/provider.test.mjs` 新增 draw-store 纯逻辑组（归一、读写、版本拒绝、损坏忽略、forget）；`test/routes.test.mjs` 新增 R 组（8 项，覆盖 GET/POST/forget/跨域围栏/跨 remount 持久化/配置回退）；`test/wiring.test.mjs` 路由计数从 5 更新为 6。

### 面板视觉打磨

几处「不报错、但会误导或压平层级」的显示。

- **每模型消耗柱状图补图例**：柱子按「最高消耗者」归一化，top 模型永远填满轨道——它回答的是「谁在烧积分」，但满格会被误读成「这个模型快触顶」。卡片底部补一行说明「柱长按最高消耗相对显示，非占总额度比例」，图表不再靠省略说谎。
- **返赠余额从药丸改为指标数字**：`返赠余额 327,904` 此前裹在与「通用池/专属池」同款的圆角药丸里，一个大数字被压成和静态类型标签同等权重的装饰。改为卡头右侧的 tabular 数字，读作可花余额指标。
- **注册成功不再常驻绿色**：「已向 DSH 注册提供方…」是静止常态，长期亮 `state-success-primary` 会让人误以为刚发生了好事。收敛为中性次要文字，绿色只留给「已保存」这类瞬时反馈。
- **去掉最内层子卡的冗余边框**：section 卡→池卡→双子窗三层等宽 `border-l1` 互相抵消、压平层级。最内层子窗改为纯靠更深的背景面（layer-2）浮起，边框只留两层。
- **API Key 字段标题去重**：「模型接入（API Key）」区块头与卡内输入框标签原本同名重复，标签改为「API Key」。

## [0.4.1] — 2026-09-29

面板前端修复：几处「看起来对、实际错」的显示，加两处让操作直接失效的 bug。

- **每周额度重置时间误显示为当天**：5 小时与每周两个窗口共用同一个时间格式化器，而它只吐 `HH:MM`——每周窗口的 `reset_at` 是几天后的绝对时刻，日期被吞掉，读作「重置 18:10」，像是当天 18 点发生。新增 `when()`：今天保持紧凑 `HH:MM`，跨天带 `MM-DD`。返赠到期一直用的是 `clockLong`（带日期），只有重置时间漏了。
- **模型选择器「全选」会清空已选模型**：`ModelPicker.bulk` 把 `{id, name, vision}` 行数组传给只接受字符串的 `allowListFor`，`rosterIds` 过滤后恒为空 → 无论点「全选」还是「全不选」都返回 `[HIDE_ALL_MODELS]`，保存即清空模型列表。逻辑提成纯函数 `bulkModelsIn`，调用点显式转 id。
- **选择器单个模型无法勾选**：`ModelRoster` 的 checkbox 只有 `checked` 没有 `onChange`，实际只读——配合上一条，整块选择器不可用。
- **轮询竞态**：前一轮请求未返回时定时器又触发一轮，慢的那次会后发先至、覆盖新数据，用量条肉眼可见地往回跳。每次 `load` 递增 generation，过期响应直接丢弃，并用 `AbortController` 取消被取代的请求（不只是忽略结果）。后台标签停掉轮询，切回时立即刷新一次。
- **控制台不可读时给出可行动的文案**：`console_error` 一直被挡在登录表单之外（`FORM_EXCLUDED_CODES`），但 `GUIDANCE_BY_CODE` 没有这个键，用户只看到裸错误串、暗示永久故障——现在提示「通常下一次自动刷新即可恢复」。HTTP 401/403 不再只显 `读取失败：HTTP 401`，改为按令牌失效处理并保持登录表单可达。
- **暗色主题状态色静默失效**：三处主题变量前缀写成 `--dsh-alias-*`（不存在的变量名），「已耗尽」红标与「已保存」绿字失效；官方 UI 一律 `--dsw-alias-*`。
- **可访问性**：错误类 7 处 `role="alert"`、状态类 5 处 `role="status"`（此前屏幕阅读器听不到任何失败原因）；QuotaCard 的 `aria-valuenow` 与可见百分比统一为一位小数；模型搜索框补 `aria-label`；两处 tooltip 不再裸露 `{balance}` / `{selected}` 占位符。

## [0.4.0] — 2026-09-29

出图吸收（大统一 §5.4 接法 B）：本插件可以给 agent 提供商汤出图能力了。

- **新增 agent 工具 `sensenova_draw_image`**（opt-in，配置 `drawEnabled: false` 默认关）：POST `{apiBase}/images/generations`，鉴权用面板「模型接入」保存的 `SENSENOVA_API_KEY` 引用（每次调用现取，轮换 Key 无需重启）。
- **出图模型识别用结构化字段，不用名字正则**：从 catalog 的 `output_modalities` 判定（与 chat 清单的排除逻辑互为反向，两份清单不可能矛盾）。社区同类 `dsh-draw-router` 的名字正则会漏掉 `sensenova-u1.5-lite`，本实现不会（对照见 `docs/ARCHITECTURE.md` §5.4）。
- **429 分诊与失败冷却**：出图失败时区分「配额不足（别盲重试）」与「限频（等再试）」；失败后 30s 冷却，防止 agent 在耗尽的共享池上打转。
- **修复 429 误判纠正（chat 路径）**：peer 的 `classifyPiAiError` 先跑 `isQuotaExceededError`，命中面过宽——商汤限频 429 体里带 `rate budget` / `credits` 字眼时会被抢判成 `QUOTA`，导致本应退避重试的限频被按"配额耗尽"快速失败、且模型被面板静默下线（呈现"额度已用尽"）。新增 `llm-error-fix.js`：在 `llm-adapter.js` 用 Proxy 包裹 `PiAiAdapter` 的流出口，把这类"误判的限频 QUOTA"在出流前纠正回 `RATE_LIMIT`（保留原 message），真配额耗尽与已限频原样放行。`test/error-fix.test.mjs`（24 项，peer-free）覆盖。详见 ROADMAP §3 的纠偏注记。
- **降级同型**：无 tools 服务的 Host、peer 加载失败、注册被拒——工具静默缺席，面板与 provider 不受影响；快照契约零改动（14 键不变）。
- 配套：`drawModelId`（首选模型）与 `drawTimeoutMs`（默认 120s）两个配置；`test/draw.test.mjs`（56 项，peer-free）。

## [0.3.4] — 2026-09-29

429 自愈与「清单自带识别」：Token Plan 池额度耗尽时，模型不再发出必失败的请求。

- **provider 级重试策略**（`llm-retry.js` → `resolveRetryPolicy` 显式配置）：配额耗尽（`QUOTA`/`ACCOUNT_QUOTA`）**不重试、快速失败**；限频（`RATE_LIMIT`）按退避重试。候选路由在共享额度池上空转只会延长冷却窗口，故刻意不对配额做重试（对应上文「不做多 Key 池」）。
- **清单自带识别**：某模型所属额度池耗尽（`remaining <= 0`）时，该模型从 DSH 模型选择器移除（不再发出必 429 的请求）；面板花名册则**保留**该模型并以 `available:false` / `quotaExhausted:true` 标记、灰色显示原因，用户可知「为什么这个模型不见了」。
- **额度跨越零点自动重注册**：快照用 `quotaSignature` 去抖，仅在额度状态变化时才触发一次 `publishProvider` 重建（受 `PiAiAdapter` 对 profiles Map 引用记忆化约束，这是唯一生效路径），无需重启 Host。
- **快照 `llm` 块新增** `quotaBlockedModelIds`；`models` 每行新增 `available` / `quotaExhausted` 字段，供面板渲染。

## [0.3.3] — 2026-09-29

**安全姿态收紧：控制台密码不再落盘**（破坏性改动——老用户升级后需重新登录一次的情况见下）。

- **密码默认不写入任何文件**：此前 `saveAccount` 会把面板输入的密码原样存进 DSH 凭据服务（`~/.dsh/.credentials.yaml`，owner-only 的明文 YAML）。本版改为只保存**账号 + access/refresh token**；密码仅在登录瞬间于内存中使用，用完即弃。
- **`SENSENOVA_PASSWORD` 环境变量是密码唯一的持久来源**（显式 opt-in）：放在环境里，refresh_token 失效后可自动重登，与旧行为一致；不放，则 refresh 失效时面板要求重新输入一次（README「登录失败怎么办」早已承诺此路径）。
- **旧版残留自动清除**：凭据服务里已存的 `SENSENOVA_PASSWORD` 引用在首次接触时被移除（一次性清扫），明文密码不会继续留在磁盘上。
- 行为影响：**升级后若当前 refresh_token 仍有效，完全无感**（续期照常）；仅在 refresh_token 已失效、且依赖"密码存在凭据服务里自动重登"的场景下，会多一次手动输入。
- `state().hasAccount` 语义微调：现在按"已保存的账号名"判定（不再要求密码可用），面板的「清除账号」入口在密码缺失时仍然可用。

## [0.3.2] — 2026-09-29

面板新增「模型允许清单」：可以**勾选具体哪些模型推送进 DSH 的模型列表**，不再只能全推或全不推。

- **面板新增模型选择器**（「模型接入（API Key）」区）：列出本 Key 目录下每个模型（带名称与可看图标记），逐条勾选；支持搜索过滤、可见项全选/全取消、实时计数，编辑先落草稿，点保存才写入。
- **新增路由** `POST /api/<name>/models`（同源围栏 + body 上限 + 500 项上限，与账号/api-key/provider 路由同一信任形状）：`POST { enabledModelIds: string[] }` 替换允许清单，**同一请求内**重新发布 provider，面板不用等下一次轮询。设计理由见 [docs/PROVIDER-HOT-RELOAD.md](docs/PROVIDER-HOT-RELOAD.md) §6。
- **清单语义**：`[]` = 不过滤，全部推送；非空 = 严格允许清单，只推列出的模型；`["__hide_all__"]` = 一个都不推送（表达「临时全部收起」，空数组已表示「未筛选」，需要独立写法）。
- **快照 `llm` 块新增两个字段**：`models`（整份可选目录：`id` / `name` / `vision`，**不受**过滤影响，面板据此画可勾选项）、`enabledModelIds`（当前生效的允许清单）。
- **`modelCount` / `visionCount` 改为按清单过滤后计数**——它们描述的是「实际注册了多少」，而不是目录有多大。0.3.1 及以前清单恒为空，数值不变。
- 清单存在与 catalog 同一份私有状态文件 `state/<name>/catalog.json` 的 `enabledModelIds` 字段（版本与原子写纪律不变），重启即恢复。
- `POST /api/<name>/api-key` 的 `forget` 语义不变，但它会连带清掉勾选记录：换一个 Key 就是一份新的、未勾选的目录。
- 补记：`package.json` 的 `version` 在 0.3.1 时漏改（一直是 0.3.0），本次一并补齐到 0.3.2。

## [0.3.1] — 2026-09-28

提供方注册开关热生效（[docs/PROVIDER-HOT-RELOAD.md](docs/PROVIDER-HOT-RELOAD.md)）：

- **面板新增真开关**：「模型接入（API Key）」区可直接勾选「向 DSH 注册 SenseNova 提供方」，保存到插件私有状态文件并在**同一请求内**重新发布 provider——立即生效，无需改配置、无需重启 Host。
- **新增路由** `GET/POST /api/<name>/provider`（同源围栏 + body 上限，与账号/api-key 路由同一信任形状）：`POST { enabled: boolean }` 切换开关，GET 回显生效值、来源与注册状态。
- **优先级**：面板保存过的值 > `cordis.patch.yml` 的 `registerProvider`（后者降级为部署默认）。未触碰面板的部署行为与 0.3.0 完全一致。
- **快照 `llm` 块新增 `registerSource`**（`"panel"` / `"config"`）；`registerProvider` 改为回显生效值。
- 开关状态存 `state/<name>/provider.json`（新模块 `provider-store.js`，版本化 + 原子写 + 损坏即读作未设置，与 `catalog-store`/`throttle-store` 同一完整性纪律）。

## [0.3.0] — 2026-09-28

第三步「一条龙」：本插件可**直接注册 SenseNova LLM provider**，不再需要手写 `llm-pi-ai` patch 行（opt-in，默认关闭）。

- **面板新增「模型接入（API Key）」区**：粘贴 `sk-` Key 即保存为 DSH 凭据服务引用 `SENSENOVA_API_KEY`（与手写 provider 读取同一引用名），支持显示/隐藏、保存、清除；环境变量 `SENSENOVA_API_KEY` 仍作兜底，清除面板引用不会动环境变量；任何接口响应只回「有无/来源」去密状态，不回显 Key。
- **新增配置 `registerProvider`（默认 `false`）**：开启后 Host 以 provider id `sensenova-token-plan` 直连 `apiBase`（默认 `https://token.sensenova.cn/v1`）注册 OpenAI 兼容适配器（`ctx.llm.registerAdapter` + `registerConfigurableProviders`），模型列表由 `/v1/models` catalog 自动构建并广播刷新；vision 模型自动带图片输入，无需手填 `imageModelIds`。
- **catalog 与模型勾选清单存插件私有状态文件** `$DSH_HOME/state/<name>/catalog.json`（原子写、损坏即忽略），不写 dsh 配置；重启后、首次轮询前即凭缓存完成注册。
- **快照新增 `llm` 块**：`hasApiKey` / `keySource` / `ephemeral` / `registerProvider` / `llmAvailable` / `providerRegistered` / `providerId` / `modelCount` / `visionCount`（成功响应顶层键 13 → 14）。
- **新增路由** `GET/POST /api/<name>/api-key`（同源围栏 + 4 KB body 上限，与账号路由一致）。
- 无 `llm` 服务或 peer 加载失败时面板与额度轮询照常工作，provider 静默缺席并在快照里带进去密错误原因。
- **peer 解析**：`@earendil-works/pi-ai` / `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-llm-pi-ai` 进 `peerDependencies`。它们由 Host 发行，npm 装进 profile 的插件能顺着 `profiles/node_modules` 解析到；**开发期 symlink/junction 进 profile 的检出解析不到**（Node 会把链接解成 realpath），表现为面板一直说「provider 缺席」而离线套件全绿——修法与现象见 PITFALLS §16。
- e2e 现在会真开 `registerProvider` 并断言注册成功（含目录 / vision / 去密状态），并像离线套件一样从子进程环境里剥掉 `SENSENOVA_*`（PITFALLS §17）。
- Host 侧改动需**完全退出 DSH（含托盘）后重启**生效。

## [0.2.0] — 2026-09-28

文档与合规加固（无对外行为变化，纯质量与一致性工作）：

- **文档职责归位**：根 `README.md` 从 ~243 行瘦身到 ~128 行，只留索引与快速上手；重复的「认证」章节、配置/节流/测试表格、文件表已删除或下沉。
  - `docs/SETUP.md`：新增「环境隔离（web 优先，桌面端后置）」说明与「常见信号与处置」表。
  - `docs/TESTING.md`：吸收原 README 独占的开发轶事（test:live 边界、读写隔离、凭据双钉、store 守卫），并补 `docs.test.mjs` 一行职责；测试套件说明由「九套件」更正为「十套件」。
  - `docs/DSH-PLUGIN.md`：移除写死的测试计数，教学快照 caveat 与 `files` 数组同步到真实 `package.json`。
  - `docs/ARCHITECTURE.md` / `docs/CONTRIBUTING.md`：把 host 外路径（`~/.dsh/profiles/desktop/cordis.patch.yml`）标注为「仓库外」，示例提交信息改为中文。
- **文档一致性门禁**（新增 `test/docs.test.mjs`，已纳入 `npm test` 十套件与 CI）：内部链接可解析、同一张表格不跨文件重复、根 README 行数上限、DSH-PLUGIN 教学快照与 `package.json` 同步、`API.md` 快照示例与声明契约键集一致。
- **许可证与第三方合规**：新增 `LICENSE`（MIT，Copyright (c) 2026 eghrhegpe）与 `THIRD_PARTY_NOTICES.md`（致谢 dsh-connect-qoder 文档范式、connect 家族设计对齐、上游接口参考实现）；二者进入 `files` 打包清单。
- **上游关系澄清**：各文档补 `shaobingtongzhi/sensenova-usage-dashboard` GitHub 参考链接；如实记录本地 `upstream/` 副本当前不含 `.git`（设计态为独立仓库，恢复命令见 `docs/ARCHITECTURE.md` §1）。
- **首次发布 npm**：`dsh-connect-sensenova-token-plan@0.2.0`（无 scope、公开）；`package.json` 移除 `private: true` 并补 `repository` 字段指回 GitHub 仓，市场列表可自动关联下载量。

## [0.1.x] 及之前 — 未发布

早期提交（最新见 `git log`，本机无 git tag）：实现 OIDC+PKCE 登录、密码 JWE 封包、`refresh_token` 静默续期、登录节流分类、双窗口（5h/7d）用量面板、趋势与返赠明细、视觉第二步 opt-in 写入本插件 settings。具体条目以提交历史为准，本文件不再补列。
