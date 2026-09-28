# 更新日志（Changelog）

本文件只记**公开行为变化**（新增能力、破坏性改动、重要修复）。实现细节、重构与测试加固请直接看 `git log`。

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
