# 认证设计（Auth）

面板显示的数据来自 Agnes 控制台自己的 API；要调这些接口，必须持有控制台 access token。Agnes 的令牌**不发 refresh token**，所以本插件的设计目标是：**登录一次，之后全自动（失效就重登一次），且绝不让错密码把账号锁死。**

---

## 1. 认证模型概览

```
用户填账号密码 ──► Host 发一跳 POST {consoleBase}/api/user/login
                         │  {"username": ..., "password": ...}（明文 JSON，仅走 TLS）
                         ├─ 密码只在这一次请求的内存里存在，用完即弃，不落盘
                         │
                         ▼
                   DSH 凭据服务（~/.dsh/.credentials.yaml，仅本账户可读）
                         存：账号名 + access_token（记录 kind = grant）
                         │
                         ▼
              令牌过期 / 被控制台拒绝 ──► 用存下来的账号名 + 密码再登一次
              （Agnes 没有 refresh 端点，重登就是唯一的续期路径）
```

- **没有 OIDC**：Agnes 不提供 discovery 文档、`/oauth2/auth`、`/oauth2/token`，也没有 JWKS。登录就是一次账号密码 POST。
- **没有 refresh token**：`createAuth().refresh()` 永远抛 `NO_REFRESH_TOKEN`，这不是占位实现——`token-store` 正是**靠这个错误码**判断"该改走重登"，见 §5。
- **密码不落盘**：`AGNES_PASSWORD` 环境变量是它唯一的持久来源（显式 opt-in——放在环境里，令牌失效后可自动重登，无需再输一次）。账号名以面板保存的为准，环境变量兜底。

---

## 2. 一跳登录

`POST {consoleBase}{loginPath}`（`loginPath` 默认 `/api/user/login`）触发整个登录流程：

1. 请求头 `content-type: application/json`、`accept: application/json`、`x-user-language: zh-CN`（控制台前端自己发这个，跟着发不花代价）。
2. 请求体 `{"username": <邮箱>, "password": <密码>}`。**密码是明文 JSON**，过 TLS。
3. 成功：`200 {"code":200,"message":"ok","data":{"access_token":"...","user":{...}}}`。
4. 拒绝：`401 {"code":401,"message":"Invalid username or password","data":null}`。平台的 `message` 是唯一能解释原因的文本，插件**原样带上**，不替换成自己的码表。

`consoleOrigin` 取的是**后端源站**（`platform-backend.agnes-ai.cn`），不是控制台前端（`platform.agnes-ai.cn`）——前端源站的 `/api/*` 是 Next.js 的 404 外壳，打到那里会以"路径不对"的样子失败，而真实原因是"主机不对"。这是本模块最容易犯的一个错。

---

## 3. 密码为什么不加密

SenseNova 时代密码要走 JWE 封包（平台 JWKS 公钥 RSA-OAEP + A256GCM）。**Agnes 没有对应端点**：它没有 JWKS，也没有"接受密封密码"的接口，所以没有任何东西可以把密码包起来。于是**传输层就是唯一的保护**，这把「绝不持久化」从"整洁"变成了**承重设计**：

- 密码只在 `loginWith()` 这一次调用的内存里存在，不进入返回值、不进入 trace、不进入任何错误消息；
- 凭据服务里只写**账号名**（引用名 `AGNES_USERNAME`），密码引用（`AGNES_PASSWORD`）只在环境变量层被**读**，插件从不写它；
- 登录 trace 会落盘（见 §6），所以任何能进 trace 的东西等于被公开——新增输出点必须过同一套脱敏。

---

## 4. 凭据存储

账号名与 access token 只经 **DSH 凭据服务**写入 `~/.dsh/.credentials.yaml`，权限限制为仅本账户可读。

- 记录 kind **只能是 `grant`**：发明私有 kind 会让整份凭据文件对 Host 不可解析，而凭据服务是 required 依赖——**Host 直接起不来**。私有状态（节流）因此不进凭据服务，改存插件自己的状态文件（§7）。
- 令牌寿命优先读 JWT 自己的 `exp`；令牌不是可读 JWT 时回落到 `fallbackExpiresInSeconds`（默认 **604800 秒 / 7 天**）。方向是刻意的：**估短了**只会多花一次真实登录（Agnes 有失败次数锁定，多登不是免费的），**估长了**则由控制台的 401 自愈——401 会作废令牌并重登一次。拿不准就往长了估。
- 没有凭据服务时（如某些 `dsh web` profile、或测试环境）：面板仍可打开，但账号只存**内存**（标记 `ephemeral`），重启后需重登——此时面板会明确提示，而不是假装已保存。

---

## 5. 续期 = 重登

- 令牌在过期前 `tokenSkewSeconds`（默认 120s）触发续期。
- 续期走 `refresh()`，它**必然**抛 `NO_REFRESH_TOKEN`；`token-store/acquire.ts` 捕获该码（以及 `refresh_rejected`）后**落到密码重登**。所以"Agnes 不发 refresh token"这件事本身就是契约，store 不需要为它做任何特判。
- 控制台返回 **401 / 403**（HTTP 层或信封里的 `code`）时，同样作废当前令牌并重登一次。重试**只做一次、不递归**：刚换的令牌也被拒说明问题在账号，再试只会把账号敲锁。
- 重登需要密码。密码只可能来自环境变量 `AGNES_PASSWORD`；环境里没有、账号也已被清除时，面板明确提示需要重新登录，而不是静默显示旧数据。
- 面板能读到 `autoRecoverArmed`（环境里是否备着密码，**布尔值，不是值本身**），据此说明"令牌失效会自动重登"还是"需要你手动登一次"。

---

## 6. 登录 trace

**每一次登录尝试都会落盘，成功也算**——没有成功 trace，「浏览器能登、面板不能」就无法对照排查。

- 位置：`$DSH_HOME/logs/agnes-login-<时间戳>-<结果>.json`（`DSH_HOME` 默认 `~/.dsh`）。
- 内容：脱敏后的逐跳记录（步骤、方法、URL、掩码账号、状态码、分类码、平台原话截断 200 字符、令牌长度与是否 JWT）。**令牌值本身、密码、cookie 永不入 trace**。
- 失败时路径随账号路由的响应回到面板（`traceFile`），用户点一下就能把这段贴给支持。

---

## 7. 登录节流（防锁号的核心）

平台在几次失败尝试后会**锁号**，所以插件**绝不在定时轮询里重发密码**。两类拒绝区别对待：

| 拒绝类型 | 平台返回 | 行为 |
|---|---|---|
| **时间型**（锁定、频率限制、平台故障） | 带等待窗口，或无窗口 | 等待窗口结束前直接失败，不发请求。平台声明的窗口**照单全收，绝不截短**（声明 2 小时就等满 2 小时）；无窗口时本地指数退避 60s → 2m → 4m … 上限 30 分钟。窗口一到恰好探测一次。 |
| **凭据型**（密码错误、需验证码） | `Invalid username or password` 等 | **完全不自动重试**——等待改变不了一个错密码。面板重新提示输入账号，只有用户主动提交才再试。 |

分类由 `classifyLoginFailure(status, message)` 决定，**平台原话优先于状态码**：Agnes 对错密码回 401，但一个带 `invalid username or password` 的 400 是同一件事，不能被区别对待。落到 `CODE.LOGIN_REJECTED` / `ACCOUNT_LOCKED` / `RATE_LIMITED` / `VERIFICATION_REQUIRED` / `LOGIN_FAILED`。

节流状态写在**插件自己的状态文件**（`$DSH_HOME/state/<plugin>/throttle.json`，原子写、0600），因此**跨进程、跨重启**都生效：另一个 Host 进程（桌面版 / `dsh web` 用不同 profile，但可能共用同一 Home）不会在等待期内继续敲门。放在插件自己的文件里而不是凭据服务，是因为节流不是凭据，而凭据服务只认两种记录 kind——发明第三种会让整份凭据文件对 Host 不可解析（见 PITFALLS §6 与 `throttle-store.js` 头注）。旧版曾把节流伪装成 `grant` 记录（marker 字段 `THROTTLE_MARKER`）寄存在凭据服务里，该地址仅作**一次性迁移读取**，之后不再写入。窗口读取同时支持中英文（「try again after 8 minutes」与「请 8 分钟后重试」）以及 `Retry-After` 头。

注意**跨 profile 共享这条只对节流成立**：`catalog` / `provider` / `draw` 三份状态是 **per-profile** 的（`$DSH_HOME/state/<profile>/<name>/`，见 [PITFALLS.md](./PITFALLS.md) §23），与节流**故意相反**——它们答的是「这个 profile 要什么」，而节流答的是「上游要这台机器等多久」。别把两者"统一"成同一种粒度。

---

## 8. 登录失败怎么办

- 表单下方显示 Agnes 返回的原因（通常是「Invalid username or password」）。
- 时间型拒绝：按钮变灰并展示平台声明的等待分钟数，等待期不自动重试。
- 凭据型拒绝：清空重填，只有你主动点「登录」才会再发一次——绝不让错密码被轮询反复发送导致锁号。
- 若令牌被拒且密码已不在环境中，面板重新显示表单，此时填一次即可。
- 排查"浏览器能登、面板不能"：看 `$DSH_HOME/logs/` 里最新那份 trace（§6）。

---

## 9. 清除账号

面板底部「连接 Agnes 控制台」区卡里可清除已保存账号；当前令牌仍会继续用到过期为止（Agnes 没有 refresh token 可以吊销），到期后因为已无账号可重登，grant 会被回收，面板回到登录表单。

清除后到 grant 失效的这段**中间态**里，面板照常读额度，同时「连接 Agnes 控制台」区卡**保持常显**（无条件可见，不限登录态）——随时可重输账号把仍在有效的 grant 改指到新账号。
