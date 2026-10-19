# 贡献约定（Contributing）

面向在本仓库提交改动的人。原则：Host 半边改动代价高、登录失败会锁号、凭据绝不能进版本库。

---

## 1. 提交信息风格

沿用现有历史的中文 `type:` 前缀：

- `feat:` 新能力
- `fix:` 修复
- 正文用中文说明「为什么」，而非「改了什么」（diff 自明）。

例：`fix: 被拒的登录不再自动重试，避免错密码把账号锁死`

---

## 2. 改动 Host 半边必须重启

Host 半边源码位于 `src/host/`（**模块清单以该目录为准**，不在本文件逐一枚举——本仓已有「套件数/模块清单只指事实源、不复制数字」的纪律，见 [CHANGELOG](../CHANGELOG.md) 0.4.3「文档与仓库纪律」），经 `npm run build` 构建为 `lib/index.js` 后在 Host 启动时加载一次，**改完须完全退出 DSH（含托盘）再启动**（重新构建产物）。只改 `src/client/*.ts` 时跑 `npm run build:client` 重建根 `client.js`、浏览器刷新即可。提交前用 [SETUP.md](./SETUP.md) §4 的自查确认跑的是新代码。

---

## 3. 测试先行

- 改动登录 / 续期 / 节流 / 路由 / 面板决策后，跑 `npm test`。
- 新增登录分支（新的拒绝类型、新的窗口读取）必须补 `agnes-auth.test.mjs` 或 `store.test.mjs`。
- 面板渲染决策改动后，`panel.test.mjs` 应同步（它通过 `client-surface.js` 把 `client.js` 作为模块加载、直接调用工厂物化出的 `panel` 测试面，不需手写副本，也没有字符串锚点）。若 `client.js` 的工厂不再导出 `panel` 测试面或改动了结构，`client-surface.js` 会**直接抛错**——更新它，别退回抠源码。
- 网络层一律打桩（假 Agnes 平台），登录只发一次明文 POST、密码仅内存使用，**绝不发往真平台**，也不依赖真实账号。

---

## 4. 红线：什么绝不进版本库

- **凭据**：`.env`、`.env.*`、`*.env` 已被忽略；账号与 access token 只经 DSH 凭据服务，不写文件、不写日志（Agnes 不发 refresh token，所以也没有这一项）。
- **`upstream/`**：已被 `.gitignore` 忽略。它是**参照件容器**——里面并排若干独立 git 仓库（各自 `cd` 进去就是一个完整仓库，可独立提交/推送）与本机快照（如桌面端 `app.asar` 解包、探测脚本）。容纳进本仓库只为本地对照，**不要 `git add upstream/`**，也不要把参照件里的明文凭据文件（如历史上游的 `accounts.json`）带进来。清单与纪律见 [REFERENCES.md](./REFERENCES.md)，容器姿势的来由见 [ARCHITECTURE.md](./ARCHITECTURE.md) §1。
- **运行时产物**：`*.log`、`logs/`、`tmp/`、`node_modules/`、`dist/`、`build/` 已忽略。
- **DSH 内部抽取物**：本仓库曾误把 `_asar_extract/`（Host 打包产物）提交进历史，应将其从跟踪中移除（见下方 §6），且不再 add。

---

## 5. 文档同步

逻辑改动若影响以下内容，同步更新 `docs/`：

- 路由 / 配置字段变化 → `API.md` / `SETUP.md`
- 登录 / 续期 / 节流变化 → `AUTH.md` / `AGNES-API.md`
- 结构或双仓库关系变化 → `ARCHITECTURE.md` / `DSH-PLUGIN.md`
- 测试套件或流程变化 → `TESTING.md`
- 新踩坑或修法 → `PITFALLS.md`
- 拍新裁定 / 改既有裁定 → 先在 [ADR.md](./ADR.md) 记一笔（日期 / 状态 / 取代链），再改现行正文；**现行正文不留「修订（日期）」式内联补丁**——`docs.test.mjs` 检查 `ARCHAEOLOGY` 为这条把关。
- 吸收准入门槛（[ADR.md](./ADR.md) ADR-005）→ 新能力动工前，先在 ROADMAP / ARCHITECTURE 写明它进哪个现有文件 / 分册；现有结构装不下，先出拆分蓝图（先例 [TOKEN-STORE-SPLIT.md](./TOKEN-STORE-SPLIT.md)）并冻结行为基线，再实现。
- **收敛判据的选型**（PITFALLS §40 的推广）→ 新增「记住上次做过什么、以决定这次要不要重做」的状态字段时，**判据必须取自事实，不得取自预测**：
  - ✅ **事实判据**：`state.registered === true`（由注册动作本身在成功路径写入）、`isFresh(stored)`（按令牌真实到期时间算）。它描述「内存里**真的**发生了什么」，因此**不可能与磁盘分叉**。
  - ❌ **预测判据**：`signature === catalogSignature(...)`（「这套目录我处理过了」）。它是一个**能被写歪的断言**：只要写盘失败而内存照走，它就开始描述一个磁盘上并不存在的世界，而它的唯一用途正是「相等就跳过」——于是永久跳过。
  - 判断方法：问「**这个字段的每一个写入点，是不是都与它描述的持久化动作同生共死？**」不是的话，就把权威挪到磁盘侧（写成功才推进），或至少让失败可见（留痕进 `doctor`）。检查见 `test/state-authority.test.mjs`。

根 `README.md` 保持为索引与快速上手，细节下沉到 `docs/`。

---

## 6. 仓库整洁（历史遗留清理）

本仓库曾把 DSH 的 `_asar_extract/`（asar 解包出的 Host 内部文件）误纳入 git 跟踪。这些不是本插件源码，且随版本变化会制造巨大 diff。建议将其从索引中移除（保留工作区文件、不再跟踪）：

```powershell
git rm -r --cached _asar_extract
# 然后确认 .gitignore 已忽略（或在 .gitignore 追加 _asar_extract/）
git commit -m "chore: stop tracking DSH internal _asar_extract dump"
```

> 此项属仓库整理，按需进行；与本插件功能无关。

---

## 7. 已知取舍

- **API key 的持久化与跨进程**
  `src/host/api-key-store.ts` 的 `resolveApiKey()` 按三级优先级读：先走 `ctx.credentials.resolve("AGNES_TOKEN_PLAN_API_KEY")`、再 memory 层、最后回退 `process.env`（`src/host/index.ts` 只是一行委托），
  与账号/密码腿（走 `ctx.credentials.modifyRecord`、kind=grant、跨重启、跨进程）的不对称已收口——
  凭据服务里的 key、memory 层的 key 与 env 里的 key 都能被读到。仍不对称的部分：API key 无写路径（不通过本插件修改），
  所以不给 `token-store.ts` 加 `modifyRecord`；`fetchModelCatalog` 只接字符串参数，不关心供方是谁。
  读 key 必须每次轮询时调用（凭据服务可能晚于插件挂载注册），不能在 `apply` 开头缓存。
