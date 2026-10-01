# 参照件索引（References）

本文件是仓库根 `upstream/` **容器**的唯一权威索引与纪律。`upstream/` 整个目录被 `.gitignore` 的 `/upstream/` 忽略：**永不进本仓库历史、不进 npm 包**，绝不 `git add upstream/`。

它容纳的不是「一个上游应用」，而是两类东西：**独立 git 仓库**（各占一个用仓库原名命名的子目录，浅克隆、自带 `.git` 与 remote，可各自 `git pull`）与**本机快照**（如桌面端 `app.asar` 解包，非 git）。要查某个子目录的来源，优先看它自己的 `README`；本文件只登记**承重件**——即那些一旦丢失、会让某条实现线「凭记忆猜事实」的参照。

---

## 1. AgnesCode 线（承重）

| 参照件（`upstream/` 下） | 形态 | 来源 | 版本 / HEAD | 许可 | 承重在哪 |
|---|---|---|---|---|---|
| `AgnesCodeReverseEngineering/` | git 仓库 | `vibe-coding-labs/AgnesCodeReverseEngineering` | `9a5705f`（2026-08-03） | Apache-2.0 | 12 份协议文档（认证授权、OAuth+DeepLink、ACP WebSocket、BFF API、agnesd 本地 HTTP、AI Providers、IPC）+ 5 个 Python 脚本（`agnes_sdk.py` / `exchange_token.py` / `acp_proxy.py` …）；ROADMAP §6.3 的事实来源之一 |
| `AgnesCode2Api/` | git 仓库 | `vibe-coding-labs/AgnesCode2Api` | `6d5228b`（2026-08-04） | Apache-2.0 | Go 协议翻译代理（AgnesCode → Anthropic/OpenAI）；`pkg/auth/credentials.go` 是 macOS `state.vscdb` 采集路径的出处 |
| `AgnesCode/` | git 仓库 | `AgnesAI-Labs/AgnesCode` | `7e6bc45`（2026-07-13） | 未标注 | **官方** release 与反馈中心，**不含源码**；桌面端安装包在它的 Releases 里 |
| `AgnesCode-desktop-1.0.68/` | 本机快照（非 git） | 本机安装的桌面端 `app.asar` 解包 | `1.0.68`（buildNumber 8） | 闭源第三方 | 全部 BFF 调用的真实出处（`.vite/renderer/.../App-*.js`）。**比线上逆向件（基于 1.0.17）新两个多月**——引用其事实前先在这里复核版本漂移 |
| `agnescode-cli/` | git 仓库 | `ViviQuan/agnescode` | `c587e85`（2026-09-30） | MIT | 终端原生 coding agent，内置 Agnes AI provider（TypeScript） |
| `agnescodex/` | git 仓库 | `minchieh-fay/agnescodex` | `aa803ed`（2026-07-07） | Apache-2.0 | 把 Agnes API 接到 Codex 的适配件，作协议对照 |

`agnescode-cli/` 的目录名与官方 `AgnesCode/` 在大小写不敏感的文件系统（Windows）上不能同名并排，故加 `-cli` 后缀。

## 2. 同一供应商的其他参照（非 AgnesCode 线）

- `AgnesAI-Models/`——**官方**网关与模型目录（`AgnesAI-Labs/AgnesAI-Models`），「接入 API」与出图两条线的接口形状出处。
- `AgnesAI-Labs-skills/`——**官方**模型集成 Skills（`AgnesAI-Labs/skills`：text / image / video / agent）。
- 其余为社区实现（`agnes-ai-skill`、`agnes-video-generator`、`ComfyUI-Agnes-AI-All`、`dsh-agnes*` 等）与四个**裸目录**（无 `.git`，上游 zip 解包：`agnes-ai-for-dsh`、`deepseek-harness-codearts-master`、`dsh-connect-workbuddy-main`、`dsh-draw-router`），与插件主线关系弱，保留为历史对照。本机 `upstream/SOURCES.md` 有全量机械清单。

## 3. 纪律

- **只吸收事实，不复制代码。** 对这些参照件的用法一律是「读出协议事实 → 用自有的 Node/TypeScript 实现重写」。参考件多为「个人学习与技术研究」定位，其作者明确禁止商业转售与中转服务——本插件不做这两件事，也**不 vendor 任何源码**。
- **绝不 `git add upstream/`**，也不把参照件里的明文凭据文件（如 `accounts.json`）带进版本库。桌面端快照的 `node_modules` 里 10 个 `.pdb` 调试符号约占 60M+ 死重，可随时删。
- **凭据的边界不变**：参照件只提供「凭据存在哪、怎么解」的事实；解出的 token / 密码永不落盘、不进日志，见 [CONTRIBUTING.md](./CONTRIBUTING.md) 与 [PITFALLS.md](./PITFALLS.md)。
- **版本漂移优先于文档结论。** 任何参照件的事实都带「它当时看的是哪个版本」；线上逆向文档基于 1.0.17，而本机快照已是 1.0.68——冲突时以**本机快照 + 带凭据的实测**为准。

## 4. 维护

```bash
cd upstream/<子目录> && git pull      # git 仓库：浅克隆（--depth 1），要历史先 git fetch --unshallow
```

新增参照件时：在 `upstream/` 下并排加**同名目录**（`/upstream/` 规则已覆盖，无需改 `.gitignore`），并在本文件登记来源、版本与「承重在哪」；只做本机对照、与主线无关的，登记到机械清单即可（见根目录 [AGENTS.md](../AGENTS.md) 与 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)）。
