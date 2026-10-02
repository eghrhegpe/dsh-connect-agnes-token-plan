# AGENTS.md — AI 会话纪律

给 AI 协作会话的第一站。不重复 `docs/` 的内容，只钉死：**怎么验证、什么红线、去哪查**。
每次会话先读本文件；细节按下面的文档地图跳。

## 项目一句话

DSH 插件：从 Agnes 控制台 API 读 Token Plan 额度，渲染到 Harness **Plugins 页的插件卡**（三个 tab：积分额度 / 接入 API / AgnesCode）。算法参考历史上的游 `sensenova-usage-dashboard`（本地副本现已不在本机，恢复方式见 `docs/ARCHITECTURE.md` §1）；参照件容器 `upstream/` 的清单、版本与纪律见 `docs/REFERENCES.md`——**探测/参照产物一律落进 `upstream/`，绝不留在仓库根的未跟踪区**。
Host（Node/cordis）走**一跳**账号密码登录（`POST {consoleBase}/api/user/login`，无 OIDC / 无 refresh token，令牌死了就重登一次）；Client（React bundle）轮询本地路由。

**三条事实**（写代码前先认清你在动哪一条）：

1. 「积分额度」tab 是地基，走 Host 登录 + 自动重登，只读 Agnes 控制台（`platform-backend.agnes-ai.cn`）。
2. 「接入 API」tab 与出图工具会把本插件**升级为推理通道**——注册 provider `agnes-token-plan`、给 agent 挂 `agnes_draw_image`。它们都是 **opt-in 默认关**，任何失败必须降级为「面板照常用、该模块缺席」。
3. **「AgnesCode」tab 是桌面端上游**：接的是 AgnesCode 桌面端的登录态——本插件第一条**本机登录态采集**线（workbuddy 族先例）：微信登录发生在桌面 App 里，插件只读 App 的 os_crypt 加密会话文件（DPAPI + AES-GCM，注入式可离线测），provider `agnescode`，接口地址**按账号跟随**会话文件且钉死在 Agnes 域名族内。**它没有刷新端点（JWT 约 28 天）——这是已知限制，不是特性**：续期没有自动路径，必须用户手动重开桌面 App、再点「检测本机登录态」重新采集，约每 28 天一次；插件无法在后台自动续期。隔离纪律与主 provider 同款：两边 publisher、store、凭据引用全部隔离（见 `docs/ROADMAP.md` §6.3）。

**定位变更（2026-09-29）**：从「只做额度信息、n 个插件分散行动」转向**大统一——商汤全过程集成的单点入口**（额度 + provider + 出图路由对接 + 429 自愈（退避/分诊，不做多 Key 池），逐块 opt-in 吸收）。边界与三条不变量见 `docs/ARCHITECTURE.md` §5，同类插件核实事实见 §5.3；吸收路线图见 docs/ROADMAP.md，设计决策研究档案见 docs/IMPROVEMENTS.md。

在web端、desktop搜索同类插件：`~/.dsh/profiles`

```
@mars-sea/dsh-commandcode-provider
非官方 Command Code 提供方：实时模型目录、多账号轮换、用量面板与套餐配额面板。

@eghrhegpe/dsh-connect-qoder
将本机已登录的 Qoder（国内版 Qoder CN / 国际版 Qoder）模型接入 DeepSeek Harness —— bring locally signed-in Qoder models into DeepSeek Harness with zero configuration.


dsh-connect-trae
把本机登录的 Trae 模型接入 DeepSeek Harness：国内版与国际版双供应商并行，提供用量/积分概览与每日签到领取。


dsh-connect-workbuddy
把本机登录的 WorkBuddy 模型接入 DeepSeek Harness，并提供只读的积分概览与模型管理。
```

## 验证（按域裁剪，禁止无脑全量）

```bash
node test/agnes-auth.test.mjs  # 一跳登录/失败分类/重登/节流窗口解析
node test/store-baseline.test.mjs # token-store 全行为冻结基线：拆分/改动续期·节流·迁移前后必须零漂移
node test/panel.test.mjs    # 面板决策、中英字典一致性
node test/parsers.test.mjs  # 响应解析层：字符串数值/epoch/ISO、shape 漂移、分桶求和、四窗口
node test/switch-store.test.mjs # 四个 opt-in 开关商店跑同一份行为清单（含「继承后重开仍读得到」）
node test/docs.test.mjs  # 文档一致性：内部链接、跨文件表格去重、README 行数上限、教学快照、API 契约、考古纪律（ADR 账本）、peer 静态边界、活文档计数护栏（活文档不得写死会漂移的模块数/规模/行数）
node test/e2e.mjs           # 端到端单独跑：拉起真 Host + 假平台，约 10 秒（需 dsh CLI）
npm test                    # 全量离线测试门禁 + 末尾 build-gate + e2e-gate（套件清单与链以 package.json scripts.test 为准，不在本文件背书数字；各自探到 tsdown / dsh CLI 才实跑，否则 SKIP）
npm run build               # 改 src/（host 或 client）后必跑：重建 lib/ 与根 client.js（两者已 gitignore、不入 commit；build-gate 拦构建失败与产物缺失）
```

- **e2e 已在 `npm test` 门禁里**（经 `test/e2e-gate.mjs`），但只在这台机器装了 dsh CLI 时才真跑；
  CI 里它是独立 best-effort job。手工排查用 `node test/e2e.mjs` 单跑即可。
- **e2e 只跑一次**。它要启动真实 Host 进程；需要看两段输出就跑一次落盘再读文件，
  不要把同一条命令串两遍。
- **peer 套件红 ≠ 回归**。`store/routes/wiring.test.mjs` 依赖
  `@deepseek-ai/dsh-credentials`（随 DSH runtime 发行，不在插件目录）。
  报 `cannot resolve the peer dependency` 是环境问题，先查 `test/peer-roots.mjs`
  的查找路径（`$DSH_HOME` → 仓库 `node_modules` → `~/.dsh` 解包 runtime →
  全局 `dsh` CLI 的 runtime——最后一条是给 CI runner 用的，见 PITFALLS §32），再下结论。
- 测试数会随并行会话变化（68/38 是某一时点快照），只看自己域的增减。

## 评审纪律（锐评代码 / 给质量结论前）

先取证、后判决——修复阶段的证据闭环前移到评审阶段，别等用户问「属实吗」才核实。

- **量化断言必须可复现**：任何「多少个」先跑命令数出来，分子（命中问题的）与分母（全部候选）都写清。
  禁止凭印象报数：印象计数会把关键字总出现数当成问题数，分子分母都错、错一个数量级还不自知。
- **先读裁定，再读代码**：本仓多数「看起来怪」的写法在 PITFALLS / ADR / IMPROVEMENTS 有明文出处
  （例：`num()` 拒 0 服务红线⑦「不得计算剩余」、无 ESLint 是 tsc+门禁的刻意取舍）。定罪前先搜出处，
  有出处的是设计，不是缺陷。
- **每条问题先做一次无罪搜索**：判「吞错误」前先读 catch 上方注释是否在解释故意降级；
  判「缺某工具/能力」前先搜有没有「不引入」的裁定。
- **结论分四级**：实测属实 / 部分属实（标注数字或归因修正）/ 设计取舍（附文档行号）/ 无法证实。
  后两类不得包装成缺陷；没有测量支撑的分数不给——它只提供虚假的精确感。

## 红线（违反任一都会炸到用户机器）

1. **凭据不入库**：账号与 access token 只进 DSH 凭据服务（`~/.dsh/.credentials.yaml`，owner-only），
   永不写入插件目录、永不进 git、永不进日志；**密码不落盘**——仅登录瞬间内存使用，`AGNES_PASSWORD`
   环境变量是它唯一的持久来源（显式 opt-in，勿把密码写回凭据服务）。Agnes 没有 JWE 封包端点，
   密码是明文 JSON 过 TLS，**传输层就是唯一的保护**，所以「不落盘」是承重设计而非整洁。
   凭据防漏分两层：**登录 trace 靠「值不进 trace」**（只记 `maskUsername` 与形状事实），
   **错误文本靠 `redactSecrets()`**（`src/host/util.ts`，provider / 桌面端上游 / 路由三处必须过）。
   详见 `docs/PITFALLS.md` §15。
2. **credentials 记录只能是 `kind: "grant"`**。发明私有 kind 会让凭据文件对
   整个 Host 不可解析，而该服务是 required —— **Host 直接起不来**。私有状态
   **不进凭据服务**（节流等已迁到插件状态文件 `throttle-store.ts`）；历史上寄
   存在凭据记录里的节流仅按 marker（`THROTTLE_MARKER`）做一次性迁移读取，别把
   它变回常驻地址。
3. **auth overrides 是 patch 行的顶层键**（`loginPath`、`loginTimeoutMs`、
   `fallbackExpiresInSeconds`），不是嵌套 `auth:` 块。嵌套会被静默忽略，面板拿着
   出厂默认值打到**真平台**——这条已经锁过一次号。`resolveAuthOverrides` 对嵌套块
   直接抛错，别放宽它。
4. **`consoleOrigin` 必须是后端源站** `https://platform-backend.agnes-ai.cn`，不是控制台
   前端 `platform.agnes-ai.cn`。前端源站的 `/api/*` 是 Next.js 404 外壳，打到那里会以
   「路径不对」的样子失败，而真实原因是「主机不对」。`AUTH_DEFAULTS.consoleOrigin`
   是唯一出处，别在别处再写一遍字面量。
5. **登录路径的每次尝试（成功也算）必须经 `onTrace` 落盘**。没有成功 trace，
   "浏览器能登、面板不能"就无法对照排查。
6. **`/api/usage/overview` 必须保持唯一致命源**，series / subscription / plans 三个源必须保持
   **降级**（失败只写 `quota.error`）。面板的 `needsSetup` 判定是
   `data === null && !FORM_EXCLUDED_CODES.has(code)`——把图表源也做成致命，会让「图表挂了」
   变成「要你重登」，而重登解决不了它。
7. **不得计算「剩余」**：平台只给上限与**累计**用量，两者周期不同，`limit − total` 是个没人能
   负责的数。同理 `unavailableModelIds` 恒为空是**设计**而非遗漏——Agnes 没有按模型配额，
   账号级额度不足必须在面板**明说**，而不是静默把模型从选择器摘掉。

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
| 排查登录失败 / 改一跳登录、失败分类、重登、节流 | `docs/AUTH.md` → `docs/AGNES-API.md` §1–§2 |
| 动桌面端上游（AgnesCode / `agnescode`） | `docs/ROADMAP.md` §6.3（契约探针 + 隔离裁定）→ `src/host/agnescode*.ts` |
| 给用户看的文案（README / `cordis.patch.yml`）改了 | `test/docs.test.mjs` 检查 `README_TABS`/`SELF_DESCRIPTION`（tab 全覆盖 + 槽位一致），两者都进 npm 包 |
| 理解 Host/Client 分流、双仓库关系 | `docs/ARCHITECTURE.md` |
| 拍/改裁定、回溯边界与定位沿革（现行表述 vs 历史依据） | `docs/ADR.md`（决策账本；取代关系与举证链在此，现行规则见 `docs/ARCHITECTURE.md` §5）；**现行正文禁内联「修订（日期）」补丁**，`docs.test.mjs` 检查 `ARCHAEOLOGY` 把关 |
| 加配置字段 / 改路由 | `docs/API.md`、`docs/SETUP.md`；提供方开关见 `docs/PROVIDER-HOT-RELOAD.md` |
| 接/改 LLM provider（descriptor、`maxTokens`、注册三件套、adapter 组装） | `docs/DSH-LLM-DEVELOP.md`（peer 分工 → 注册 → descriptor 契约 → 探针纪律 → 排查速查） |
| 改测试前 | `docs/TESTING.md` |
| 改任何代码前扫一眼 | `docs/PITFALLS.md`（41 条现象→根因→修法） |
| 查某条事实「当初从哪来」 / 要落盘新参照件 | `docs/REFERENCES.md`（`upstream/` 容器清单：来源 / 版本 / 许可 / 承重在哪） |
| 排查「这条配置到底生效没」 / 改了源码却没变 | `docs/PITFALLS.md` §22（bundles 装载 → patch overlay → `$DSH_HOME/state/<profile>/<name>/` 三层，desktop 是安装副本、web 是 symlink） |
| 加/改 **state 文件**、读 `profileContext`、判断某状态该不该按 profile 分段 | `docs/PITFALLS.md` §23（catalog/provider/draw 分段；throttle 与凭据 grant **故意共享**，别统一） |
| 提交约定、`upstream/` 红线 | `docs/CONTRIBUTING.md` |

## 已知的真实坑（改前先看这里有没有）

- **e2e 曾跑完不退出**：成功路径没 `process.exit`，Host 子进程 stdio 管道吊住
  事件循环——所有 check 通过后仍挂几分钟，看起来像在干活。现已有显式退出 +
  看门狗（240s）+ 每请求 15s 超时，别拆。
- **假平台必须真校验**：`fake-platform.mjs` 的三条控制台路由只接受它自己签发的
  那枚 token（否则 401 + 信封 `code:401`），`/api/usage/series` 会记下收到的查询串
  供断言（窗口必须是**日期**）。假平台不校验的每一环，都是 bug 直达用户的通道。
- **测试期望要对齐实现语义**：`parseUsageSeries` 是对**跨桶**求和（每桶就是一行，
  不按模型归并），且会把桶按时间序排好——假平台故意倒序下发就是为了让排序失效能被抓到。
