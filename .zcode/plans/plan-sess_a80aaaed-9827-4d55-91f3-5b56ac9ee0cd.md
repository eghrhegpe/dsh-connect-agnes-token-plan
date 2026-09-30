## 目标

把面板从「七卡平铺」改为两个 tab：**积分额度**（日常阅读）与**接入 API**（配置维护），由 `PanelPage` 内部状态切换，轮询/决策逻辑不动。

## 改动点

### 1. `src/client/panel-page.ts`（主体）
- 顶栏下方新增 tab 栏，`useState<"quota"|"api">("quota")` 记录激活页；渲染时只挂载当前 tab 的内容（轮询 effect 在 `PanelPage` 顶层，不受切换影响，无需改）。
- **积分额度 tab**：shape 漂移横幅、`section.pools` 卡（含 PoolExhaustionNotice、PoolCard 网格、uncounted/vision 行）、`section.trend` 卡、底部 `note`、以及 `authManage` 时的「连接商汤控制台」折叠卡（账号管理属于账号主题）。
- **接入 API tab**：`llm.title`（ApiKeyForm）、`llm.providerTitle`（ProviderForm + ModelPicker）、`draw.title`（DrawSwitch）三张折叠卡。
- 未登录全页 AccountForm 分支、加载/错误分支不动（tab 栏只在 `data` 有值时渲染）。
- `openSections` 折叠状态保留；切 tab 重新挂载会恢复默认展开/收起，可接受（或把 state 提到 tab 外，见第 3 点取舍——默认实现保持简单，不提升）。

### 2. `src/client/styles.ts`
- 新增 `tabBar`（flex 行、底部分隔）、`tab`（次要色文字按钮）、`tabActive`（主色 + 底部 2px 指示条），沿用现有 `--dsw-alias-*` 变量风格。

### 3. `src/client/i18n.ts`
- 新增键 `tab.quota`（中「积分额度」/ 英 "Quota & Usage"）、`tab.api`（中「接入 API」/ 英 "API Integration"）。中英字典必须成对，`test/panel.test.mjs` F3 有中英一致性断言。

### 4. 测试与文档
- `test/panel.test.mjs` / `test/render.test.mjs` 现有断言不依赖布局顺序，预期零改动；为 tab 切换补一条轻量断言（渲染 `PanelPage` 时 `tab.quota` 文案出现且默认不含 `llm.title` 卡）——若 render 测试基建挂载整页困难，则退而只加 i18n 键一致性（自动覆盖）。
- 跑 `npm run build`（src/client 改了，必须重建 lib/ 与根 client.js）+ `node test/panel.test.mjs` + `node test/render.test.mjs` + `node test/docs.test.mjs`。
- `docs/API.md` 若描述面板结构则同步一句（改动仅前端布局，Host 路由不变，预计只字级调整或不改）。

## 不做
- 不动 Host 路由 / snapshot 结构、不合并三张 API 卡为一张（保持每卡一关注点，只换容器层级）、不修上次锐评里的精度/limit≤0 问题（可另开任务）。