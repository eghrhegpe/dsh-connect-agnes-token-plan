# 第三方致谢与合规（Third-Party Notices）

## 致谢

- **文档范式**：参照本地 `~/.dsh/fork/dsh-connect-qoder` 的 README——「这是一个 DSH 插件、如何被加载、bundle 结构」的完整讲述方式（见 `docs/DSH-PLUGIN.md`）；
- **架构对齐**：provider settings 设计对齐 DSH connect 家族（`dsh-connect-trae` / `dsh-connect-workbuddy` / `llm-qoder`，`imageModelIds` 等见 `docs/ARCHITECTURE.md` §5.1）；
- **接口参考实现**：`upstream/`——[shaobingtongzhi/sensenova-usage-dashboard](https://github.com/shaobingtongzhi/sensenova-usage-dashboard)（Python 桌面工具），是 `.gitignore` 忽略、不随本仓库提交的本地容纳目录；本插件构建期与运行期均不依赖它、不进包，仅本地对照（见 `docs/ARCHITECTURE.md` §1）。其算法细节（登录 OIDC 流、密码 JWE 封包、用量接口解析）已被吸收进 `docs/SENSENOVA-API.md` 与本插件的 Node 实现。

以上均为**设计 / 文档 / 接口层面的参照，无代码复制**，不构成许可证约束下的再分发。

## 随包第三方依赖

`package.json` 的 `files` 打包清单（由 `test/package.test.mjs` 的 import 闭包检查钉住）**不包含任何第三方代码**：

- `peerDependencies`（`react`、`@deepseek-ai/dsh`、`@deepseek-ai/dsh-credentials`）由 DSH Host 运行时在运行期提供，不随本插件安装或打包（见 `docs/DSH-PLUGIN.md` §2）；测试基建 `test/peer-roots.mjs` 就地解析它们，不引入新依赖；
- `react` 为 MIT 许可；`@deepseek-ai/*` 属 DSH 运行时发行物，其许可证以 DSH 官方发行版为准；
- `LICENSE` 与本文随包携带，但均为本项目自身文档。

引入新的第三方外部依赖或复用其他项目代码时，请同步更新本文件并遵守对应许可证要求。

## 许可证

本项目采用 MIT 许可证，版权归属：Copyright (c) 2026 eghrhegpe。全文见 [LICENSE](./LICENSE)。