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
| **Host（服务端）** | `index.js`、`token-store.js`、`sensenova-auth.js` | 启动时加载一次 | **必须完全退出 DSH（含托盘）再启动**，`dsh web` 不会热重载 |
| **Client（前端）** | `client.js`、`panel-decision.js` | 浏览器侧，随页面加载 | 浏览器刷新页面即可 |

- `index.js`：注册只读路由 `/api/dsh-connect-sensenova-token-plan/snapshot`（聚合控制台数据，401 自动续期重试一次）+ 账号配置路由。
- `codes.js`：全部错误码与 IAM 平台原因码的唯一声明处。`sensenova-auth.js` 产出、`token-store.js` 判定是否 parked、`index.js` 判定是否属于「拿不到令牌」，三处都从这里取——新增一个平台原因只需改这一个文件。
- `token-store.js`：凭据服务里的令牌与账号存取、按期续期、401 拒绝记忆。
- `sensenova-auth.js`：OIDC 授权码流登录 + `refresh_token` 静默续期。
- `client.js`：侧边栏图标 + `main` 面板页 + 账号表单（React，纯主题令牌样式）。内部 `interpretSnapshot` 把 Host 的响应读成 `(data, error)` 对，再交给决策块。
- `panel-decision.js`：把 `client.js` **作为模块加载**（经 `client-surface.js` 的捕获型 `__ModuleLoader__` + 记录型 React 替身），取工厂物化出的 `panel` 测试面（决策、字典、错误码表）在 Node 里直接调用——不是手写副本、也不抠源码字符串，用于测试。

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
| 「哪些模型能看图」的识别与信息下发 | **本插件（扩展中，见 §5.1）** | 算 `visionModels` 发进 `/snapshot`；后续写 `imageModelIds` 进 provider settings |
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

**第一步（本期）**：插件从 `GET /v1/models` 的 `catalogModels` 算出
`visionModels`（可看图模型清单），发进 `/snapshot`，面板加一行展示。
识别依据：若 `/v1/models` 返回含 `input_modalities` 类结构化字段则按字段；
否则按模型名规律（`flash-lite` / `vl` / `vision`）兜底，并在面板标注
「按名字推断」。字段尚未确认（见 TESTING.md 已知缺口：需经插件诊断端点
或用户提供 key 拉一次真实响应；注意外部命令拿不到 DSH Host 进程注入的
env，只能走插件侧）。

**第二步（下期，单独验收）**：把识别结果写进 DSH provider settings 的
`imageModelIds`（对齐 `dsh-connect-trae` / `dsh-connect-workbuddy` /
`llm-qoder` 的 connect 家族设计；`profiles/*/cordis.patch.yml` 里已有
`imageModelIds` 与 `imageOverrides` 实例，trae 源码注释亦声明「Provider API
不暴露模态元数据，image 输入靠显式 `imageModelIds` 声明」）。写入属 DSH
行为面，风险高于第一步，故不合并验收。

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
