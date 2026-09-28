# 更新日志（Changelog）

本文件只记**公开行为变化**（新增能力、破坏性改动、重要修复）。实现细节、重构与测试加固请直接看 `git log`。

## [0.4.0] — 2026-09-29

出图吸收（大统一 §5.4 接法 B）：本插件可以给 agent 提供商汤出图能力了。

- **新增 agent 工具 `sensenova_draw_image`**（opt-in，配置 `drawEnabled: false` 默认关）：POST `{apiBase}/images/generations`，鉴权用面板「模型接入」保存的 `SENSENOVA_API_KEY` 引用（每次调用现取，轮换 Key 无需重启）。
- **出图模型识别用结构化字段，不用名字正则**：从 catalog 的 `output_modalities` 判定（与 chat 清单的排除逻辑互为反向，两份清单不可能矛盾）。社区同类 `dsh-draw-router` 的名字正则会漏掉 `sensenova-u1.5-lite`，本实现不会（对照见 `docs/ARCHITECTURE.md` §5.4）。
- **429 分诊与失败冷却**：出图失败时区分「配额不足（别盲重试）」与「限频（等再试）」；失败后 30s 冷却，防止 agent 在耗尽的共享池上打转。
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
