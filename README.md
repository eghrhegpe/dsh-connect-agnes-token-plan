# dsh-connect-agnes-token-plan

Agnes 接入的 DSH **Plugins 页**插件卡**全家桶**，三个 tab 自上而下就是使用顺序：① **积分额度**（纯信息，装完即用）→ ② **接入 API**（可选）→ ③ **AgnesCode**（可选、默认关）。两条上游凭据相互独立。此外 429 自愈在后台生效：限频被误判为"额度耗尽"时在 Host 侧纠正回退避重试，模型不会无端消失。

## 功能

### ① 积分额度 tab：套餐即额度

![积分额度 tab](assets/panel-credit.png)

Agnes 的 Token Plan 是「**套餐即额度**」：订阅档位买到的不是积分余额，而是四个维度的用量窗口——各有上限、独立滚动，用超了只能等窗口滚过：

| 维度 | 上限字段 | 窗口 |
|---|---|---|
| 模型请求 | `concurrency_limit` | `concurrency_window_h`（各档均为 5 小时） |
| 每周请求 | `text_weekly_limit` | 168 小时 |
| 生图 | `image_daily_limit` | 24 小时 |
| 视频 | `video_daily_limit` | 24 小时 |

这个面板把数字搬进 DSH 的 Plugins 页，写代码时不用切网页就能盯住：

- **额度窗口**：四个窗口的上限、周期与**平台报出的已用量**（`used / limit` 与百分比）。面板直接引用控制台自己的「当前用量」，进度条是逐字转写、不做减法；`usage_pct` 也是平台算好的
- **账号累计用量**：控制台口径的累计请求 / 文本 Token / 生图 / 视频秒数 / 活跃天数，以及近 N 天的分桶柱图
- **套餐对比**：平台**公开**的套餐目录（六档：入门版 / 专业版 / 高级版 × 月付 / 年付），无需登录即可读，用来回答"升级能买到什么"
- **模型清单**：当前 Key 实际能调哪些模型，其中哪些能看图（按平台 `input_modalities` 判定，不靠名字猜）
### ②③ 另外两个 tab（都可选）

- **② 接入 API**：把 Agnes 模型接进 DSH 对话，思考强度可选，并可注册出图 / 视频工具——见[下文](#把-agnes-模型接进-dsh可选)。
- **③ AgnesCode**（默认关）：读取本机 AgnesCode 桌面端的登录态，独立 provider 与独立积分池——见[下文](#桌面端上游agnescode可选默认关)。

面板**不代你操作账务**：不改套餐、不代扣额度、不碰 Key 明文；数据来自 Agnes 控制台自己的 API，与网页控制台口径一致。真正会「动」的四部分——注册 provider、挂出图工具、挂视频工具、接入 AgnesCode 桌面端上游——全部 opt-in 且**默认关闭**，不打开时插件退化为纯信息展示。

**注册 provider 时**（面板开关打开），插件把 Agnes 模型接进 DSH 的对话模型选择器，并在 Host 侧纠正 peer 对限频 429 的误判（peer 的 `isQuotaExceededError` 命中面过宽，任何带额度措辞的 429——如 `out of rate budget`——都会被抢判成「额度耗尽」而不重试）——限频真正退避重试，模型不再无端 "消失"。

## 安装

1. 在 DSH「插件」页搜索 `dsh-connect-agnes-token-plan` 点击安装，或运行：

   ```powershell
   dsh plugin --profile web add dsh-connect-agnes-token-plan       # Web 端
   dsh plugin --profile desktop add dsh-connect-agnes-token-plan  # 桌面端
   ```

2. **完全退出 DSH（含托盘）再启动**。

> 装到的是哪一版由源决定：安装器会询问 profile 配的 registry，**默认含 `registry.npmmirror.com`，刚发布的版本在镜像上可能延迟几分钟**，官方源立即可用；要确认拿到了哪一版，对照 `npm view dsh-connect-agnes-token-plan version --registry=https://registry.npmjs.org`。三种 target 形态（npm 包名 / git 地址 / 本地路径）见 [docs/SETUP.md](docs/SETUP.md)。

## 快速开始

1. 打开 DSH 的 **Plugins 页**，找到 `dsh-connect-agnes-token-plan` 的插件卡（面板是页内的内联卡片，**不在侧边栏**）。
2. 在「积分额度」tab 点「连接 Agnes 控制台」，填一次账号和密码，点登录。
3. 之后令牌失效会自动重登（Agnes 不发 refresh token，续期的唯一路径就是重登一次），无需再操作。

登录失败时表单会直接显示 Agnes 返回的原因；密码错误属于**凭据型拒绝**，面板**绝不自动重试**（Agnes 有失败次数锁定），只有你主动点「登录」才会再发一次。想清除账号，用面板底部的按钮。

## 它是怎么工作的

登录原理一句话：Host 在后台向 `{consoleBase}/api/user/login` 发**一次**账号密码 POST 换取 access token（Agnes 没有 OIDC 跳转、没有 refresh token），令牌过期或被拒时用同一路径**重登一次**；面板打开时才轮询一个只读本地路由，关掉即停。协议细节（一跳登录、密码明文过 TLS 与「不落盘」纪律、防锁号节流）见 [docs/AUTH.md](docs/AUTH.md)，接口契约见 [docs/AGNES-API.md](docs/AGNES-API.md)。

**窗口「已用」是平台报出的，面板不计算**：`/api/cn/user/subscription` 直接返回每个窗口的 `used` / `limit` / `reset_at` / `usage_pct`（控制台「当前用量」那一屏的数据源），面板逐字转写并渲染进度条。但 `overview` / `series` 是**账号累计**口径，覆盖的是一段更长的时间——**不能用它去减窗口上限**，那个「剩余」跨周期、没人能担保，所以面板把「窗口用量」与「账号累计」作为两个独立事实并排显示，并明说不可相减。

## 把 Agnes 模型接进 DSH（可选）

![接入 API tab](assets/panel-API-provider.png)

「接入 API」tab 的三张卡按"你为什么来这"排序，而不是按依赖排序：**语言模型**（注册 provider + 勾选推送哪些模型）、**出图工具**——两张都在最前且默认展开；**API Key** 收在最后（默认收起），它是前两张卡的前置条件，由它们指回来。

在「API Key」卡里粘贴 API Key 保存（免费版 `sk-` 或 Token Plan `cpk-` 皆可）：Host 即以 `agnes-token-plan` 之名注册 OpenAI 兼容 provider，模型列表随 `/v1/models` 自动刷新，还能在「语言模型」卡勾选具体要推送哪些模型。Key 只进 DSH 凭据（引用名 `AGNES_TOKEN_PLAN_API_KEY`）、面板永不回显。开关与勾选都在面板热生效，无需重启。细节见 [docs/SETUP.md](docs/SETUP.md) §3 与 [docs/PROVIDER-HOT-RELOAD.md](docs/PROVIDER-HOT-RELOAD.md)。

> **免费版与付费 Token Plan 共用同一个 API Key 输入框**：`sk-`（免费版）与 `cpk-`（Token Plan）两类 Key 都走同一份 `/v1/models` 目录，本插件对前缀不做限制。**计费双轨**——`sk-` 走 API 按 token / 张 / 秒计费（`agnes-2.5-flash` / `agnes-3.0-flash` / 图片模型当前优惠价 `$0`，`agnes-2.5-pro` 按刊例价），`cpk-` 走 Token Plan 订阅配额（四窗口）。面板「积分额度」tab 只读**订阅配额**，不读 API 按量余额；两类 Key 使用**独立限制池**，换 Key 即换池。两者都能在此粘贴。

## 出图工具（可选，默认关）

面板「出图工具」卡（在「语言模型」下方，默认展开）打开开关后，Host 给 agent 注册工具 `agnes_draw_image`（首选模型由 `drawModelId` 指定），鉴权走同一把 `AGNES_TOKEN_PLAN_API_KEY`。出图模型优先按 catalog 的 `output_modalities` 结构化判定，该字段在 Agnes 目录上**缺失**时退回模型名里的 `image` 段（名字兜底才是实际命中的路径）。注意：工具的实际挂载 / 缺席发生在**下一次 Host 启动**（agent tools 没有 unregister 语义），开关值本身立即生效。

## 视频工具（可选，默认关）

面板「视频工具」卡（在「出图工具」下方，默认展开）打开开关后，Host 给 agent 注册工具 `agnes_video_generate`（首选模型由 `videoModelId` 指定），鉴权同样走 `AGNES_TOKEN_PLAN_API_KEY`。与出图**不同**的是协议：图片一次请求同步返回，视频是**异步任务制**——建任务后轮询到完成。**V2.0 与 2.5 两个参数体系都覆盖**，工具按选中模型分派请求体：V2.0（`agnes-video-v2.0`）走 `width`/`height`/`num_frames`/`frame_rate`，2.5（`agnes-video-2.5` / `agnes-video-2.5-flash`）走 `mode`/`seconds`/`size`/`aspect_ratio`。两套字段互斥、永不同时发给同一模型，但处理是**不对称**的：V2.0 帧数字段发到 2.5 模型会被换算成最接近的整秒（`121 @ 24fps → 5s`），保留「不判断家族也能出片」的退路；反过来，2.5 专有字段发到 V2.0 模型会**当场报错并给出修法**——工具不会静默丢弃，丢弃等于让你以为拿到 10 秒 2K、实际拿到 5 秒 720P。自动选择优先 V2.0，目录里没有 V2.0 时回落第一个 2.5 模型；面板仍会把 2.5 家族单独点名。协议细节与校验规则见 [docs/AGNES-API.md](docs/AGNES-API.md) §7.5。

## 桌面端上游：AgnesCode（可选，默认关）

![AgnesCode tab](assets/panel-AgnesCode.png)

面板「AgnesCode」tab 接的是 **AgnesCode 桌面端**的登录态：微信扫码发生在桌面 App 里，本插件只**读取** App 留在本机的加密会话文件（Chromium os_crypt，密钥经系统 DPAPI 解封，全程内存使用、不落盘不显示；解出的凭据随后存入 DSH 凭据服务，与账号密码同一纪律），并以 provider id `agnescode`（显示名 AgnesCode）注册**独立** provider。它的接口地址写在会话文件里、**按账号跟随**（钉死在 Agnes 域名族内，地址不对就拒绝使用）；显示的积分是**订阅池**口径（时效 + 永久），模型清单带「会员」标记（会员门槛是账号状态，不是模型不存在，所以标记而不隐藏）。检测不到登录态时，面板逐条列出**探测过哪些文件、各自为什么没成**——「没装 App」「解不开密」「会话里没有令牌」是三种不同的处理方式，不会笼统叫你重新登录。JWT 有效期约 28 天，过期后开一次桌面 App 再点「检测本机登录态」即可；协议探针记录见 [docs/ROADMAP.md](docs/ROADMAP.md) §6.3。

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
- 窗口卡片里的「已用」是控制台报出的「当前用量」，面板逐字转写、不做减法；下方「账号累计」覆盖的是另一段时间，不能与窗口上限相减；
- 令牌被拒时面板明确提示重新登录，而不是静默显示旧数据；
- 凭据（账号、access token）只经 DSH 凭据服务保存，**密码不落盘**；本插件不写任何明文凭据文件或调试日志。

## 许可证

MIT License（Copyright (c) 2026 eghrhegpe），全文见 [LICENSE](LICENSE)；第三方依赖与合规说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
