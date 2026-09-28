# dsh-connect-sensenova-token-plan

dsh - UI 侧边栏里的一个全局面板，展示商汤控制台的 **Token Plan 真实积分用量**：

- **积分池**：每个池的 5 小时 / 每周两个额度窗口（已用 / 额度 / 百分比 / 重置时间）、返赠余额与到期时间
- **模型清单**：套餐覆盖的模型里，哪些当前 API Key 真的能调、哪些还需要开通
- **每模型消耗**：近 N 小时各模型的积分消耗排名

数据来自**商汤控制台自己的 API**（`pool-usage` / `credit-usage-trend`），与网页控制台看到的一致；`GET /v1/models` 是免费的只读调用，用来区分套餐覆盖与本 Key 权限。

Host 通过只读路由 `GET /api/dsh-connect-sensenova-token-plan/snapshot` 提供聚合结果，面板打开时才轮询，关闭即停。

## 认证

控制台 JWT 约 3 小时过期。Host 用 `refresh_token` 静默续期，**面板过期后不用重启、也不用手工换令牌**。首次只需在面板里填一次账号密码，之后密码可从环境变量删除。详见下方「认证」一节。

## 认证：面板自己配置，令牌自动续期

控制台 JWT 只有 **180 分钟**有效。以前过了期只能去 devtools 复制新的、改进 `.env`、重启 `dsh web` —— 每月都要被打断一次。

**现在什么都不用做。** 打开积分面板，填一次账号和密码，点「登录」：

1. Host 走**完整 OIDC 授权码流**登录（PKCE + 密码用平台 JWKS 公钥以 RSA-OAEP + A256GCM 加密成 JWE，明文不上网）；
2. 账号与密码交给 **DSH 凭据服务**保存（`~/.dsh/.credentials.yaml`，仅本账户可读），`access_token` 与 `refresh_token` 一并落库；
3. 此后**只靠 refresh_token 静默续期**，不再需要密码。令牌接近过期时自动换新，控制台返回 401 时也会换新并重试一次。

没有 `.env`、没有重启、没有明文凭据文件。密码只发往本机 Host，再由它加密送往商汤。

> 也可以继续用环境变量 `SENSENOVA_USERNAME` / `SENSENOVA_PASSWORD`（旧配置照常有效），优先级低于面板里保存的账号。

**登录失败时怎么办**：表单下方会显示商汤返回的原因（通常是「账号或密码不正确」），其下以灰字附上平台原话——包括锁定策略（3 次错误锁 15 分钟，平台硬规则）。密码框旁的「显示」按钮让你核对实际提交的内容：浏览器对 `127.0.0.1` 的自动填充、输入法混入的全角字符、复制粘贴带的尾随空格，在点号遮罩下全都看不出来，而每次盲试都烧掉一次尝试机会。若 refresh_token 被吊销且密码已不在环境中，面板会重新显示表单，此时填一次即可。

**清除账号**：面板底部的「连接商汤控制台」按钮里可以清除已保存的账号；当前令牌仍会继续用 refresh_token 续期，直到确实需要密码为止。

## 改代码后必须重启 Host

**插件的 Host 半边（`index.js` / `token-store.js` / `sensenova-auth.js`）在启动时加载一次。** 改完这些文件，运行中的 `dsh web` 不会自动重载，必须完全退出 DSH 再启动（托盘也要退）。

只改 `client.js` 时，浏览器刷新页面即可。

自查办法——看快照接口的返回：

```powershell
(Invoke-RestMethod http://127.0.0.1:19387/api/dsh-connect-sensenova-token-plan/snapshot).auth
```

- 有 `auth` 字段 → 新代码在跑；
- 没有 `auth`、而是 `totals` / `recent` 之类 → **跑的还是旧代码**，需要重启。

> 注意本机可能同时存在多个 dsh 进程：桌面版（默认 19387）与 `dsh web`（常见 3080）用的是**不同的 profile**。确认你打开的 GUI 连的是哪一个。

## 测试

```powershell
npm test         # 八个测试文件依次跑，全部离线
npm run test:live  # 额外验一次平台真实 JWKS（显式联网，默认不跑）
```

`npm test` **完全离线**，并且这一点是被断言的而非声称的：`test/peer-roots.mjs` 装了一个网络哨兵，任何逃出打桩的请求都会让测试失败并报出 URL。八个测试文件各自负责一层：

| 文件 | 覆盖 |
| --- | --- |
| `test/auth.test.mjs` | JWE 结构与往返、PKCE、拒绝分类、等待窗口解析（中英文 + `Retry-After`）、**登录 trace 成功与失败都上报**、**错误码 taxonomy 一致性** |
| `test/store.test.mjs` | 令牌续期、刷新令牌轮换、锁定与退避、跨进程节流、账号生命周期，**以及用真实凭据服务解析器校验本插件写入的每条记录**；节流落到插件自己的文件，跨进程与迁移各有用例 |
| `test/routes.test.mjs` | Host 路由函数体：令牌生命周期、账号写入、越权与跨源拒绝 |
| `test/wiring.test.mjs` | **真实 Cordis 容器**里的装配：`inject` 解析、服务注册、路由挂载与卸载、配置错误 |
| `test/panel.test.mjs` | **面板自己的代码**（从 `client.js` 源码里抽出来执行，不是抄一份）、**中英文字典键集一致**、控制台故障不走登录表单 |
| `test/render.test.mjs` | **面板渲染出的数字**（同样抠真源码求值，见 `panel-render.js`）：`used/limit` 写反、剩余量丢失、进度条色阶、除零都会红 |
| `test/config.test.mjs` | `CONFIG_DEFAULTS` 与 `cordis.patch.yml` 不静默漂移 |
| `test/package.test.mjs` | **`files` 清单覆盖 import 图**：从 `main`/`exports` 走静态 import 闭包，可达文件不在 `files` 里就红（曾漏 5 个模块，打包即崩）；顺带钉住"上了 `files` 却无人引用"的死重 |

几件值得知道的事：

- **面板逻辑没有镜像。** 旧版测试里有个手抄的 `panelDecision`，注释自己写着 "mirrored from PanelPage"——抄本和原件必然漂移，事实上它完全不知道节流字段，所以为修锁号加的置灰逻辑一行都没被测到。现在 `panel-decision.js` / `panel-render.js` 直接从 `client.js` 源码里把判定与渲染组件抽出来跑：改坏面板，测试立刻红。
- **`test:live` 是唯一允许联网的检查**，只拉公开 JWKS，不带凭据、不发登录请求。默认跑它意味着「测试会因与插件无关的外部原因失败」，也模糊了那条最重要的界线：验证不该默认等于对真实服务发请求。
- **一个请求只答一次，而且这件事是被断言的。** 保存账号的成功路径曾经写过两次响应（`try` 里的 `writeJson` 没有 `return`，流程漏到第二次）：真实 `ServerResponse` 会在第二次 `writeHead` 抛 `ERR_HTTP_HEADERS_SENT`，而用户看不到——第一个响应已经到浏览器了。测试里的假 `response` 当时接受两次写入，所以它一直是绿的；现在它会数。
- **本机的 `SENSENOVA_*` 环境变量被测试隔离。** `index.js` 在挂载时从 `process.env` 读 API key，一台真配了它的机器会走进套件从未打桩的分支（真去拉模型目录，并把一个非控制台 token 混进断言）。只在一台干净机器上绿、在作者机器上红的套件不叫离线，叫「通常离线」。`test/peer-roots.mjs` 的 `isolateHostEnv()` 负责这件事。
- **凭据文件的写入是被真实解析器把关的。** 本插件曾写过一条 `kind: "throttle"` 记录到 `~/.dsh/.credentials.yaml`——凭据服务只认 `kind: "grant"`，解析报错后 required 的 `credentials` 插件无法激活，**桌面端和 web 端整体起不来**（2026-09-27 事故）。根修后，节流记录改用 `kind: "grant"` + payload 内 `marker` 区分；`store.test.mjs` 会把本插件实际写出的记录喂给真实的 `parseCredentialsDocument`，任何非法形状在提交前就会红。若再遇到 Host 拒绝启动并报 `unknown kind`：删掉 `.credentials.yaml` 里 `records:` 下本插件命名空间（`dsh-connect-sensenova-token-plan/...`）的异常记录即可，其余记录不受影响。

测试无需 `npm install`：`@deepseek-ai/dsh-credentials` / `@deepseek-ai/cordis` 是 Host 里的 peer 依赖，由 `test/peer-roots.mjs` 在 DSH 运行时里就地解析（`$DSH_HOME` → 插件 `node_modules` → 安装目录）。找不到时会列出所有查过的位置，而不是静默跳过。

### 登录失败后的节流

平台在几次失败尝试后会锁号，所以插件**不在定时轮询里重发密码**。两类拒绝区别对待：

| 拒绝类型 | 平台返回 | 行为 |
| --- | --- | --- |
| **时间型**（锁定、频率限制、平台故障） | 带等待窗口，或无窗口 | 等待窗口结束前直接失败，不发请求。平台声明的窗口**照单全收，绝不截短**（声明 2 小时就等满 2 小时）；无窗口时本地指数退避 60s → 2m → 4m … 上限 30 分钟。窗口一到恰好探测一次。 |
| **凭据型**（密码错误、需验证码） | `invalidAccountOrPassword` 等 | **完全不自动重试**——等待改变不了一个错密码。面板重新提示输入账号，只有用户主动提交才再试。 |

节流状态写在**本插件自己的文件** `$DSH_HOME/state/dsh-connect-sensenova-token-plan/throttle.json`（`0600`）里，因此**跨进程、跨重启**都生效：另一个 Host 进程（桌面版 / `dsh web` 用不同 profile，但可能共用同一凭据目录）不会在等待期内继续敲门。窗口读取同时支持中英文（「try again after 8 minutes」与「请 8 分钟后重试」）以及 `Retry-After` 头。

> 它**不在**凭据服务里，这是有原因的：凭据服务只接受 `api-key` 与 `grant` 两种记录类型，写入第三种会让整个凭据文档无法解析，进而使必需的 `credentials` 服务启动失败——**整台 Host 起不来**，桌面版和 web 一起。节流曾经伪装成 `grant` 记录存那里，代价是每写一次都在赌一次整机宕机。节流是状态，不是凭据，所以搬了出来。升级时旧记录会被读取一次并接管（否则一个「密码错误」的 park 状态丢失，重启后就会自动重试那个错密码，正好把账号锁掉），随后删除。

## 安装

### 环境隔离（web 优先，桌面端后置）——强制约束

**本插件当前只允许挂在 `web` profile；`desktop` profile 禁止接入**，直到插件在 web 端
稳定运行一个观察期（含一次完整的登录/续期/限流周期）再考虑下发桌面端。理由是教训换来的：

- 桌面端把本插件列为**必需启动项**（`dsh.profile.bundles`），插件任何激活失败都会拖垮
  整个桌面端——2026-09-27 本插件往共享凭据库写入宿主不认识的 `kind: throttle` 记录，
  直接把桌面端炸到 startup failed，就是这条链路的实录；
- web 端与桌面端**共享同一份** `~/.dsh/.credentials.yaml`，但桌面端崩溃的爆炸半径
  （九个插件全部卡死）远大于 web 端；
- 开发期底层协议改动（如登录 JWE 封装重做）必须先在爆炸半径小的环境验证。

当前桌面端已做三重隔离（恢复方法见 `profiles/desktop/cordis.patch.yml` 内的 tombstone 注释）：
`dsh.profile.bundles` 已移除、`link:` 依赖已移除、`node_modules` 符号链接已删除、
patch 层留有 `disabled: true` 的墓碑行。

web 端安装（维持不变）：

```powershell
# 由带 plugin_manager 的会话执行，或在插件管理器页面操作
plugin_manager { action: "install_bundle", target: "C:\Users\zhujieling11\.dsh\plugins\dsh-connect-sensenova-token-plan" }
```

## 配置

`cordis.patch.yml`（本目录）就是配置面，改完重新安装/重载生效；也可以在 profile 的
`cordis.patch.yml` 里用 `- id: dsh-connect-sensenova-token-plan` 覆盖同名字段。

| 字段 | 默认 | 说明 |
|---|---|---|
| `consoleBase` | `https://platform.sensenova.cn` | 控制台源站（同时是 OAuth 授权起点与默认回调） |
| `trendHours` | `24` | 消耗趋势回看小时数（最大 168） |
| `cacheSeconds` | `60` | Host 侧缓存秒数；面板脚注直接引用此值 |
| `pollSeconds` | `30` | 面板轮询间隔，由 Host 下发，面板跟随（不再硬编码 30s） |
| `allowedHosts` | — | 追加可信 `Host` 名（默认 `localhost` / `127.0.0.1` / `::1`，只增不替） |
| `tokenSkewSeconds` | `120` | 提前多久续期，避免撞上过期边界 |
| `apiBase` | `https://token.sensenova.cn/v1` | 推理 API 源站（模型目录） |
| `iamBase` | `https://iam.sensecoreapi.cn` | 接受加密密码的 IAM 源站 |
| `tokenEndpoint` | `https://signin.sensecore.cn/oauth2/token` | Hydra 令牌端点 |
| `jwksEndpoint` | `https://signin.sensecore.cn/.well-known/jwks.json` | JWKS 文档（密码封包公钥） |
| `redirectUri` | 同 `consoleBase` | OAuth 注册回调； Hydra 精确匹配 |
| `clientId` | `nova` | 控制台公开 client id |
| `scope` | `openid offline offline_access` | `offline_access` 是拿到 refresh_token 的前提 |
| `encKeyId` | `public:hydra.openid.id-token` | 密码封包用的 JWKS key id |
| `maxHops` | `6` | 登录重定向链最大跳数 |
| `loginTimeoutMs` | `20000` | 登录流程单次请求超时（`requestTimeoutMs` 是它的旧名，仍然认） |
| `consoleTimeoutMs` | `15000` | 单次控制台请求超时（`pool-usage` / 模型目录） |

端点类字段仅在企业镜像/预发环境指向别的主机时才需要动；全部不配即等于平台默认值。
任意端点覆盖若不是合法的 http(s) 绝对地址，插件在挂载时就报 `config_error`（面板顶部显示），
而不是等到第一次轮询才变成莫名其妙的网络错误。

> 上表主机层字段的默认值（含 `allowedHosts` 的 `localhost`/`127.0.0.1`/`::1`）统一定义在 `index.js` 的
> `CONFIG_DEFAULTS`，并由 `test/config.test.mjs` 与 `cordis.patch.yml` 双向钉住；auth 类字段留空即表示
> "使用平台默认"，其生效值定义在 `sensenova-auth.js` 的 `AUTH_DEFAULTS`，不在此重复。

额度数值完全来自控制台 API，插件不做任何推算；快照里带 `shapeWarnings`，
控制台返回结构与预期不符（如字段改名）时面板会明说，而不是永远显示「暂无数据」。

## 文档体系

本仓库的详细文档在 `docs/` 下（与本文互补，不重复）：

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 双仓库关系（`dsh-connect-sensenova-token-plan` 与 `upstream/`）、Host/Client 分流、数据流、与上游 Python 工具的差异
- [docs/DSH-PLUGIN.md](docs/DSH-PLUGIN.md) — DSH 插件机制总览（bundle 结构、Loader 条目、cordis.patch.yml、安装重启、peer 依赖、与兄弟插件关系）
- [docs/SETUP.md](docs/SETUP.md) — 安装、配置字段、改动后必须重启 Host
- [docs/AUTH.md](docs/AUTH.md) — OIDC+PKCE 登录、密码 JWE 加密、凭据存储、静默续期、防锁号节流
- [docs/API.md](docs/API.md) — 本地路由与控制台端点、配置端点清单
- [docs/TESTING.md](docs/TESTING.md) — 离线测试体系、`panel-decision.js` 机制、已知缺口
- [docs/SENSENOVA-API.md](docs/SENSENOVA-API.md) — 商汤接口全集（认证/OIDC、密码 JWE、用量接口、错误码、上游简介）
- [docs/PITFALLS.md](docs/PITFALLS.md) — 真实踩坑经历（现象→根因→修法，15 条）
- [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) — 提交约定、红线、仓库整洁

## 仓库布局

```
dsh-connect-sensenova-token-plan/
├── index.js            # Host：快照路由 + 账号路由（启动加载一次，改完须重启 Host）
├── codes.js            # 错误码唯一声明处：auth 产出、store 分类、Host 归类共一份
├── token-store.js      # Host：凭据存取、续期、401 拒绝记忆
├── throttle-store.js   # Host：登录节流状态（插件自己的文件，不进凭据服务）
├── sensenova-auth.js   # Host：OIDC 授权码流 + refresh_token 续期
├── client.js           # Client：侧边栏 + 面板页 + 账号表单（interpretSnapshot / 决策块）
├── panel-decision.js   # 从 client.js 抠出决策块在 Node 里求值（测试用）
├── panel-render.js     # 从 client.js 抠出渲染组件在 Node 里求值（测试用）
├── cordis.patch.yml    # 配置面（含全部配置字段）
├── package.json        # bundle 清单 + npm test 脚本
├── test/               # 离线检查（auth/store/routes/panel/render/config/wiring + live）
├── docs/               # 文档体系（见上）
└── upstream/           # ⚠️ 被 .gitignore 忽略：上游 Python 桌面工具，自带独立 .git 与
                        #    GitHub remote，仅本地容纳、不进本仓库历史、构建期与运行期均不依赖
```

> `upstream/` 是从 `~/.dsh/fork/sensenova-usage-dashboard` 移入的参考实现（多账号 JWT 登录 + 桌面窗口 + 打包），与插件的登录封包、接口字段一致，可作为对照；但它不是本插件的依赖，改动它请在其独立仓库内进行。

## 诚实声明

- 面板显示的是**控制台自己的口径**，与网页控制台一致；`GET /v1/models` 只区分权限，不计费也不占推理额度；
- 续期在令牌过期前 `tokenSkewSeconds` 触发；若 refresh_token 被吊销且环境里已无密码，面板会明确提示需要重新登录，而不是静默显示旧数据；
- 凭据（密码、access/refresh token）只经 DSH 凭据服务保存，本插件不写任何明文凭据文件或调试日志；
- `credentialKey` / `credentialRef` 是**照抄** `@deepseek-ai/dsh-credentials` 格式的（`index.js`、`token-store.js` 各一处），为的是让测试不解析 peer 就能跑。这是笔债：**升级该 peer 包时必须复查这两处**，否则格式一变就会在运行时才炸。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | bundle 清单 + `dsh.client`（web 平台、locale/renderer/layout 注入顺序） |
| `cordis.patch.yml` | 插入 `dsh-connect-sensenova-token-plan` 行并携带全部配置 |
| `index.js` | Host：调用控制台 API 的 `/api` 快照路由（401 自动续期重试）+ 账号配置路由 |
| `codes.js` | 错误码与平台原因码的唯一声明处（新增一个平台原因只需改这里） |
| `token-store.js` | Host：凭据服务里的令牌与账号存取、按期续期、401 拒绝记忆 |
| `sensenova-auth.js` | Host：OIDC 授权码流登录 + `refresh_token` 静默续期 |
| `client.js` | Client：侧边栏图标 + `main` 面板页 + 账号表单（React，纯主题令牌样式） |
| `test/*.test.mjs` | 离线检查（`npm test`），网络层打桩，不碰真实账号 |

## 路由

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/dsh-connect-sensenova-token-plan/snapshot` | GET | 面板轮询的聚合结果 |
| `/api/dsh-connect-sensenova-token-plan/account` | GET / POST | 账号状态（不含密码）/ 保存账号 / `{forget:true}` 清除 |

两条路由都经过双层信任围栏：`Host` 必须在本机白名单内（默认 `localhost` / `127.0.0.1` / `[::1]` / `::1`，可在配置里追加）——这一层挡 DNS rebinding，rebind 后 Origin 与 Host 一致也进不来；带 `Origin` 的请求其 Origin 还必须与 `Host` 一致——这一层挡跨站伪造。因此只有本机 DSH 自己提供的页面能写入账号。请求体上限 4 KB。
