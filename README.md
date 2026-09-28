# dsh-connect-sensenova-token-plan

dsh - UI 侧边栏里的一个全局面板，展示商汤控制台的 **Token Plan 真实积分用量**：

- **积分池**：每个池的 5 小时 / 每周两个额度窗口（已用 / 额度 / 百分比 / 重置时间）、返赠余额与到期时间
- **模型清单**：套餐覆盖的模型里，哪些当前 API Key 真的能调、哪些还需要开通
- **每模型消耗**：近 N 小时各模型的积分消耗排名

数据来自**商汤控制台自己的 API**（`pool-usage` / `credit-usage-trend`），与网页控制台看到的一致；`GET /v1/models` 是免费的只读调用，用来区分套餐覆盖与本 Key 权限。

Host 通过只读路由 `GET /api/dsh-connect-sensenova-token-plan/snapshot` 提供聚合结果，面板打开时才轮询，关闭即停。

## 登录一次，令牌自动续期

控制台 JWT 只有 **180 分钟**有效。打开积分面板，填一次账号和密码，点「登录」：

1. Host 走**完整 OIDC 授权码流**登录（PKCE + 密码用平台 JWKS 公钥以 RSA-OAEP + A256GCM 加密成 JWE，明文不上网）；
2. 账号、`access_token` 与 `refresh_token` 交给 **DSH 凭据服务**保存（`~/.dsh/.credentials.yaml`，仅本账户可读）；**密码不落盘**——只在登录瞬间于内存中使用，用完即弃；
3. 此后**只靠 refresh_token 静默续期**，不再需要密码。令牌接近过期时自动换新，控制台返回 401 时也会换新并重试一次。

没有 `.env`、没有重启、没有明文凭据文件。密码只发往本机 Host，再由它加密送往商汤。

> 密码的唯一持久来源是环境变量 `SENSENOVA_PASSWORD`（显式 opt-in：放在环境里，refresh_token 失效后可自动重登，无需再输一次）；账号名以面板保存的为准，环境变量兜底。

**登录失败时怎么办**：表单下方会显示商汤返回的原因（通常是「账号或密码不正确」），其下以灰字附上平台原话——包括锁定策略（3 次错误锁 15 分钟，平台硬规则）。密码框旁的「显示」按钮让你核对实际提交的内容：浏览器对 `127.0.0.1` 的自动填充、输入法混入的全角字符、复制粘贴带的尾随空格，在点号遮罩下全都看不出来，而每次盲试都烧掉一次尝试机会。若 refresh_token 被吊销且密码已不在环境中，面板会重新显示表单，此时填一次即可。

**清除账号**：面板底部的「连接商汤控制台」按钮里可以清除已保存的账号；当前令牌仍会继续用 refresh_token 续期，直到确实需要密码为止。

登录 / 续期 / 节流的完整设计见 [docs/AUTH.md](docs/AUTH.md)。

## 可选：面板里直接接入 LLM provider

不想手写 `llm-pi-ai` 配置行时，在本插件 row 上把 `registerProvider` 设为 `true`（字段见 [docs/SETUP.md](docs/SETUP.md) §3），再在面板「模型接入（API Key）」区粘贴 `sk-` Key 保存：Host 即以 `sensenova-token-plan` 之名直连 `token.sensenova.cn/v1` 注册 OpenAI 兼容 provider，模型列表随 `/v1/models` 自动刷新、可看图模型自动带图片输入；同区还能勾选**具体要推送哪些模型**（默认全部推送，也能临时一个都不推）。Key 只进 DSH 凭据（`SENSENOVA_API_KEY` 环境变量仍兜底）、面板永不回显；catalog 与勾选记录只写插件私有状态文件。开关与勾选都在面板热生效、无需重启 Host，设计守口见 [docs/PROVIDER-HOT-RELOAD.md](docs/PROVIDER-HOT-RELOAD.md)。

## 改代码后必须重启 Host

**插件的 Host 半边（`index.js` / `token-store.js` / `sensenova-auth.js`）在启动时加载一次。** 改完这些文件，运行中的 `dsh web` 不会自动重载，必须完全退出 DSH 再启动（托盘也要退）。只改 `client.js` 时，浏览器刷新页面即可。

自查是否跑的是新代码、以及「多个 dsh 进程用不同 profile」的陷阱，见 [docs/SETUP.md](docs/SETUP.md) §4。

## 安装

**当前只允许挂在 `web` profile；`desktop` profile 禁止接入**——历史事故教训换来的强制约束（桌面端爆炸半径、三重隔离与恢复方法见 [docs/SETUP.md](docs/SETUP.md) §2）。

包已发布 npm，普通用户无需 clone：在 Web 侧边栏「插件」页输入包名，或由带 `plugin_manager` 的会话执行：

```powershell
plugin_manager { action: "install_bundle", target: "dsh-connect-sensenova-token-plan" }
```

开发期从本地检出安装（target 填检出目录绝对路径），以及 git/tarball、镜像源同步等细节见 [docs/SETUP.md](docs/SETUP.md) §2。装完须完全退出 DSH（含托盘）再启动。

## 配置

配置面就是本目录的 `cordis.patch.yml`；全部字段、默认值与「非法端点地址挂载即报 `config_error`」的语义见 [docs/SETUP.md](docs/SETUP.md) §3。额度数值完全来自控制台 API，插件不做任何推算；控制台返回结构与预期不符时快照带 `shapeWarnings`，面板会明说，而不是永远显示「暂无数据」。

## 测试

```powershell
npm test         # 十一个离线测试文件依次跑（含文档一致性检查），末尾再跑端到端（无 dsh CLI 时自动 SKIP）
npm run test:e2e # 只跑端到端：拉起真 Host + 假平台（需 dsh CLI 在 PATH）
npm run test:live  # 额外验一次平台真实 JWKS（显式联网，默认不跑）
```

前十一个文件**完全离线**（网络层打桩、密码用临时密钥，且这一点被 `test/peer-roots.mjs` 的网络哨兵断言而非声称），测试无需 `npm install`。各套件职责、面板测试机制（`client-surface.js` / `panel-decision.js`）与已知缺口见 [docs/TESTING.md](docs/TESTING.md)。

## 文档体系

详细文档在 `docs/` 下（与本文互补，不重复）：

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 双仓库关系、Host/Client 分流、数据流、与上游 Python 工具的差异
- [docs/DSH-PLUGIN.md](docs/DSH-PLUGIN.md) — DSH 插件机制总览（bundle 结构、Loader、cordis.patch.yml、peer 依赖）
- [docs/SETUP.md](docs/SETUP.md) — 安装、配置字段、重启注意事项、常见信号处置
- [docs/AUTH.md](docs/AUTH.md) — OIDC+PKCE 登录、密码 JWE、凭据存储、静默续期、防锁号节流
- [docs/API.md](docs/API.md) — 本地路由与控制台端点、快照返回结构
- [docs/TESTING.md](docs/TESTING.md) — 离线测试体系、面板测试机制、已知缺口
- [docs/SENSENOVA-API.md](docs/SENSENOVA-API.md) — 商汤接口全集（认证/OIDC、密码 JWE、用量接口、错误码）
- [docs/PITFALLS.md](docs/PITFALLS.md) — 真实踩坑经历（现象→根因→修法，21 条）
- [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) — 提交约定、红线、仓库整洁
- [CHANGELOG.md](CHANGELOG.md) — 公开行为变化的版本记录（非 git log 替代）

AI 协作会话请先读根目录 [AGENTS.md](AGENTS.md)（验证怎么跑、红线、文档地图）。

## 仓库布局

```
dsh-connect-sensenova-token-plan/
├── index.js            # Host：快照路由 + 账号路由（启动加载一次，改完须重启 Host）
├── codes.js            # 错误码唯一声明处：auth 产出、store 分类、Host 归类共一份
├── host-config.js      # 配置解析：CONFIG_DEFAULTS 与 auth overrides 的 resolveAuthOverrides
├── token-store.js      # Host：凭据存取、续期、401 拒绝记忆
├── throttle-store.js   # Host：登录节流状态（插件自己的文件，不进凭据服务）
├── sensenova-auth.js   # Host：OIDC 授权码流 + refresh_token 续期
├── sensenova-crypto.js # 密码 JWE 封包（平台 JWKS 公钥 RSA-OAEP + A256GCM）
├── console-client.js   # 控制台 API 客户端（pool-usage / credit-usage-trend / models）
├── parsers.js          # 响应解析层：字符串数值/epoch 归一、checkShape 漂移检测、trend 求和
├── llm-models.js       # 第三步（无 peer 依赖）：catalog entry → pi-ai descriptor 映射（vision 自动）
├── llm-adapter.js      # 第三步（peer 懒加载）：PiAiAdapter 装配，直连 token.sensenova.cn/v1
├── catalog-store.js    # 第三步：私有 catalog/允许清单状态文件（state/<name>/catalog.json，不进 dsh 配置）
├── api-key-store.js    # 第三步：sk- Key 凭据引用 SENSENOVA_API_KEY（credentials→memory→env）
├── trace.js            # 登录 trace 落盘（成功/失败，值级脱敏）
├── util.js             # 共享工具函数
├── client.js           # Client：侧边栏 + 面板页 + 账号表单（工厂即模块，自带 panel 测试面）
├── client-surface.js   # 测试基建：把 client.js 作为模块加载、物化 panel 测试面
├── panel-decision.js   # 测试基建：从 panel 测试面取决策/字典/错误码表（Node 可直接 import）
├── panel-render.js     # 测试基建：从 panel 测试面取渲染组件与样式令牌（Node 可直接 import）
├── AGENTS.md           # AI 协作会话纪律：验证、红线、文档地图
├── cordis.patch.yml    # 配置面（含全部配置字段）
├── package.json        # bundle 清单 + npm test 脚本
├── test/               # 离线检查（11 套件 + e2e-gate）+ 单独跑（e2e/live）+ 基建（peer-roots/fake-platform）
├── docs/               # 文档体系（见上）
├── .github/            # CI workflow（离线十套件硬门禁 + 端到端 best-effort）
└── upstream/           # ⚠️ 被 .gitignore 忽略：上游 Python 桌面工具，自带独立 .git 与
                        #    GitHub remote，仅本地容纳、不进本仓库历史、构建期与运行期均不依赖
```

> `upstream/` 是从 `~/.dsh/fork/sensenova-usage-dashboard` 移入的参考实现（[shaobingtongzhi/sensenova-usage-dashboard](https://github.com/shaobingtongzhi/sensenova-usage-dashboard)，多账号 JWT 登录 + 桌面窗口 + 打包），与插件的登录封包、接口字段一致，可作为对照；但它不是本插件的依赖，改动它请在其独立仓库内进行。

## 诚实声明

- 面板显示的是**控制台自己的口径**，与网页控制台一致；`GET /v1/models` 只区分权限，不计费也不占推理额度；
- 续期在令牌过期前 `tokenSkewSeconds` 触发；若 refresh_token 被吊销且环境里已无密码，面板会明确提示需要重新登录，而不是静默显示旧数据；
- 凭据（账号、access/refresh token）只经 DSH 凭据服务保存，**密码不落盘**（仅登录瞬间内存使用，`SENSENOVA_PASSWORD` 环境变量是唯一持久来源）；本插件不写任何明文凭据文件或调试日志。

## 路由

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/dsh-connect-sensenova-token-plan/snapshot` | GET | 面板轮询的聚合结果 |
| `/api/dsh-connect-sensenova-token-plan/account` | GET / POST | 账号状态（不含密码）/ 保存账号 / `{forget:true}` 清除 |
| `/api/dsh-connect-sensenova-token-plan/api-key` | GET / POST | 推理 Key 去密状态 / 保存 `sk-` Key / `{forget:true}` 清除（永不回显明文） |
| `/api/dsh-connect-sensenova-token-plan/provider` | GET / POST | 注册开关生效值与来源 / `{enabled:boolean}` 立即重新发布 |
| `/api/dsh-connect-sensenova-token-plan/models` | POST | `{enabledModelIds:string[]}` 选择要推送哪些模型，立即重新发布 |

五条路由都经过双层信任围栏（Host 本机白名单挡 DNS rebinding + Origin 与 Host 一致挡跨站伪造），请求体上限 4 KB；返回结构与细节见 [docs/API.md](docs/API.md) §1。

## 许可证

MIT License（Copyright (c) 2026 eghrhegpe），全文见 [LICENSE](LICENSE)；第三方依赖与合规说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
