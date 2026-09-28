# 安装与配置（Setup）

本插件随 Host（桌面版或 `dsh web`）运行，没有独立启动入口。

---

## 1. 前置条件

- **Node.js ≥ 22**：仅用于跑测试（`npm test`），运行时由 Host 提供运行时，无需本机装 Node 来跑插件本身。
- **DSH 运行时**：插件装在某个 DSH profile 下，由 Host 在启动时加载 `index.js` 等 Host 半边文件。
- **凭据服务**：Host 需具备 `@deepseek-ai/dsh-credentials` 能力，账号密码与令牌才能落库。没有它时面板仍可打开，但账号只存内存（重启需重登，见 [AUTH.md](./AUTH.md)）。

---

## 2. 安装

由带 `plugin_manager` 的会话执行，或在插件管理器页面操作：

```powershell
# target 填本检出的绝对路径（一般在 `~\.dsh\plugins\` 下）
plugin_manager { action: "install_bundle", target: "<插件目录>\dsh-connect-sensenova-token-plan" }
```

安装后，Harness Web UI 侧边栏出现「积分面板」入口；首次打开会提示连接商汤控制台。

### 环境隔离（web 优先，桌面端后置）——强制约束

**本插件当前只允许挂在 `web` profile；`desktop` profile 禁止接入**，直到插件在 web 端
稳定运行一个观察期（含一次完整的登录/续期/限流周期）再考虑下发桌面端。理由是教训换来的：

- 桌面端把本插件列为**必需启动项**（`dsh.profile.bundles`），插件任何激活失败都会拖垮
  整个桌面端——2026-09-27 本插件往共享凭据库写入宿主不认识的 `kind: throttle` 记录，
  直接把桌面端炸到 startup failed，就是这条链路的实录；
- web 端与桌面端**共享同一份** `~/.dsh/.credentials.yaml`，但桌面端崩溃的爆炸半径
  （九个插件全部卡死）远大于 web 端；
- 开发期底层协议改动（如登录 JWE 封装重做）必须先在爆炸半径小的环境验证。

当前桌面端已做三重隔离（恢复方法见宿主机器 `~/.dsh/profiles/desktop/cordis.patch.yml`
内的 tombstone 注释——该路径在宿主 profile 目录，**不在本仓库**）：`dsh.profile.bundles`
已移除、`link:` 依赖已移除、`node_modules` 符号链接已删除、patch 层留有
`disabled: true` 的墓碑行。

---

## 3. 配置

配置面就是本目录的 **`cordis.patch.yml`**，改完重新安装 / 重载生效；也可在 profile 的 `cordis.patch.yml` 里用 `- id: dsh-connect-sensenova-token-plan` 覆盖同名字段。

| 字段 | 默认 | 说明 |
|---|---|---|
| `consoleBase` | `https://platform.sensenova.cn` | 控制台源站（OAuth 授权起点 / 默认回调） |
| `trendHours` | `24` | 消耗趋势回看小时数（最大 168） |
| `cacheSeconds` | `60` | Host 侧缓存秒数；面板脚注直接引用此值 |
| `pollSeconds` | `30` | 面板轮询间隔，由 Host 下发、面板跟随（不再硬编码 30s） |
| `allowedHosts` | — | 追加可信 `Host` 名（默认 `localhost` / `127.0.0.1` / `::1`，只增不替） |
| `tokenSkewSeconds` | `120` | 提前多久续期，避免撞过期边界 |
| `apiBase` | `https://token.sensenova.cn/v1` | 推理 API 源站（模型目录） |
| `iamBase` | `https://iam.sensecoreapi.cn` | 接受加密密码的 IAM 源站 |
| `tokenEndpoint` | `https://signin.sensecore.cn/oauth2/token` | Hydra 令牌端点 |
| `jwksEndpoint` | `https://signin.sensecore.cn/.well-known/jwks.json` | JWKS 文档（密码封包公钥） |
| `redirectUri` | 同 `consoleBase` | OAuth 注册回调；Hydra 精确匹配 |
| `clientId` | `nova` | 控制台公开 client id |
| `scope` | `openid offline offline_access` | `offline_access` 是拿到 refresh_token 的前提 |
| `encKeyId` | `public:hydra.openid.id-token` | 密码封包用的 JWKS key id |
| `maxHops` | `6` | 登录重定向链最大跳数 |
| `loginTimeoutMs` | `20000` | 登录流程单次请求超时；`requestTimeoutMs` 是它的旧名，仍然认 |
| `consoleTimeoutMs` | `15000` | 单次控制台请求超时（`pool-usage` / `models`） |

端点类字段仅在企业镜像 / 预发环境指向别的主机时才需要动；全部不配即等于平台默认值。任意端点覆盖若不是合法的 http(s) 绝对地址，插件在**挂载时**就报 `config_error`（面板顶部显示），而不是等到第一次轮询才变成莫名其妙的网络错误。

> 上表主机层字段的默认值（含 `allowedHosts` 的 `localhost`/`127.0.0.1`/`::1`）统一定义在 `index.js` 的 `CONFIG_DEFAULTS`，并由 `test/config.test.mjs` 与 `cordis.patch.yml` 双向钉住；auth 类字段留空即表示"使用平台默认"，其生效值定义在 `sensenova-auth.js` 的 `AUTH_DEFAULTS`，不在此重复。

---

## 4. 改动后必须重启 Host

**Host 半边（`index.js` / `token-store.js` / `sensenova-auth.js`）在启动时加载一次。** 改完这些文件，运行中的 `dsh web` 不会自动重载，必须完全退出 DSH 再启动（**托盘也要退**）。只改 `client.js` 时，浏览器刷新页面即可。

自查是否跑的是新代码——看快照接口的返回：

```powershell
(Invoke-RestMethod http://127.0.0.1:19387/api/dsh-connect-sensenova-token-plan/snapshot).auth
```

- 有 `auth` 字段 → 新代码在跑；
- 没有 `auth`、而是 `totals` / `recent` 之类 → **跑的还是旧代码**，需要重启。

> 注意本机可能同时存在多个 dsh 进程：桌面版（默认 19387）与 `dsh web`（常见 3080）用的是**不同的 profile**。确认你打开的 GUI 连的是哪一个。

---

## 5. 首次使用

1. 打开侧边栏「积分面板」。
2. 点「连接商汤控制台」，填一次账号与密码，点登录。
3. 之后令牌自动续期，无需再操作。面板底部可清除已保存账号。

登录失败的排查见 [AUTH.md](./AUTH.md)。

---

## 6. 常见信号与处置

| 面板 / 接口信号 | 含义 | 怎么做 |
|---|---|---|
| 面板顶部 `config_error` | 配置面有非法端点地址等挂载期错误 | 检查 `cordis.patch.yml` 的端点类字段（§3），改后重装 / 重载 Host |
| 快照带 `shapeWarnings` | 控制台返回结构与预期不符（如字段改名） | 对照 [SENSENOVA-API.md](./SENSENOVA-API.md) 核对接口字段——这是接口变更的第一信号，不是「暂无数据」 |
| 面板 `console_error` | 控制台没应答 | 通常是下一轮轮询自愈；持续出现再查网络与控制台状态 |
| 快照接口没有 `auth` 字段 | 跑的还是旧代码 | 完全退出 DSH（含托盘）再启动（见 §4） |
| 面板提示需要重新登录 | refresh_token 被吊销且环境已无密码 | 面板表单填一次账号密码即可 |
