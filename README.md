# dsh-connect-sensenova-token-plan

DSH 侧边栏的商汤 Token Plan 积分面板：登录一次，实时查看积分余额、额度窗口与每模型消耗，令牌自动续期，之后无需再管。

## 功能

- **积分池**：每个池的 5 小时 / 每周两个额度窗口（已用 / 剩余 / 百分比 / 重置时间）、返赠余额与到期时间
- **模型清单**：套餐覆盖的模型里，哪些当前 API Key 真的能调、哪些还需要开通
- **每模型消耗**：近 N 小时各模型的积分消耗排名
- **可选接入**：把商汤模型（`sensenova-6.8-flash-lite`、`deepseek-v4-flash` 等）直接接进 DSH 对话，视觉模型自动识别

数据来自商汤控制台自己的 API，与网页控制台看到的一致。

## 安装

1. 在 DSH「插件」页搜索 `dsh-connect-sensenova-token-plan` 点击安装，或运行：

   ```powershell
   dsh plugin --profile web add dsh-connect-sensenova-token-plan       # Web 端
   dsh plugin --profile desktop add dsh-connect-sensenova-token-plan  # 桌面端
   ```

2. **完全退出 DSH（含托盘）再启动**。

## 快速开始

1. 打开侧边栏「积分面板」。
2. 点「连接商汤控制台」，填一次账号和密码，点登录。
3. 之后令牌自动续期，无需再操作。

登录失败时表单会直接显示商汤返回的原因（含「3 次错误锁 15 分钟」这类平台硬规则）；想清除账号，用面板底部的按钮。

## 把商汤模型接进 DSH（可选）

在面板「模型接入（API Key）」区粘贴 `sk-` Key 保存：Host 即以 `sensenova-token-plan` 之名注册 OpenAI 兼容 provider，模型列表随 `/v1/models` 自动刷新、可看图模型自动带图片输入，还能勾选具体要推送哪些模型。Key 只进 DSH 凭据、面板永不回显。开关与勾选都在面板热生效，无需重启。细节见 [docs/SETUP.md](docs/SETUP.md) §3 与 [docs/PROVIDER-HOT-RELOAD.md](docs/PROVIDER-HOT-RELOAD.md)。

## 文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 架构与数据流
- [docs/SETUP.md](docs/SETUP.md) — 配置字段、改动后重启、常见信号
- [docs/AUTH.md](docs/AUTH.md) — 登录 / 续期 / 节流设计
- [docs/API.md](docs/API.md) — 路由与控制台端点
- [docs/TESTING.md](docs/TESTING.md) — 测试体系
- [docs/SENSENOVA-API.md](docs/SENSENOVA-API.md) — 商汤接口全集（实测）
- [docs/PITFALLS.md](docs/PITFALLS.md) — 真实踩坑（21 条）
- [CHANGELOG.md](CHANGELOG.md) — 版本变化

AI 协作会话请先读 [AGENTS.md](AGENTS.md)。

## 诚实声明

- 面板显示的是**控制台自己的口径**，与网页控制台一致；`GET /v1/models` 只区分权限，不计费也不占推理额度；
- 续期在令牌过期前触发；若 refresh_token 被吊销且环境里已无密码，面板会明确提示重新登录，而不是静默显示旧数据；
- 凭据（账号、access/refresh token）只经 DSH 凭据服务保存，**密码不落盘**；本插件不写任何明文凭据文件或调试日志。

## 许可证

MIT License（Copyright (c) 2026 eghrhegpe），全文见 [LICENSE](LICENSE)；第三方依赖与合规说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
