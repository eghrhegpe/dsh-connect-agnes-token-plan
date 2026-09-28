# 架构（Architecture）

本仓库 `dsh-connect-sensenova-token-plan` 是 DeepSeek Harness 的一个**插件**，在 Harness Web UI 的侧边栏里提供商汤（SenseNova）控制台 Token Plan 的实时积分用量面板。它还**不是**一个独立可运行程序，而是挂在 Host（桌面版 / `dsh web`）里的一截逻辑。

本文讲清三件事：插件与 `upstream/` 的关系、插件内部的 Host/Client 分流、以及数据如何流动。

---

## 1. 双仓库关系：`dsh-connect-sensenova-token-plan` 与 `upstream/`

本仓库根目录下有一个 **被 `.gitignore` 忽略的 `upstream/`** 目录，它是从 `~/.dsh/fork/sensenova-usage-dashboard` 移入的**上游仓库**，自带独立的 `.git` 与 GitHub remote（`shaobingtongzhi/sensenova-usage-dashboard`）。

| 维度 | `dsh-connect-sensenova-token-plan`（本仓库） | `upstream/`（被忽略，独立仓库） |
|---|---|---|
| 形态 | DSH 插件（Host 半边 + Client 半边） | 独立 Python 桌面应用（pywebview 原生窗口） |
| 语言 | Node.js / JavaScript（无构建步骤） | Python（`dashboard.py` + `auth_login.py`） |
| 账号凭据 | 走 **DSH 凭据服务**（`~/.dsh/.credentials.yaml`），无明文文件 | 明文存 `accounts.json`（为支持自动重登） |
| 令牌续期 | **`refresh_token` 静默续期**，面板过期无需重启 | JWT 过期后用明文账号密码**重登** |
| 登录节流 | 区分时间型 / 凭据型拒绝，防锁号 | 仅基础重试 |
| 与控制台交互 | `pool-usage` / `credit-usage-trend` / `GET /v1/models` | 同样的 `pool-usage` 等接口 |
| 是否进本仓库历史 | 是（本仓库主开发目标） | **否**（gitignored，保持独立 git 历史与 remote） |

**为什么要这样放：** 上游 Python 工具是这套商汤控制台集成的「原始实现 / 参考源」，里面沉淀了接口字段、打包（`build_mac.sh` / PyInstaller `.spec`）、登录封包等可复用知识。把它以**被忽略的 `upstream/`** 形式容纳进本仓库，既能随时对照、复用其接口与打包经验，又不会污染本插件仓库的提交历史，也不会把明文凭据文件（`accounts.json`）带进版本库。插件在**构建期与运行期都不依赖 `upstream/`**——两者只是概念上的上下游，没有代码耦合。

> 若需向上游提交改动，进入 `upstream/` 目录本身就是一个完整 git 仓库，直接 `git` 操作即可，与外层仓库互不影响。

---

## 2. 插件内部结构：Host 半边 vs Client 半边

插件分两半，加载时机与改动代价完全不同：

| 半边 | 文件 | 加载时机 | 改动后如何生效 |
|---|---|---|---|
| **Host（服务端）** | `index.js`、`host-config.js`、`codes.js`、`token-store.js`、`throttle-store.js`、`sensenova-auth.js`、`sensenova-crypto.js`、`console-client.js`、`parsers.js`、`trace.js`、`util.js` | 启动时加载一次 | **必须完全退出 DSH（含托盘）再启动**，`dsh web` 不会热重载 |
| **Client（前端）** | `client.js` | 浏览器侧，随页面加载 | 浏览器刷新页面即可 |

- `index.js`：注册只读路由 `/api/dsh-connect-sensenova-token-plan/snapshot`（聚合控制台数据，401 自动续期重试一次）+ 账号配置路由。
- `host-config.js`：配置契约——`CONFIG_DEFAULTS`、`resolveSettings` / `resolveAuthOverrides`（含嵌套 `auth:` 块拒绝）、`isAdmitted` 同源闸、`hostName` 解析。
- `codes.js`：全部错误码与 IAM 平台原因码的唯一声明处。`sensenova-auth.js` 产出、`token-store.js` 判定是否 parked、`index.js` 判定是否属于「拿不到令牌」，三处都从这里取——新增一个平台原因只需改这一个文件。
- `token-store.js`：凭据服务里的令牌与账号存取、按期续期、401 拒绝记忆。
- `throttle-store.js`：登录节流状态，写在插件自己的状态文件（`$DSH_HOME/state/<plugin>/throttle.json`，原子写、0600），跨进程跨重启生效。
- `sensenova-auth.js`：OIDC 授权码流登录 + `refresh_token` 静默续期。
- `sensenova-crypto.js`：密码 JWE 封包（RSA-OAEP(SHA-1) + A256GCM）、PKCE 派生、JWT 解析、JWKS 缓存（由调用方持有、非模块级单例）。
- `console-client.js`：控制台与模型目录的网络请求，带短生命周期缓存与 single-flight（并发轮询只发一次请求）。
- `parsers.js`：响应解析层——字符串数值 / epoch 归一、`checkShape` 漂移检测、`parseTrend` 对 points 求和、`identifyVisionModel` 视觉模型识别。
- `trace.js`：登录 trace 落盘（成功/失败，值级脱敏，仅留最近 20 个，权限 0600）。
- `util.js`：共享工具函数（`str` / `num` / `obj` 等类型安全读取器）。
- `client.js`：侧边栏图标 + `main` 面板页 + 账号表单（React，纯主题令牌样式）。内部 `interpretSnapshot` 把 Host 的响应读成 `(data, error)` 对，再交给决策块。
- 测试基建：`client-surface.js` / `panel-decision.js` / `panel-render.js` —— 把 `client.js` 作为模块加载后物化 `panel` 测试面，供 `panel.test.mjs` / `render.test.mjs` 直接调用。不进运行时、不进 `files` 打包清单。

---

## 3. 数据流（轮询 → 快照 → 渲染）

```
[面板打开]
   │  每 30s（仅挂载时轮询，关闭即停）
   ▼
GET /api/dsh-connect-sensenova-token-plan/snapshot   ← Host 半边
   │  1) 检查令牌，临近过期或 401 时用 refresh_token 续期
   │  2) 调用控制台 pool-usage / credit-usage-trend / GET /v1/models
   │  3) 按 consoleBase 等配置聚合，Host 缓存 cacheSeconds 秒
   ▼
{snapshot}  ──HTTP 200，body 内 ok:true/false 区分成败──►
   │
   ▼
client.js: interpretSnapshot(body) → {data, error}
   │  error 携带 auth 块（含 needsAccount / retryAfterMs / needsUserAction）
   ▼
决策块（panel-decision.js 从同一模块取的 viewOf）决定渲染：
   - 有数据 → 积分池 / 每模型消耗
   - 需配置账号 → AccountForm（用户自己填一次）
   - config_error / console_error → 纯文本提示（登录解不了的问题：
     前者是配置写错，后者是控制台没应答，下一轮通常自愈）
```

关键点：**HTTP 永远 200**，成败靠 body 里的 `ok` 与 `code` 区分；`auth` 块会随失败一起下发，所以连不上控制台时面板也能说出「令牌是否能自愈」。

---

## 4. 登录与令牌生命周期

详见 [AUTH.md](./AUTH.md)。一句话版：

1. 用户首次在面板填一次账号密码，密码用平台 JWKS 公钥封成 JWE（RSA-OAEP + A256GCM），明文不上网。
2. 账号密码存入 DSH 凭据服务；之后**只靠 `refresh_token` 静默续期**，不再需要密码。
3. 令牌约 180 分钟有效，提前 `tokenSkewSeconds`（默认 120s）触发续期；控制台返回 401 时也会换新并重试一次。

---

## 5. 生态分工：插件只做信息，不做执行

本插件**不是**一个「商汤全家桶」。商汤集成在 DSH 生态里按故障域分三层，
本插件只占第一层；第二、三层各有专职项目，合并不成立（爆炸半径教训：
本插件曾是桌面端必需启动项，一次凭据事故炸过整机，见 PITFALLS §10）：

| 层 | 谁干 | 本插件的角色 |
|---|---|---|
| 额度 / 登录 / 模型清单 | **本插件** | 维持现状 |
| 「哪些模型能看图」的识别与信息下发 | **本插件（见 §5.1）** | 第一步算 `visionModels` 发进 `/snapshot`；第二步（opt-in）把清单写进**本插件自己的** settings row，供后续 LLM connect 插件读取 |
| 真把图喂给模型（视觉/绘图路由） | `dsh-media-skills` / `dsh-draw-router`（社区） | 不碰 |
| 429 自愈网关（多 Key 池化、AIMD 限速） | `st-rotator`（独立 Python 进程） | 不碰 |

本插件是机器里**唯一既知道本 Key 实际能调哪些模型、又常驻 DSH 里**的组件，
所以「大统一商汤全过程」统一的是**信息**（告诉 DSH 哪把模型能当 vision 用），
不是执行——喂图与网关代码一律不进本插件。

### 5.1 视觉能力：两步走（2026-09 决议）

痛点：用户在 DSH 设置里填入 `SENSENOVA_API_KEY` 后，模型卡片的「输入类型」
不会自动标记「图片」，Agent 不知道 `sensenova-6.8-flash-lite` 可当 vision
模型，填 key 不会自动打开看图。DSH 的 LLM 链路本身原生认图片输入
（deepseek provider 有 `maxImagesPerRequest`、图片 offload 一整套参数），
缺的只是「商汤这套餐里哪把模型能看图」这条结构化信息。

**第一步（本期，已完成）**：插件从 `GET /v1/models` 的 `catalogModels` 算出
`visionModels`（可看图模型清单），发进 `/snapshot`，面板加一行展示。
识别依据：**已确认（2026-09 拉真实响应）**——商汤 `/v1/models` 在**每个**模型
条目上都带结构化字段 `input_modalities`（字符串数组，如
`["text","image"]`）与 `output_modalities`，所以按字段判定：`"image"` 出现在
`input_modalities` 里即可看图；名字规律（`vl` / `vision`）仅作为「平台若某
天不返回模态字段」的兜底，并标 `source: "name"` 注明是按名字推断。实测：
`deepseek-v4-flash`、`glm-5.2`、`kimi-k3` 等 8 个模型 input 仅 `["text"]`；
`sensenova-6.8-flash-lite` input 为 `["text","image"]`（即可看图模型）；
`sensenova-u1-fast`、`sensenova-u1.5-lite` input 仅 `["text"]` 但 output 为
`["image"]`（出图模型，不是看图模型——只看 `input_modalities` 的判定天然
把它们排除，名字规律若只看 `-lite` 会误判，所以名字兜底里已删掉 `flash-lite`）。

另外，API key 的读取路径按 DSH 官方 provider 惯例改为**先经 credentials 服务
的参考层**（`ctx.get("credentials")?.resolve("SENSENOVA_API_KEY")`，对应
`~/.dsh/.credentials.yaml` 里用户级的 env 变量值），最后才回退 `process.env`。
旧代码只读 `process.env`，而很多机器（含本机）的 key 只存在 credentials 服务
里、`process.env` 里根本没有这条——所以旧版「读不到 key」并不等于「没有
key」，是读错了层。

**第二步（本期已实现，opt-in）**：把第一步算出的可看图模型清单写进
**本插件自己那一行 DSH settings**（`imageModelIds` / `visionModels`
两个字段，走 DSH 官方写路径
`settings.update(rowId, patch, revision)`），供后续
`dsh-provider-sensenova` 之类的 LLM connect 插件读取，从而让 DSH 的图片
offload 链路知道这把 Key 里哪些模型可以接图。

设计守口（对应 §5「只做信息、不做执行」）：
- **只写本插件自己的 row**，绝不碰其它 provider（trae / workbuddy 等）
  的 `imageModelIds` 格子——算错一份模型清单，最坏影响的是面板自己的
  一行字，不会波及 DSH 的模型路由。
- **默认关闭**（`writeImageModelIds: false`）。不显式打开时，这个插件
  仍然只是信息层；打开后，Host 在每次 catalog poll 算出 `visionModels`
  后会幂等地写回本 row（清单没变就不写，不刷 revision 计数）。
- 写入是**旁路增强**：被拒/无 settings 服务时只打日志，poll 照常应答，
  面板照常显示——写不写成功不影响读的那一半。

宿主机器 `~/.dsh/profiles/*/cordis.patch.yml` 里已有 `imageModelIds`
与 `imageOverrides` 实例（该路径在宿主 profile 目录，不在本仓库），
trae 源码注释「Provider API 不暴露模态元数据，image 输入靠显式
`imageModelIds` 声明」对商汤**不成立**：商汤已经暴露
`input_modalities`（见上），第二步只是把这份现成信息按 DSH 的
settings 写路径交出去，不做识别逻辑。

---

## 6. 与上游 Python 工具的差异（给移植 / 对照用）

- **凭据安全**：上游明文 `accounts.json`；本插件零明文、零调试日志，仅经 DSH 凭据服务。
- **续期策略**：上游过期即重登（依赖明文密码）；本插件 `refresh_token` 续期，密码可从环境变量删除。
- **节流**：本插件显式区分「时间型拒绝（锁号/限频）照单全收平台声明窗口」与「凭据型拒绝（错密码）绝不自动重试」，专门防锁号；上游无此分层。
- **接口知识可复用**：两方调用的 `pool-usage`、`credit-usage-trend`、JWT 解析逻辑一致，`upstream/` 的 `auth_login.py` 可作为登录封包与字段语义的对照参考。

---

## 7. 相关文档

- [SETUP.md](./SETUP.md) — 安装、配置、重启注意事项
- [AUTH.md](./AUTH.md) — 认证、续期、节流设计
- [API.md](./API.md) — 路由与控制台端点、配置字段
- [TESTING.md](./TESTING.md) — 测试体系与已知缺口
- [CONTRIBUTING.md](./CONTRIBUTING.md) — 提交约定与红线
