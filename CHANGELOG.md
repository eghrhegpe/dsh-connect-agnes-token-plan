# 更新日志（Changelog）

本文件只记**公开行为变化**（新增能力、破坏性改动、重要修复）。实现细节、重构与测试加固请直接看 `git log`。

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

## [0.1.x] 及之前 — 未发布

早期提交（最新见 `git log`，本机无 git tag）：实现 OIDC+PKCE 登录、密码 JWE 封包、`refresh_token` 静默续期、登录节流分类、双窗口（5h/7d）用量面板、趋势与返赠明细、视觉第二步 opt-in 写入本插件 settings。具体条目以提交历史为准，本文件不再补列。
