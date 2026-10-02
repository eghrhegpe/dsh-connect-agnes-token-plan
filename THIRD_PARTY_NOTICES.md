# 第三方致谢与合规（Third-Party Notices）

## 致谢

- **文档范式**：参照本地 `~/.dsh/fork/dsh-connect-qoder` 的 README——「这是一个 DSH 插件、如何被加载、bundle 结构」的完整讲述方式（见 `docs/DSH-PLUGIN.md`）；
- **架构对齐**：provider settings 设计对齐 DSH connect 家族（`dsh-connect-trae` / `dsh-connect-workbuddy` / `llm-qoder`，`imageModelIds` 等见 `docs/ARCHITECTURE.md` §5.1）；
- **接口参考实现（历史上的游）**：[shaobingtongzhi/sensenova-usage-dashboard](https://github.com/shaobingtongzhi/sensenova-usage-dashboard)（Python 桌面工具）——商汤时代的原始实现，其算法细节（登录 OIDC 流、密码 JWE 封包、用量接口解析）已吸收进本插件的 Node 实现。
- **AgnesCode 线的参照件**：`vibe-coding-labs/AgnesCode2Api`（Go 协议翻译代理）、`vibe-coding-labs/AgnesCodeReverseEngineering`（逆向协议文档 + Python 脚本，Apache-2.0）、`AgnesAI-Labs/AgnesCode`（官方 release / 反馈中心，不含源码）、`ViviQuan/agnescode`（终端 agent，MIT）、`minchieh-fay/agnescodex`、`AgnesAI-Labs/skills`（官方模型 Skills），外加本机安装的 AgnesCode 桌面端 `app.asar` 解包快照（闭源第三方，仅作本机对照证据）。
- 以上参照件全部落在 `.gitignore` 忽略、**不随本仓库提交**的本地容器 `upstream/` 里（清单与各自许可见 [REFERENCES.md](./docs/REFERENCES.md)，容器姿势见 `docs/ARCHITECTURE.md` §1）；本插件构建期与运行期均不依赖它们、不进包，仅本地对照。**对它们只吸收事实、不复制代码**，故不构成许可证约束下的再分发。

以上均为**设计 / 文档 / 接口层面的参照，无代码复制**，不构成许可证约束下的再分发。

## 参照对象及其被吸收部分（逐条说明）

| 参照对象 | 吸收的具体部分 | 在本插件中的对应实现 |
|---|---|---|
| `sensenova-usage-dashboard`（Python 桌面工具，商汤时代） | 登录流程的**失败分类**思路（区分「令牌过期」与「路径 404」与「平台拒绝」）；用量接口的**分桶聚合**算法（按日期桶求和而非按模型归并） | `agnes-auth.ts` 的 `classifyLoginFailure`；`parsers.ts` 的 `parseUsageSeries`（跨桶求和 + 按时间排序） |
| `dsh-connect-workbuddy-main`（DSH 家族同型插件） | 本机登录态采集的**架构范式**：读第三方 App 的加密会话文件（os_crypt / DPAPI + AES-GCM），provider 按会话文件跟随账号地址，`publisher`/`store`/凭据引用全部隔离 | `src/host/agnescode-*.ts` 整条 AgnesCode 线；`docs/ROADMAP.md` §6.3 的隔离裁定 |
| `dsh-connect-trae` / `llm-qoder`（DSH 家族同型插件） | provider settings 的**字段命名约定**（`imageModelIds`、`reasoningEffort`、`contextWindow` 等）与 opt-in 开关模式（默认关，失败降级为面板照常用、模块缺席） | `cordis.patch.yml` 的四开关商店；`src/host/switch-store.ts` |
| `vibe-coding-labs/AgnesCodeReverseEngineering`（逆向协议文档 + Python 脚本，Apache-2.0） | 12 份协议文档中的**认证授权**（DPAPI 解密流程、os_crypt 文件布局）、**BFF API**（端点路径与请求体形状）、**ACP WebSocket**（桌面端与后端的通信协议） | `agnescode-*.ts` 中桌面端会话采集与接口对接；`docs/AGNES-API.md` §1–§6 的 Agnes 控制台端点契约 |
| `vibe-coding-labs/AgnesCode2Api`（Go 协议翻译代理，Apache-2.0） | `pkg/auth/credentials.go` 的 **macOS `state.vscdb` 采集路径**（SQLite 表名、字段名、加密偏移量）——**未实现，仅登记为 fact** | `agnescode.ts` L440–445：macOS 分支目前直接返回 `UNSUPPORTED_PLATFORM`（"no verified harvest path yet"），`state.vscdb` 的事实记录在此备查 |
| `AgnesCode-desktop-1.0.68/`（本机 `app.asar` 快照，闭源第三方） | 全部 BFF 调用的**真实出处**（`.vite/renderer/.../App-*.js` 里的 fetch 路径与参数）；两个形状探针（`probe-agnescode-models.mjs` / `probe-agnescode-credits.mjs`）的原始输出 | `docs/AGNES-API.md` §4 的四窗口字段名；`docs/ROADMAP.md` §6.3.1 的积分端点契约 |
| `AgnesAI-Labs/AgnesAI-Models`（官方网关与模型目录） | 推理侧 `/v1/models` 的**接口形状**与模型 id 命名规则 | `src/host/llm-models.ts` 的 `LLM_PROVIDER_ID` 与 `modality.ts` 的名称兜底 |
| `AgnesAI-Labs/skills`（官方模型集成 Skills） | 出图 / 视频 / agent 三条线的**工具定义与参数约定** | `src/host/draw.ts`、`src/host/video.ts` 的请求体构造 |
| `AgnesCode/`（官方 release，不含源码） | 桌面端安装包版本线（确认本机快照与线上逆向件的版本漂移方向） | `docs/REFERENCES.md` §3 的「版本漂移优先于文档结论」纪律 |
| `wiki.agnes-ai.cn`（官方中文站文档，抓存于 `AGNES-API-docs/`） | RPM 限制表（§4.1）；订阅配额三档表（§4.1②）；429/402 错误码语义（§7.3.1）；出图 / 视频 V2.0 与 2.5 的参数体系（§7.5）；`agnes-3.0-flash` 等模型的上下文窗口声明（§7.1.2） | `llm-error-fix.ts` 的 429 纠正逻辑；`PROBED_CONTEXT_WINDOWS` / `PROBED_VISION` 硬编码表；`buildVideoBody` / `buildVideoBody25` 的校验规则 |
| `upstream/dsh-agnes*`（社区 Agnes 插件族） | 视频端点的两个常量（`AGNES_VIDEO_API_URL` / `AGNES_VIDEO_QUERY_URL`）；2.5 家族的校验约束（flash 仅 720P、reference ≤5、秒数 4–12） | `video-protocol.ts` 的 `buildVideoQueryEndpoint`（剥版本号段）；`video-protocol-25.ts` 的 `buildVideoBody25` 字段白名单 |

**边界说明**：以上所有参照仅用于「读出事实 → 用自有 TypeScript 实现重写」，**未 vendor 任何源码**。参照件多为「个人学习与技术研究」定位，其作者明确禁止商业转售与中转服务——本插件不做这两件事，也不随包分发任何参照件代码。

## 随包第三方依赖

`package.json` 的 `files` 打包清单（由 `test/package.test.mjs` 的 import 闭包检查钉住）**不包含任何第三方代码**：

- `peerDependencies`（`react`、`@deepseek-ai/dsh`、`@deepseek-ai/dsh-credentials`）由 DSH Host 运行时在运行期提供，不随本插件安装或打包（见 `docs/DSH-PLUGIN.md` §2）；测试基建 `test/peer-roots.mjs` 就地解析它们，不引入新依赖；
- `react` 为 MIT 许可；`@deepseek-ai/*` 属 DSH 运行时发行物，其许可证以 DSH 官方发行版为准；
- `LICENSE` 与本文随包携带，但均为本项目自身文档。

引入新的第三方外部依赖或复用其他项目代码时，请同步更新本文件并遵守对应许可证要求。

## 许可证

本项目采用 MIT 许可证，版权归属：Copyright (c) 2026 eghrhegpe。全文见 [LICENSE](./LICENSE)。