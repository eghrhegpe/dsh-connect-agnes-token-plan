# 接口与端点（API）

分两层：本插件向 Harness Web UI 暴露的**本地路由**，以及它反向调用**商汤控制台**的接口。

---

## 1. 本插件路由（Host 半边注册）

两条路由都经过**同源校验**：带 `Origin` 的请求必须与 Host 同源，因此只有本机 DSH 自己提供的页面能写入账号。请求体上限 **4 KB**。

### `GET /api/dsh-connect-sensenova-token-plan/snapshot`
面板轮询的聚合结果。返回体（HTTP 恒为 200，成败靠 body 区分）：

```jsonc
{
  "ok": true,
  "now": 1790529234603,
  "consoleBase": "https://platform.sensenova.cn",
  "cacheSeconds": 60,
  "pollSeconds": 30,
  "auth": {
    "configured": true, "hasAccount": true, "hasRefreshToken": true,
    "needsAccount": false, "ephemeral": false,
    "retryAfterMs": null, "needsUserAction": false,
    "expiresAt": 1790529234603, "error": null
  },
  "catalogAvailable": true,
  "catalogModels": ["sensenova-6.8-flash-lite", "..."],
  "visionModels": [/* 可看图模型（仅 catalogAvailable 时返回，否则省略） */],
  "pools": { "plan": {...}, "pools": [/* 每池 5h/7d 窗口、返赠、callableModels / lockedModels */] },
  "trend": { "hours": 24, "models": [/* 每模型消耗 */] },
  "uncountedModels": [/* 在模型目录但不在任何池中的模型 */],
  "shapeWarnings": [/* 控制台返回结构与预期不符时非空 */]
}
```

- `ok:false` 时 body 带 `code`（`not_configured` / `jwt_expired` / `auth_error` / `config_error` / `account_locked` 等）与 `auth` 块。
- Host 内部：临近过期或收到 401 时自动用 `refresh_token` 续期并重试一次。
- `shapeWarnings` 非空说明控制台字段可能改名，面板会明说而非永远「暂无数据」。

### `GET /api/dsh-connect-sensenova-token-plan/account`
返回账号状态（**不含密码**）：`configured` / `hasAccount` / `hasRefreshToken` / `ephemeral` 等。

### `POST /api/dsh-connect-sensenova-token-plan/account`
两种用途，靠 body 区分：

- 保存账号：`{ "username": "...", "password": "..." }` —— 触发 OIDC 登录并落库。
- 清除账号：`{ "forget": true }` —— 仅删账号引用，保留仍有效的令牌。

非法 body（非对象、JSON 数组、超 4 KB）返回 400；跨域 POST 返回 403 且不写入任何账号。

---

## 2. 商汤控制台接口（插件反向调用）

| 接口 | 方法 | 用途 | 认证 |
|---|---|---|---|
| `https://platform.sensenova.cn/lite/console/v1/tokenplan/pool-usage` | GET | 各积分池 5h / 7d 窗口、返赠余额与到期 | `Bearer <JWT>` |
| `credit-usage-trend`（同前缀） | GET | 近 N 小时每模型积分消耗 | `Bearer <JWT>` |
| `GET https://token.sensenova.cn/v1/models` | GET | 套餐覆盖模型里本 Key 真正能调哪些（只读、不计费、不占推理额度） | `Bearer <SENSENOVA_API_KEY>` |

池返回结构含 `name`、`model_ids`、`window_5h` / `window_7d`（各带 `limit` / `used` / `remaining` / `reset_at`）、`grant_balance`、`nearest_grant_expiry`、`pool_type`（default / dedicated）。额度数值完全来自控制台 API，插件不做任何推算。

登录相关端点见 [AUTH.md](./AUTH.md)：授权端点（`consoleBase` + `/oauth2/auth`）、令牌端点（`tokenEndpoint`）、JWKS（`jwksEndpoint`）、IAM（`iamBase`）。

---

## 3. 配置端点清单（cordis.patch.yml）

完整字段与默认值见 [SETUP.md](./SETUP.md) §3。端点类字段（`consoleBase` / `apiBase` / `iamBase` / `tokenEndpoint` / `jwksEndpoint` / `redirectUri`）仅在企业镜像或预发环境指向别的主机时才需改动；任意非法 http(s) 绝对地址会在挂载时报 `config_error`。
