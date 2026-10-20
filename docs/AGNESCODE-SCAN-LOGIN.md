# AgnesCode 扫码登录（设备流）可行性

本文件回答一件事：**能否不依赖桌面 App，让 `agnescode` 提供方直接拿到同一份 JWT**。
答案是**能**，且**完整闭环已实测打通**（2026-10-20，真实扫码换出 access_token，见 §6）。
当前 `agnescode` 线只读桌面 App 的 os_crypt 会话文件
（Chromium os_crypt + DPAPI + AES-256-GCM，Windows-only）；扫码登录是获取**同一份
access_token** 的另一条路径，覆盖 macOS / Linux，且不需桌面 App。

- **状态**：可行性 + 闭环已实测确认（2026-10-20，无凭据探针，真实换出 JWT）。**已接入插件**
  （2026-10-20：`src/host/agnescode-login.ts` + 路由 `login` 分支 + 面板「扫码登录」按钮，见 §8）；
  真实凭据仍未入库、不进日志（红线①）。
- **探针**：`upstream/probe-login-flow.mjs`（`node probe-login-flow.mjs` 干跑；`--live` 真扫码）。
- **为什么值得**：见下文「跨平台收益」。**为什么慎做**：见「风险」。

---

## 1. 换 token 端点（关键事实）

**这是本项目此前一直找不到、导致整条链路断掉的那一格。**

```
POST {BFF}/api/v1/code/auth/exchange-code
Content-Type: application/json
origin: https://app.agnes-ai.cn      # cn 域；intl 用 app.agnes-ai.com
x-platform: 1

{
  "code":         "<回调里拿到的授权码>",
  "redirect_uri": "<发起时的 redirect_uri>",
  "state":        "<发起时的 state>",
  "client_id":    "agnes-code"
}
```

| 域 | BFF 前缀 | 登录页 |
|---|---|---|
| cn | `https://api-agnes-code.agnes-ai.cn` | `https://app.agnes-ai.cn/` |
| intl | `https://api-agnes-code.agnes-ai.com` | `https://app.agnes-ai.com/` |

**实测判据（为什么敢说它是真端点）**：用假 code 打过去，两端点都返回
`{"code":"010006","message":"Authorization code is invalid, expired, or already used"}`。
这个 `010006` 是**业务层**的「code 不对」，不是 `000501 Login expired`（那是 BFF 全局鉴权闸）。
请求穿过了闸、到达了处理逻辑——这就是换 token 端点。

成功响应形状（逆向件记录，见 §4；`code === 0` 或 `"000000"`）：

```json
{ "code": 0, "data": { "access_token": "<jwt>", "user_info": { "id": "…", "name": "…", "email": "…" } } }
```

### 为什么之前找不到

早期盲猜的是**标准 OAuth 路径**：`/v1/oauth/token`、`/v1/auth/token`、`/oauth/token`、
`/token`、`/login/token` 等。结果分两种，都判不了活：

- `/v1/...`（含 `grant_type=authorization_code` 表单 POST）→ **401 `000501 Login expired`**，
  是被 BFF 中间件挡，不是「端点不存在」也不是「code 不对」。
- 非 `/v1` 路径 → **404 `000201 Resource not found`**。

结论：换 token 端点在 `/v1` 的 allow-list 之外，路径是**业务自定义**的
`/api/v1/code/auth/exchange-code`。**教训：猜标准 OAuth 路径在这家 BFF 上必然撞墙。**

### 深链模式的实际签发入口（实测确认为关键路径）

`agnes_sdk.py` 里的**反向**端点是「已有 JWT → 再签发一个一次性授权码」：

```
POST {BFF}/api/v1/user/issue-authorization-code
Authorization: Bearer <已有 JWT>
body: { "redirect_uri": "agnes://auth/callback", "state": "…", "client_id": "agnes-code", "ttl_seconds": 60 }
```

**实测更正**：这不是「不需要」的备胎——它**正是深链模式的签发入口**。反查登录页 chunk
（`/_next/static/chunks/app/(auth)/login/page-*.js`）的 `S()` 函数：

```js
let i = await (0,N.a4)({ redirect_uri: t, state: e, client_id: s, ttl_seconds: 60 });
if ("000000" !== i.code) return { success: false, message: i.message || "Authorization failed" };
let a = i.data.code;        // 一次性授权码（60 秒 TTL）
if (n) { let s = await P(t, a, e); return { success: s, message: s ? undefined : "cliConnectFailed" } }
window.location.href = "".concat(t, "?code=").concat(encodeURIComponent(a), "&state=").concat(encodeURIComponent(e));
```

`N.a4` 就是这个端点。**流程是：用户在登录页完成登录 → 登录页拿已有 JWT 调
`issue-authorization-code` 签发一次性 code → 把 code 回传本地**。

---

## 2. 登录页（已实测）

- `GET https://app.agnes-ai.cn/login?client=agnes-code&redirect_uri=<uri>&state=<uuid>` → **HTTP 200**。
- 微信登录走**官方 SDK**：登录页动态加载
  `https://res.wx.qq.com/connect/zh_CN/htmledition/js/wxLogin.js`（微信开放平台「网站应用微信登录」）。
  **QR 由 AgnesCode 自己的 appid 生成**——第三方不需要注册微信开放平台 appid。
- `redirect_uri` 白名单（反查桌面包 main.js）：
  - client 必须是 `agnes-code` 或 `agnes-cli*`（AgnesCode 本身有 CLI 登录变体）。
  - `redirect_uri` 必须是 `agnes://auth/callback`，或**满足 localhost 回调**：
    `http:` 协议 + 主机 `127.0.0.1` 或 `[::1]` + **有端口** + 路径 `/auth/callback` +
    无 username / password / query / hash。

最后那条 localhost 白名单是整件事能落地的支点：**插件可以起本地临时 HTTP 服务器做回调，
不必注册 `agnes://` 协议、不必用 webview、不必拦截深链**。

---

## 3. 完整设备流（设计 + 实测修正）

**关键实测更正**：localhost 回调走的是 **POST JSON** 而非 GET query 跳转。登录页 chunk 里：

```js
async function P(e, t, s) {
  try {
    let n = await fetch(e, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: t, state: s }) });
    return !!(await n.json()).ok;
  } catch { return false; }
}
```

localhost 模式（`isLocalhostCallback(redirect_uri) === true`）下，登录页**不发 `window.location.href` 跳转**，
而是把 `{ code, state }` **POST** 回 `redirect_uri` 本身，并要求响应 JSON `{ ok: true }` 才算「已连接 CLI 终端」；
返回失败则显示 `cliConnectFailed`（"无法连接到 CLI 终端"）。非 localhost 的 `redirect_uri`
（如 `agnes://auth/callback`）才走 GET 跳转。

```
插件                                   浏览器                AgnesCode 后端
 │ 起 http server 绑 127.0.0.1:随机端口  │                       │
 │ state = randomUUID()                  │                       │
 │ ── 拼登录 URL ────────────────────────▶│                       │
 │                                        │ 用户扫微信 QR         │
 │                                        │ (wxLogin.js 官方 SDK) │
 │                                        │◀── 登录成功 ── app.agnes-ai.cn
 │                                        │ 登录页调 issue-authorization-code 签发一次性 code
 │                                        │──────────────────────▶│
 │                                        │◀── { code } ──────────│
 │                                        │ P() 发 OPTIONS 预检   │
 │◀── OPTIONS /auth/callback ──────────── │                       │
 │   回 204 + Access-Control-Allow-Origin │                       │
 │   (没有 CORS 头，POST 会被浏览器拦截) │                       │
 │                                        │ P() 发 POST JSON      │
 │◀── POST /auth/callback { code, state } │                       │
 │   校验 state === uuid（CSRF）          │                       │
 │   回 200 { ok:true }                  │                       │
 │   关闭 server                         │                       │
 │ ── POST {BFF}/api/v1/code/auth/exchange-code ─────────────────▶│
 │◀── { code:"000000", data:{ access_token } } ───────────────────│
 │   token → DSH 凭据服务（kind:"grant"）│                       │
```

本地回调端点的校验点：

- 只认路径 `/auth/callback`；
- `state` 必须等于插件生成的 `randomUUID()`，否则 400（CSRF 防护）；
- **必须响应 CORS 头**（`Access-Control-Allow-Origin` 等），否则跨域 POST 被浏览器拦；
- 拿到 `code` 后立即关服务器（一次性）；
- 整个扫码阶段加 5 分钟超时。

`redirect_uri` 在**发起与换 token 两步必须传同一个值**（都是 `http://127.0.0.1:<port>/auth/callback`），
因为后端校验的是这个白名单。

---

## 4. 事实来源与版本漂移

- 换 token 端点路径、请求体形状、成功响应形状来自 `upstream/AgnesCodeReverseEngineering/`：
  `acp_client.py:273-307`、`agnes_sdk.py:195-210`、`auth_flow_test.py:75-110`、`exchange_token.py`。
  **该逆向件基于 1.0.17**。
- 本机桌面包是 **1.0.68**（`upstream/AgnesCode-desktop-1.0.68/`）。在它的 `main.js` 里
  grep 不到 `code/auth/exchange-code` —— 说明**换 token 在渲染层远程加载的 web bundle**，
  桌面包里没有。所以 `main.js` 只能证明「登录是开窗加载网页 + OAuth code/state 回调」，
  不能证明端点路径。
- **判据**：端点以本段 `§1` 的**实测**为准（`010006` = 真端点），不是以逆向件的路径字符串为准。
  逆向件路径只提供了「往哪个方向找」的线索，实测确认了它还对。

---

## 5. 跨平台收益（为什么值得）

当前 `agnescode` 线 Windows-only，因为 os_crypt + DPAPI 是 Windows 专属，
且 macOS `state.vscdb` 采集路径未被探测（`docs/ROADMAP.md` §6.3 记录：
「macOS IDE variant reads state.vscdb (sqlite) and neither non-Windows crypto path
has been probed」）。扫码登录绕开本地加密存储：

- **macOS / Linux 都能用**，只需浏览器扫一次码；
- **不需装桌面 App**；
- 拿到的还是那份 `access_token`，与桌面线**同源**，BFF 调用契约不变。

这是把 `agnescode` 从「Windows-only 本机登录态采集」升级成「跨平台登录」的正路。

---

## 6. 实测验证（2026-10-20，闭环成功）

无凭据探针 `upstream/probe-login-flow.mjs --live` 完整跑通设备流：

1. 探针起 `http://127.0.0.1:<port>/auth/callback`，拼登录 URL，用浏览器打开；
2. 用户在登录页完成登录（账号已登录态，点「继续」即可）；
3. 登录页调 `issue-authorization-code` 签发一次性 code，POST 到本地；
4. 探针回 `{ ok: true }`，关服务器；
5. 探针 POST `{ code, redirect_uri, state, client_id }` 到 `exchange-code` →
   **HTTP 200 `{"code":"000000","message":"success"}`**；
6. 拿到 `access_token`（JWT），payload 字段：`sub`（用户 UUID）、`iat`、`nbf`、`exp`。
   **有效期约 28 天**（`exp - iat ≈ 2.43e6 秒`），与桌面线一致，无 refresh。

**实测踩到的两个坑**（均已写进探针，接入时必知）：

- **localhost 回调是 POST JSON 不是 GET query**。最初按 GET 写，登录页 POST 回来时探针
  返回 400 纯文本（非 `{ok:true}`），登录页判 `cliConnectFailed`。
- **必须回 CORS 头**。登录页（`https://app.agnes-ai.cn`）跨域 POST 到本地 `http`，
  浏览器先发 OPTIONS 预检；探针不回 `Access-Control-Allow-Origin`，POST 被浏览器直接拦，
  同样报 `cliConnectFailed`。

**CN 域状态**：`https://app.agnes-ai.cn/` 根路径实测返回 **HTTP 403 维护页**
（title「网站维护中」），但 `/login` 子路由正常 200，登录与换 token 全链路不受影响。
intl 域（`.com`）只有 Google / Apple 登录，无微信扫码，本次验证走 CN 域。

---

## 7. 风险（照实说）

1. **令牌仍约 28 天、无 refresh**。扫码不解决续期问题——用户每周期要再扫一次。
   （与桌面线一样，这是 AgnesCode 侧的设计，不是本插件能改的。）
2. **逆向商用产品实时登录流**。上游改 `redirect_uri` 白名单、换端点路径、或给 `agnes-cli*`
   之外的前缀收紧 client 校验，设备流即破。这是**持续维护负担**，不是一次写死。
3. **插件生命周期内要短暂开 localhost socket**（仅回调期间，收完即关）。
4. **token 落点**：必须进 DSH 凭据服务，`kind: "grant"`；token 永不落盘、不进日志。

---

## 8. 接入落地（2026-10-20，已接入插件）

闭环已实测通过（§6），工程化工作已落地：

- **host 登录模块**：`src/host/agnescode-login.ts` 实现设备流——`listenOnRandomPort` +
  `waitForCallback` + `openExternal` + `exchangeCodeForToken`。localhost 回调是 POST JSON
  `{ code, state }`（非 GET query），且必须回 CORS 头——实现与 `upstream/probe-login-flow.mjs`
  一致，并保留 GET 回退。
- **路由**：`POST /api/<panel>/agnescode { action: "login" }`（`src/host/routes/agnescode.ts`
  的 login 分支）：domain 白名单（cn / intl）+ 单飞（`agnescodeLoginInFlight`）+ 失败文本过
  `redactSecrets`（红线①）。
- **面板**：「AgnesCode」tab 的「扫码登录」按钮（跨平台，无需桌面 App；macOS / Linux 可用），
  与「检测本机登录态」（Windows-only）并列；登录期间按钮转「等待扫码」态，两按钮互相禁用。

- token 存凭据服务 `kind:"grant"`，复用现有 publisher / store / 凭据隔离。
- 登录 trace 必须过 `onTrace`（红线⑤）。
- 节流进 `throttle-store.ts` 迁移缝。
- 采集侧写权限仍为零——扫码只是换一条「拿 token」的入口，不改变「拿 token 之后」的一切边界。
- `openExternal` 在 Windows 上用 `rundll32 url.dll,FileProtocolHandler` 直接 CreateProcess 传 argv，
  不经 shell（URL 含 `&` 不会被拆成命令分隔符）。缺少浏览器二进制时，spawn 的**异步** `error`
  事件（ENOENT）经 Promise race fail-fast（`OPEN_EXTERNAL_GRACE_MS` 兜底），登录不会干等回调超时。
- 已知限制照旧：令牌仍约 28 天、无 refresh（见 §7）——扫码不解决续期，用户每周期需再扫一次。