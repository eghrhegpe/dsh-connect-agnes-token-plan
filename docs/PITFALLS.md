# 踩坑经历（Pitfalls）

把对接商汤控制台过程中真实踩过的坑记下来，按「现象 → 根因 → 修法」写。多数已写进代码，这里是为了**下次改的时候别再踩一遍**，也方便接手的人理解代码里那些「看起来多此一举」的防御。

---

## 1. 登录流必须从 console 源站发起，否则 CSRF cookie 取不到

- **现象**：授权码流走到回调时直接 `No CSRF value available in the session cookie`，流程死。
- **根因**：Hydra 的 CSRF cookie 绑定在**入口 host** 上。如果在 IAM 自己的源站（`iam.sensecoreapi.cn`）发起授权，回调时 cookie 不可达。
- **修法**：`AUTH_ENDPOINT` 强制为 `consoleOrigin + /oauth2/auth`（`https://platform.sensenova.cn/oauth2/auth`），IAM 登录请求才带 `origin`/`referer` 为 console 源站、并复用第 1 步收集到的 CSRF cookie。

---

## 2. 密码封包必须是 RSA-OAEP(SHA-1) + A256GCM

- **现象**：IAM 拒绝封包，登录失败。
- **根因**：平台用 `alg: RSA-OAEP`（即 OAEP over **SHA-1**）。用更「现代」的 `RSA-OAEP-256` IAM 直接拒。
- **修法**：`importKey` 时 `hash: "SHA-1"`；AAD 用 protected header 的 **base64url 段**（不是整段 JSON 文本），严格按 RFC 7516 §5.1 step 14。每次封包换新 CEK/IV。

---

## 3. 登录失败只读顶层 message，把锁号当密码错

- **现象**：账号被锁、被限频，面板却统一报「账号或密码不正确」，用户反复重试 → 锁死更严重。
- **根因**：IAM 返回 `google.rpc.Status` 信封，真正原因在 `details[].reason`，顶层 `message` 只是泛化的 `InvalidArgument`。
- **修法**：`rejectionCode()` 优先取 `details[].reason` 精确匹配（`invalidAccountOrPassword`/`accountLocked`/`tooManyAttempts`/`verificationRequired`…）， substring 扫描只作兜底，绝不伪造具体原因。

---

## 4. 401 不证明 token 过期，只是「被拒」

- **现象**：一次 401 后若直接甩掉 token 重登，会陷入刷新风暴或频繁登录。
- **根因**：401 可能来自并发 poll 各自持不同 token、或 refresh 还没轮换完。
- **修法**：401/403 时 `tokenStore.invalidate(token)` 标记该 token 被拒（有界集合，最多记最近 8 个），然后**只换新 token 重试一次**；重试仍拒才抛 `JWT_EXPIRED`。被拒 token 绝不再下发，避免 replay。

---

## 5. refresh_token 会被轮换，忽略新值下次就死

- **现象**：连续刷新后某次突然 `refresh_rejected`。
- **根因**：Hydra 每次刷新都发**新 refresh_token**，旧的直接失效。只拿 access_token 不存 refresh_token = 自毁。
- **修法**：每次 `refresh()` 都把返回的新 `refresh_token` 一并落库（`store(..., replacing)` 用 `modifyRecord` 串行化，避免多进程互踢）。

---

## 6. 自动重试把一次错密码变成锁号

- **现象**：面板开着过夜，错密码被每分钟重试，账号被锁。
- **根因**：平台几次失败就锁号；轮询里重发密码等于主动撞锁。
- **修法**：两类拒绝区别对待——
  - **时间型**（锁定/限频/故障）：等窗口；**平台声明窗口照单全收、绝不截断**（哪怕 2 小时），无窗口才本地指数退避 60s→2m→4m… 上限 30 分钟；窗口一到恰好探测一次。
  - **凭据型**（错密码/验证码）：**完全不自动重试**，面板请用户重填，只有用户主动提交才试。
  - 节流曾写进凭据服务（伪装成 `grant` 记录 + marker 字段），但凭据服务只认两种 kind，私有状态寄存在那里一条 typo 就会炸掉整台机器——现已迁到插件自己的状态文件（`throttle-store.js`，原子写），**跨进程跨重启**生效：另一个 Host 进程不会在等待期继续敲门。旧凭据记录地址仅作一次性迁移读取。

---

## 7. 把 `not_configured` 当拒绝，导致新装就「需用户操作」

- **现象**：全新安装、从未填过账号，面板却如临大敌地要用户「处理」。
- **根因**：`not_configured` 根本不是拒绝——是「还没配过」，从没发过请求，谈不上「避免重复」。
- **修法**：`CREDENTIAL_REFUSALS` 集合**不含** `not_configured`，也不写 throttle 记录；只有真正发过请求被拒才记录节流。

---

## 8. 改 Host 半边不重启，跑的一直是旧代码

- **现象**：改了 `index.js`/`token-store.js`/`sensenova-auth.js`，刷新面板没变化。
- **根因**：Host 半边只在启动时加载一次，`dsh web` 不热重载。
- **修法**：**完全退出 DSH（含托盘）再启动**。自查：`(Invoke-RestMethod .../snapshot).auth` 有 `auth` 字段 = 新代码；没有 = 旧代码。注意桌面版(19387)与 `dsh web`(常 3080) 是不同 profile。
- 只改 `client.js` 则浏览器刷新即可。

---

## 9. `_asar_extract/` 误入仓库污染提交

- **现象**：`git status` 一长串 `lib/main.js`、`renderer/*`、`welcome/*` 等 DSH 桌面应用内部文件。
- **根因**：有人把 `app.asar` 解包到插件目录并 `git add`，把 Harness 自身源码当插件代码提交了。
- **修法**：`git rm -r --cached _asar_extract` 停止跟踪（已做）。它不是本插件代码，且每次版本升级会产生几十万行 diff。

---

## 10. upstream 不该进本仓库历史 / 明文凭据

- **现象**：上游 Python 工具含 `accounts.json`（明文账号密码）和 `.workbuddy/`。
- **根因**：直接塞进插件仓库会污染历史、泄露凭据。
- **修法**：上游以**被忽略的 `upstream/`** 形式容纳（[shaobingtongzhi/sensenova-usage-dashboard](https://github.com/shaobingtongzhi/sensenova-usage-dashboard)，保留其独立 `.git` 与 remote——本地副本若丢 `.git`，`git clone` 该地址恢复），`.gitignore` 加 `/upstream/`，绝不 `git add upstream/`，也不碰它的 `accounts.json`。

---

## 11. 控制台数值字段是字符串，时间字段是 decimal 秒字符串

- **现象**：`limit`/`used` 直接当数字用得到 NaN；`reset_at` 显示成奇怪的大数。
- **根因**：控制台把数字**当字符串**返回，时间是 **epoch 秒的字符串**（不是毫秒）。
- **修法**：`credits()` 用 `Number()` 归一；`epochSeconds()` 转 `Number` 再 `Math.floor`，空/`0`/非法返回 `null`（避免把「无到期」误判成 1970 年）。

---

## 12. 形状漂移被读成「暂无数据」

- **现象**：平台改了返回字段，面板永远显示空。
- **根因**：解析器对缺失字段宽容，若顶层 key（`plan`/`pools`/`series`）改名，解析仍返回「能看懂的」，缺失部分静默消失。
- **修法**：`EXPECTED_SHAPES` 校验顶层 key，缺哪个就在快照里挂 `shapeWarnings`，面板顶部明示「接口缺字段 {api} {missing}」，而不是永远「暂无数据」。

---

## 13. 同源校验少一行，任意网页能往面板塞账号

- **现象**：潜在——任意站点可 POST 账号进用户面板。
- **根因**：snapshot/account 路由若不做 origin 校验，跨站请求可写账号。
- **修法**：`isAdmitted()`——带 `Origin` 的请求必须与 Host 同 host；`origin === "null"` 一律拒；无 `Origin` 的同源 GET 放行。account POST 还要校验 body ≤ 4KB、必须是对象（非数组/非 null）。

---

## 14. JWKS 缓存跨 tenant 复用会封错包

- **现象**：切到企业镜像/预发后密码封包用错公钥。
- **根因**：JWKS 缓存了上一个租户的密钥，新平台却用不同 key。
- **修法**：JWKS 缓存已从 `sensenova-auth.js` 迁到 `sensenova-crypto.js`，且**由调用方持有、非模块级单例**。`createAuth(overrides)` 每次在自带配置里挂一份独立缓存（`cfg.jwksCache = createJwksCache()`），`sealPassword(..., { cache })` 用它——所以两个实例即便指向**同一个** endpoint 也不共享密钥项；缓存内部再按 `jwksEndpoint` URL 分键，一个实例配多镜像也各归各。这一层之前只做了一半：auth 侧已 per-instance，crypto 侧仍是模块级 `Map`，跨实例照样串味，测试只能靠 `import("...?shape=…")` 重载整个模块来强制干净缓存。补全后该 hack 退休，`test/auth.test.mjs` §2b 直接钉住"复用/隔离/分键/两实例各自持有"四条语义。`forgetJwks()` 随模块级缓存一并删除（此前全仓零调用）。

---

## 15. 登录 trace 漏了脱敏 = 泄露密码/token

- **现象**：潜在——诊断文件里出现明文密码或 token。
- **根因**：每次登录都写 trace 便于「浏览器能用、面板不能」的对照排查，但若不过滤就泄密。
- **修法**：`sanitizeUrl`/`sanitizeBody` 把 `password`/`access_token`/`refresh_token`/`code`/`code_verifier`/`cookie` 等一律 `[REDACTED]`，trace 才落盘；文件权限 `0o600`，仅留最近 20 个。

---

## 16. 插件目录解析不到 Host 的 peer 依赖，provider 静默缺席

- **现象**：`registerProvider: true` 之后面板一直显示 provider 未注册，快照 `llm.providerError` 里是
  `Cannot find package '@earendil-works/pi-ai' imported from …/plugins/dsh-connect-sensenova-token-plan/llm-adapter.js`；
  而离线套件（连 `npm test` 全量）**全绿**，因为离线套件通过 `peer-roots.mjs` 从 Host 运行时就地解析 peer，
  走的不是插件自己的解析链。
- **根因**：`llm-adapter.js` 要 import Host 发行的三个 peer（`@earendil-works/pi-ai`、
  `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-llm-pi-ai`），而 Node 的裸模块解析是从**该文件所在目录**逐级向上找
  `node_modules`。npm 装进 profile 的插件（`profiles/web/node_modules/<name>` 是**真实目录**）会向上走到
  `profiles/node_modules`，那里有 Host 的 peer；开发期的 `~/.dsh/plugins/<name>` 是**符号链接/junction** 进
  profile 的，Node 默认把链接解成 realpath，于是解析链从插件目录向上只剩 `~/.dsh/plugins`、`~/.dsh`、`~`，
  一路都没有这些包。
- **修法**：三个 peer 进 `peerDependencies`（npm 安装时由 profile 侧提供）；开发检出要么用 plugin manager
  以真实目录安装，要么把这三个包链接进插件自己的 `node_modules`（与 `dsh-connect-qoder` 的开发检出做法一致，
  `test/peer-roots.mjs` 头部也记了这条 workaround）。失败时 Host 日志会同时打出 `ERR_MODULE_NOT_FOUND` 与这句
  提示——面板只报「provider 缺席」，日志才说得清是哪一层没解析到。e2e 现在开着 `registerProvider` 真跑一遍注册，
  这条漏洞不会再以「离线全绿」的形式溜过去。

---

## 17. e2e 继承了开发机的 `SENSENOVA_API_KEY`，测的不是干净安装

- **现象**：本机（shell 里设了 `SENSENOVA_API_KEY`）跑 e2e，「没有 Key 时目录不可用」这类断言失败；
  面板保存 Key 的请求返回 `ok:false`，错误是
  `credentials-local: "SENSENOVA_API_KEY" is supplied read-only by the launching environment`。
- **根因**：e2e 用 `{...process.env}` 拉起 Host，开发机环境里的 Key 就成了子进程的环境凭据；凭据服务把
  「来自启动环境」的值视为**只读**，于是插件既提前拿到了 Key（目录不再降级），又写不进新值。
  干净机器上这两条路径都看不见——测试因此只在作者机器上红，属于典型的「只是通常离线」。
- **修法**：`startHost()` 在 spawn 前删掉 `SENSENOVA_API_KEY`/`SENSENOVA_USERNAME`/`SENSENOVA_PASSWORD`
  （与离线套件的 `isolateHostEnv` 同一组名字），隔离从「另一个 `$DSH_HOME`」补齐到「另一份环境」。
  注意这也是**真实产品行为**的体现：用户的 Key 若来自启动环境，面板保存会被凭据服务拒绝，面板会照实显示该原因，
  此时清掉环境变量或改用它处提供的值即可——插件不会偷偷绕过只读引用。
