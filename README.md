# dsh-connect-agnes-token-plan

把 Agnes 接进 DSH 的 **Plugins 页**插件卡：看额度、接模型、出图与视频，一个面板全办。登录一次令牌自动重登，之后无需再管；限频 429 在 Host 侧自愈退避，模型不会无端"消失"。

面板分三个 tab，按「先看数、再接入、最后可选加桌面端上游」排序：

## 积分额度

地基。Agnes 的 Token Plan 是「**套餐即额度**」：订阅档位买到的不是积分余额，而是四个维度的用量窗口——模型请求（5 小时滚动）、每周请求、生图与视频（各 24 小时），各有上限、独立滚动，用超了只能等窗口重置。这个 tab 把数字搬进 DSH，写代码时不用切网页就能盯住：

- **额度窗口**：四个窗口的上限、周期与**平台报出的已用量**（含百分比与重置时间）
- **账号累计用量**：控制台口径的累计请求 / 文本 Token / 生图 / 视频秒数 / 活跃天数，以及近 N 天的分桶柱图
- **套餐对比**：平台**公开**的套餐目录（六档），无需登录即可读，用来回答"升级能买到什么"
- **模型清单**：当前 Key 实际能调哪些模型，其中哪些能看图（按平台 `input_modalities` 判定，不靠名字猜）

![「积分额度」tab](assets/panel-credit.png)

首次使用在「连接 Agnes 控制台」填一次账号和密码（Agnes 不发 refresh token，续期就是自动重登一次）。登录失败时表单会直接显示 Agnes 返回的原因；密码错误属于**凭据型拒绝**，面板**绝不自动重试**（Agnes 有失败次数锁定）。想清除账号，用面板底部的按钮。

## 接入 API（可选）

把 Agnes 模型注册为 DSH provider，参与对话与出图。三张卡按"你为什么来这"排序，而不是按依赖排序：**语言模型**（注册 provider + 勾选推送哪些模型）与**出图工具**在最前且默认展开；**API Key** 收在最后（默认收起），它是前两张卡的前置条件，由它们指回来。

- **语言模型**：在「API Key」卡粘贴 Key 保存（免费版 `sk-` 或 Token Plan `cpk-` 皆可，共用同一输入框），Host 即以 `agnes-token-plan` 之名注册 OpenAI 兼容 provider，模型列表随 `/v1/models` 自动刷新；Key 只进 DSH 凭据、面板永不回显。**计费双轨**——`sk-` 走 API 按量计费，`cpk-` 走订阅配额（本 tab 只读订阅配额），两类 Key 独立限制池，换 Key 即换池。
- **出图 / 视频工具**：打开开关后 Host 给 agent 注册 `agnes_draw_image` / `agnes_video_generate`，鉴权走同一把 `AGNES_TOKEN_PLAN_API_KEY`；出图模型按 catalog 的 `output_modalities` 结构化判定，视频按选中模型分派 V2.0 / 2.5 两套互斥参数。工具的实际挂载 / 缺席发生在**下一次 Host 启动**（agent tools 没有 unregister 语义），开关值本身立即生效。
- 开关与勾选都在面板热生效，无需重启。细节见 [docs/SETUP.md](docs/SETUP.md) §3、[docs/PROVIDER-HOT-RELOAD.md](docs/PROVIDER-HOT-RELOAD.md) 与 [docs/AGNES-API.md](docs/AGNES-API.md) §7.5。

![「接入 API」tab](assets/panel-API-provider.png)

## AgnesCode（可选，默认关）

接的是 **AgnesCode 桌面端**的登录态：微信扫码发生在桌面 App 里，本插件只**读取** App 留在本机的加密会话文件，以 provider id `agnescode` 注册**独立** provider、独立积分池——两条上游凭据互不相通：

1. **凭据来源**：Chromium os_crypt 加密会话文件，密钥经系统 DPAPI 解封，全程内存使用、不落盘不显示；
2. **接口地址**：写在会话文件里、**按账号跟随**，钉死在 Agnes 域名族内，地址不对就拒绝使用；
3. **显示口径**：积分是**订阅池**（时效 + 永久）；模型清单带「会员」标记而不隐藏——会员门槛是账号状态，不是模型不存在；
4. **失败可诊断**：检测不到登录态时，面板逐条列出探测过哪些文件、各自为什么没成（「没装 App」「解不开密」「会话里没有令牌」是三种不同的处理）；
5. **约 28 天续期一次**：JWT 过期后没有自动路径，开一次桌面 App、再点「检测本机登录态」重新采集即可。

协议探针记录见 [docs/ROADMAP.md](docs/ROADMAP.md) §6.3。

![AgnesCode tab](assets/panel-AgnesCode.png)

## 边界

- **只读的部分**：面板**不代你操作账务**——不改套餐、不代扣额度、不碰 Key 明文；数据来自 Agnes 控制台自己的 API，与网页控制台口径一致。
- **会「动」的部分**：注册 provider、挂出图工具、挂视频工具、接桌面端上游，全部 opt-in 且**默认关闭**；一个都不打开时，插件退化为纯信息展示。

## 安装

1. 在 DSH「插件」页搜索 `dsh-connect-agnes-token-plan` 点击安装，或运行：

   ```powershell
   dsh plugin --profile web add dsh-connect-agnes-token-plan       # Web 端
   dsh plugin --profile desktop add dsh-connect-agnes-token-plan  # 桌面端
   ```

2. **完全退出 DSH（含托盘）再启动**。

3. 打开 DSH 的 **Plugins 页**，找到 `dsh-connect-agnes-token-plan` 的插件卡（面板是页内的内联卡片，**不在侧边栏**）。

> 装到的是哪一版由源决定：安装器会询问 profile 配的 registry，**默认含 `registry.npmmirror.com`，刚发布的版本在镜像上可能延迟几分钟**，官方源立即可用；要确认拿到了哪一版，对照 `npm view dsh-connect-agnes-token-plan version --registry=https://registry.npmjs.org`。三种 target 形态（npm 包名 / git 地址 / 本地路径）见 [docs/SETUP.md](docs/SETUP.md)。

## 它是怎么工作的

登录原理一句话：Host 在后台向 `{consoleBase}/api/user/login` 发**一次**账号密码 POST 换取 access token（Agnes 没有 OIDC 跳转、没有 refresh token），令牌过期或被拒时用同一路径**重登一次**；面板打开时才轮询一个只读本地路由，关掉即停。协议细节（一跳登录、密码明文过 TLS 与「不落盘」纪律、防锁号节流）见 [docs/AUTH.md](docs/AUTH.md)，接口契约见 [docs/AGNES-API.md](docs/AGNES-API.md)。

**窗口「已用」是平台报出的，面板不计算**：`/api/cn/user/subscription` 直接返回每个窗口的 `used` / `limit` / `reset_at` / `usage_pct`（控制台「当前用量」那一屏的数据源），面板逐字转写、不做减法。下方的「账号累计用量」统计的是另一段周期，**不能拿来减窗口上限**——减出来的「剩余」没人能担保，所以面板在界面上明说了这一点，全链路也不产出「剩余」这个数。

## 运维诊断：这台机器现在挂没挂 provider？

provider / 出图开关的生效值存在插件私有状态文件里（`$DSH_HOME/state/<name>/`），不在任何配置或路由上——查"到底开没开"用 doctor，它只读状态文件、不碰凭据，Host 没起也能跑：

```powershell
npm run doctor          # 人读：每个 profile 的 provider / draw / video / agnescode 开关与模型清单
npm run doctor:json     # 机器读：JSON（可进你的巡检 / 工单脚本）
```

## 文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 架构与数据流
- [docs/SETUP.md](docs/SETUP.md) — 配置字段、改动后重启、常见信号
- [docs/AUTH.md](docs/AUTH.md) — 登录 / 重登 / 节流设计
- [docs/API.md](docs/API.md) — 路由与控制台端点
- [docs/AGNES-API.md](docs/AGNES-API.md) — Agnes 接口全集（控制台额度侧 + 推理侧）
- [docs/TESTING.md](docs/TESTING.md) — 测试体系
- [docs/PITFALLS.md](docs/PITFALLS.md) — 真实踩坑（47 条）
- [CHANGELOG.md](CHANGELOG.md) — 版本变化

AI 协作会话请先读 [AGENTS.md](AGENTS.md)。

## 诚实声明

- 面板显示的是**控制台自己的口径**，与网页控制台一致；`GET /v1/models` 只区分权限，不计费也不占推理额度；
- 令牌被拒时面板明确提示重新登录，而不是静默显示旧数据；
- 凭据（账号、access token）只经 DSH 凭据服务保存，**密码不落盘**；本插件不写任何明文凭据文件或调试日志。

## 许可证

MIT License（Copyright (c) 2026 eghrhegpe），全文见 [LICENSE](LICENSE)；第三方依赖与合规说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
