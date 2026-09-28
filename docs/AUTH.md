# 认证设计（Auth）

面板显示的数据来自商汤控制台自己的 API；要调这些接口，必须持有控制台 JWT。JWT 只有约 **180 分钟**有效，本插件的设计目标是：**登录一次，之后全自动，且绝不让错密码把账号锁死。**

---

## 1. 认证模型概览

```
用户填账号密码 ──► Host 走 OIDC 授权码流（PKCE）
                         │
                         ├─ 密码用平台 JWKS 公钥封成 JWE（RSA-OAEP + A256GCM），明文不上网
                         │
                         ▼
                   DSH 凭据服务（~/.dsh/.credentials.yaml，仅本账户可读）
                         存：账号 + access_token + refresh_token
                         │
                         ▼
              此后只靠 refresh_token 静默续期，密码可从环境变量删除
```

- 也可以继续用环境变量 `SENSENOVA_USERNAME` / `SENSENOVA_PASSWORD`（旧配置照常有效），优先级**低于**面板里保存的账号。
- 密码只发往本机 Host，再由它加密送往商汤。没有 `.env`、没有重启、没有明文凭据文件。

---

## 2. OIDC 授权码流 + PKCE

`GET /api/.../account`（POST 账号）触发完整授权码流：

1. 生成 PKCE `code_verifier` / `code_challenge`（S256）。
2. 跳转授权端点（`consoleBase` + `/oauth2/auth`，`client_id=nova`）。
3. 跟随最多 `maxHops` 跳的重定向链到令牌端点。
4. 令牌端点用 `scope=openid offline offline_access` 换取 `access_token` + `refresh_token`（`offline_access` 是拿到 refresh_token 的前提）。

---

## 3. 密码 JWE 加密

账号密码不能明文发往 IAM。登录时用平台 JWKS 公钥（`jwksEndpoint`，key id = `encKeyId` 默认 `public:hydra.openid.id-token`）对密码做：

- **RSA-OAEP**（密钥封装，把一次性 CEK 包起来）
- **A256GCM**（内容加密，带 16 字节 GCM tag）

即标准的 `RSA-OAEP + A256GCM` JWE，与网页端一致；每次封包用全新 CEK / IV。明文密码不出现在请求里（封包后的密文出现在 IAM 调用上，并被标记为 `encrypted`）。

---

## 4. 凭据存储

账号、access/refresh token 只经 **DSH 凭据服务**写入 `~/.dsh/.credentials.yaml`，权限限制为仅本账户可读。本插件**不写任何明文凭据文件、也不写调试日志**。

没有凭据服务时（如某些 `dsh web` profile、或测试环境）：面板仍可打开，但账号只存**内存**（标记 `ephemeral`），重启后需重登——此时面板会明确提示，而不是假装已保存。

---

## 5. 静默续期

- 令牌在过期前 `tokenSkewSeconds`（默认 120s）触发续期。
- 控制台返回 **401** 时，也会用 `refresh_token` 换新并重试一次。
- 续期失败（refresh_token 被吊销）且环境已无密码时，面板明确提示需要重新登录，而不是静默显示旧数据。
- 续期状态写入凭据记录 `dsh-connect-sensenova-token-plan/sensenova-console`（含 `hasRefreshToken` / `expiresAt`）。

---

## 6. 登录节流（防锁号的核心）

平台在几次失败尝试后会**锁号**，所以插件**绝不在定时轮询里重发密码**。两类拒绝区别对待：

| 拒绝类型 | 平台返回 | 行为 |
|---|---|---|
| **时间型**（锁定、频率限制、平台故障） | 带等待窗口，或无窗口 | 等待窗口结束前直接失败，不发请求。平台声明的窗口**照单全收，绝不截短**（声明 2 小时就等满 2 小时）；无窗口时本地指数退避 60s → 2m → 4m … 上限 30 分钟。窗口一到恰好探测一次。 |
| **凭据型**（密码错误、需验证码） | `invalidAccountOrPassword` 等 | **完全不自动重试**——等待改变不了一个错密码。面板重新提示输入账号，只有用户主动提交才再试。 |

节流状态写在独立凭据记录 `dsh-connect-sensenova-token-plan/sensenova-console-throttle` 里，因此**跨进程、跨重启**都生效：另一个 Host 进程（桌面版 / `dsh web` 用不同 profile，但可能共用同一凭据目录）不会在等待期内继续敲门。窗口读取同时支持中英文（「try again after 8 minutes」与「请 8 分钟后重试」）以及 `Retry-After` 头。

---

## 7. 登录失败怎么办

- 表单下方显示商汤返回的原因（通常是「账号或密码不正确」）。
- 时间型拒绝：按钮变灰并展示平台声明的等待分钟数，等待期不自动重试。
- 凭据型拒绝：清空重填，只有你主动点「登录」才会再发一次——绝不让错密码被轮询反复发送导致锁号。
- 若 `refresh_token` 被吊销且密码已不在环境中，面板重新显示表单，此时填一次即可。

---

## 8. 清除账号

面板底部「连接商汤控制台」按钮里可清除已保存账号；当前令牌仍会继续用 `refresh_token` 续期，直到确实需要密码为止。清除只删账号引用，不删仍有效的令牌记录。
