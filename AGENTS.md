# AGENTS.md — AI 会话纪律

给 AI 协作会话的第一站。不重复 `docs/` 的内容，只钉死：**怎么验证、什么红线、去哪查**。
每次会话先读本文件；细节按下面的文档地图跳。

## 项目一句话

DSH 插件：从商汤 SenseNova 控制台 API 读 Token Plan 额度，渲染到 Harness Web 面板。
Host（Node/cordis）走完整 OIDC+PKCE 登录并自续期；Client（React bundle）轮询本地路由。

在web端、desktop搜索同类插件：`~/.dsh\profiles`

## 验证（按域裁剪，禁止无脑全量）

```bash
node test/auth.test.mjs     # 登录/PKCE/JWE/节流分类
node test/panel.test.mjs    # 面板决策、中英字典一致性
node test/parsers.test.mjs  # 响应解析层：字符串数值/epoch、shape 漂移、trend 求和
node test/e2e.mjs           # 端到端单独跑：拉起真 Host + 假平台，约 10 秒（需 dsh CLI）
npm test                    # 全量离线九套件 + 末尾 e2e-gate（探到 dsh CLI 才实跑 e2e，否则 SKIP）
```

- **e2e 已在 `npm test` 门禁里**（经 `test/e2e-gate.mjs`），但只在这台机器装了 dsh CLI 时才真跑；
  CI 里它是独立 best-effort job。手工排查用 `node test/e2e.mjs` 单跑即可。
- **e2e 只跑一次**。它要启动真实 Host 进程；需要看两段输出就跑一次落盘再读文件，
  不要把同一条命令串两遍。
- **peer 套件红 ≠ 回归**。`store/routes/wiring.test.mjs` 依赖
  `@deepseek-ai/dsh-credentials`（随 DSH runtime 发行，不在插件目录）。
  报 `cannot resolve the peer dependency` 是环境问题，先查 `test/peer-roots.mjs`
  的查找路径，再下结论。
- 测试数会随并行会话变化（68/38 是某一时点快照），只看自己域的增减。

## 红线（违反任一都会炸到用户机器）

1. **凭据不入库**：账号密码只进 DSH 凭据服务（`~/.dsh/.credentials.yaml`，owner-only），
   永不写入插件目录、永不进 git、永不进日志。登录 trace 已在 `sensenova-auth.js`
   内做值级脱敏（`code`/`code_verifier`/token/cookie），新增输出点必须过同一套
   `sanitize*`。
2. **credentials 记录只能是 `kind: "grant"`**。发明私有 kind 会让凭据文件对
   整个 Host 不可解析，而该服务是 required —— **Host 直接起不来**。私有状态
   **不进凭据服务**（节流等已迁到插件状态文件 `throttle-store.js`）；历史上寄
   存在凭据记录里的节流仅按 marker（`THROTTLE_MARKER`）做一次性迁移读取，别把
   它变回常驻地址。
3. **auth overrides 是 patch 行的顶层键**（`iamBase`、`tokenEndpoint`…），
   不是嵌套 `auth:` 块。嵌套会被静默忽略，面板拿着出厂默认值打到**真平台**——
   这条已经锁过一次号。`resolveAuthOverrides` 对嵌套块直接抛错，别放宽它。
4. **PKCE verifier 用 `Uint8Array` + 长度自检（43–128）**。`Buffer.from(Uint32Array)`
   按"每元素一字节"编码、静默截断——曾产出 11 字符 verifier，token 端点只回
   `invalid_grant`，hint 是唯一线索。`b64url` 对非 Uint8 视图已有补偿分支，别删。
5. **登录路径的每次尝试（成功也算）必须经 `onTrace` 落盘**。没有成功 trace，
   "浏览器能登、面板不能"就无法对照排查。
6. **密码必须走 JWE 封包**（平台 JWKS 公钥 RSA-OAEP + A256GCM），明文不上网；
   算法组合是平台钉死的，不是自由参数。

## 并行会话纪律

工作树常同时有**他人未提交改动**（多会话并行开发是常态）：

- **不碰 `git stash / push / pop`**（`list`/`show` 只读可用）。
- 路径限定提交，比如：`git commit -m "<说明>" -- <自己的文件…>`，
  禁 `git add -u` / `git add -A` 全量卷入。
- 提交后 `git status --short` 复核：没带走别人的东西。
- 看到非自己改动的文件处于 modified，**不要**替它做对照实验（stash 出基线），
  用 targeted 复跑（改前后各跑一次同一小组文件）定性。

## 去哪查（docs/ 地图）

| 何时 | 查 |
|---|---|
| 排查登录失败 / 改 PKCE、JWE、续期、节流 | `docs/AUTH.md` → `docs/SENSENOVA-API.md` |
| 理解 Host/Client 分流、双仓库关系 | `docs/ARCHITECTURE.md` |
| 加配置字段 / 改路由 | `docs/API.md`、`docs/SETUP.md` |
| 改测试前 | `docs/TESTING.md` |
| 改任何代码前扫一眼 | `docs/PITFALLS.md`（15 条现象→根因→修法） |
| 提交约定、`upstream/` 红线 | `docs/CONTRIBUTING.md` |

## 已知的真实坑（改前先看这里有没有）

- **e2e 曾跑完不退出**：成功路径没 `process.exit`，Host 子进程 stdio 管道吊住
  事件循环——所有 check 通过后仍挂几分钟，看起来像在干活。现已有显式退出 +
  看门狗（240s）+ 每请求 15s 超时，别拆。
- **假平台必须真校验**：`fake-platform.mjs` 的 token 端点要校验 PKCE（长度 +
  S256 匹配），`openSealed` 要读全 5 段 JWE。假平台不校验的每一环，
  都是 bug 直达用户的通道。
- **测试期望要对齐实现语义**：`parseTrend` 是对 points 求和，不是取首个。
