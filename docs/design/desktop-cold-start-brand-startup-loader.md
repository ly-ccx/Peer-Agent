# 桌面端冷启动慢（BrandStartupLoader 停留过久）调查结论

> 调查范围：原因与证据梳理。  
> **落地状态（2026-07-18）**：下列冷启动优化已在 `peer_agent` 实现并通过 conversation-store 测试。  
> 代码仓库：`peer_agent`（桌面端 `apps/desktop`）  
> 调查日期：2026-07-18  
> 本机数据样本：`~/.peer-agent/conversations` 约 239 条会话索引 / 约 580MB 会话文件  
> 说明：Goal 写边界在代码仓库；本文件为正式结论文档。若需同步到 `peer-knowledge/knowledge/experience/`，可另拷一份。

## 1. 用户可感知现象

冷启动后渲染层长时间停在 `BrandStartupLoader` 品牌启动页，主界面（会话侧栏 + 聊天区）迟迟不出现。

门闩条件（证据）：

- `apps/desktop/renderer/src/App.tsx`：`!session && !initError` 时渲染 `BrandStartupLoader`
- `session` 来自 `useDesktopBootstrap()`；只有 bootstrap + workspace 预加载完成后才 `setSession(...)`

因此：**启动页停留时间 = 主进程就绪到窗口加载 + bootstrap/预加载整条链路完成时间**，不是单纯动画时长。

## 2. 冷启动关键路径（按时间顺序）

```text
Electron main 模块加载
  → app.whenReady()
      → createSkillStore(...)
      → await createShellEnvSnapshot()          # 阻塞 createWindow
      → createLocalToolHost / 注册 IPC
      → createWindow() + quickChat prewarm
  → Renderer 加载 App
      → BrandStartupLoader（session == null）
      → useDesktopBootstrap.loadBootstrap()
          1) clientApi.getBootstrap()          # bootstrap:get
          2) clientApi.workspaceList()         # workspace:list（会 listConversations 全量）
          3) Promise.all(
               workspaceInfo(activeWorkspace),  # workspace:info → readProjectIndex
               conversationsList({workspacePath}) # 再 listConversations 全量
             )
          4) setSession(...)                   # 离开启动页
```

关键代码：

| 阶段 | 路径 |
| --- | --- |
| 启动页门闩 | `apps/desktop/renderer/src/App.tsx` |
| 启动预加载 | `apps/desktop/renderer/src/app/state/useDesktopBootstrap.ts` |
| whenReady / shell 快照 | `apps/desktop/electron/main/main.mjs`（`await createShellEnvSnapshot()`） |
| shell 快照实现 | `apps/desktop/electron/main/runtime-gateway/shell-env-snapshot.mjs` |
| bootstrap:get | `apps/desktop/electron/main/main.mjs` `ipcMain.handle('bootstrap:get', ...)` |
| 项目索引 | `apps/desktop/electron/main/project-index.mjs` |
| 会话列表 | `packages/conversation-store/src/index.mjs` `listConversations` / `listConversationsByWorkspace` |
| workspace:list | `apps/desktop/electron/main/main.mjs` `ipcMain.handle('workspace:list', ...)` |

## 3. 按关键路径排序的主因

> 关键路径主因（按阻塞离开 BrandStartupLoader 的严重程度排序）：

### 主因 1（最高）：会话列表为算 `messageCount` 全量读每个会话 jsonl，且启动路径触发两次

**机制**

- `listConversations()` 对 index 中每条 meta：`readJsonl(convFile(id))` 后只取 `msgs.length` 作为 `messageCount`
- `listConversationsByWorkspace()` **不会**按 workspace 先过滤再读文件，而是先完整 `listConversations()` 再 filter
- 冷启动预加载：
  1. `workspace:list` 为发现历史 workspace，调用 `conversationStore.listConversations()`（第 1 次全量）
  2. `conversations:list` / `listConversationsByWorkspace(activeWorkspace)` 再全量一次（第 2 次）
- 且 `setSession` 放在这两步之后，因此 **这两次 I/O 直接计入启动页停留时间**

**本机实测（2026-07-18）**

| 指标 | 数值 |
| --- | --- |
| 会话目录 | `~/.peer-agent/conversations` |
| 文件数 / 体积 | 273 文件 / 约 594284 KB（~580MB） |
| index 行数 | 239 |
| 单次 `listConversations` | ~1220–1230 ms |
| `listConversations` + `listConversationsByWorkspace` 串行 | ~2419 ms |
| 最大单会话文件 | ~25MB 级 jsonl |

**证据路径**

- `packages/conversation-store/src/index.mjs`：`listConversations` / `listConversationsByWorkspace`
- `apps/desktop/electron/main/main.mjs`：`workspace:list`、`conversations:list`
- `apps/desktop/renderer/src/app/state/useDesktopBootstrap.ts`：预加载顺序

**为何是主因**

- 成本随本地历史会话体积线性放大（重度用户最痛）
- 同一冷启动路径重复做两次
- 与离开启动页的门闩硬耦合

---

### 主因 2：渲染层把「可选预加载」绑在 session 门闩上

**机制**

- `App` 只看 `session` 是否非空决定是否离开 `BrandStartupLoader`
- `useDesktopBootstrap` 在 `getBootstrap()` 成功后，**仍等待** `workspaceList` + `workspaceInfo` + `conversationsList` 完成才 `setSession`
- 预加载失败时 catch 后仍会 setSession；**慢成功路径**不会提前放行

**证据路径**

- `apps/desktop/renderer/src/App.tsx`：`{!session && !initError ? <BrandStartupLoader /> : null}`
- `apps/desktop/renderer/src/app/state/useDesktopBootstrap.ts`：`loadBootstrap` 内 setSession 位置

**影响**

- 即便 bootstrap 本身已返回，侧栏会话列表与 workspace 信息仍阻塞首屏
- 把「首屏可交互」与「侧栏数据齐备」绑成同一临界点

---

### 主因 3：`bootstrap:get` 同步跑 `readProjectIndex(resourcesRoot)`（含多次 git 状态）

**机制**

```js
ipcMain.handle('bootstrap:get', async () => ({
  session: sessionStore.getSession(),
  capabilities: capabilityRegistry.refreshCapabilities(),
  projects: readProjectIndex({ workspaceRoot: resourcesRoot }),
  ...
  llmProviders: llmConfigStore.listProviders(),
}));
```

`readProjectIndex` 会对 workspace root + 各 package 目录跑 `git`（branch/remote/status 等），无缓存。

**本机实测**

| 目标 root | 耗时（约） |
| --- | --- |
| monorepo `peer_agent`（resourcesRoot 开发态） | ~1.5–1.6 s |
| `peer-knowledge` | ~120 ms |
| `$HOME` | ~0.1 ms |

开发态 `resourcesRoot` 常是 monorepo 根，bootstrap 本身就可能 >1.5s。

**证据路径**

- `apps/desktop/electron/main/main.mjs`：`bootstrap:get`
- `apps/desktop/electron/main/project-index.mjs`：`readProjectIndex` / `runGit`

另外：预加载里的 `workspace:info` 也会再调一次 `readProjectIndex(activeWorkspace)`（与 bootstrap 的 resourcesRoot 索引是不同 root，但叠加 git 开销）。

---

### 主因 4：`app.whenReady` 在 `createWindow` 前 `await createShellEnvSnapshot()`

**机制**

- 启动时用用户 `$SHELL -ilc ...`（login + interactive）抓完整环境写快照
- `SNAPSHOT_TIMEOUT_MS = 10_000`
- **await 完成后**才继续 tool host / `createWindow`

**本机实测**

- 等价 `SHELL -ilc 'echo SNAPSHOT_OK'` ≈ **1221 ms**
- 若 zsh/oh-my-zsh/p10k 配置更重，可逼近 10s 超时上限

**证据路径**

- `apps/desktop/electron/main/main.mjs`：`await createShellEnvSnapshot()` 在 `createWindow()` 之前
- `apps/desktop/electron/main/runtime-gateway/shell-env-snapshot.mjs`

**性质**

- 阻塞的是「窗口出现 / 渲染开始」，会拉长总冷启动；用户若在窗口已出现后只盯启动页，则主要体感仍在主因 1–3。

---

### 次因 / 非关键路径（需区分）

| 项 | 是否阻塞离开启动页 | 说明 |
| --- | --- | --- |
| MCP 连接 / probe | 否 | IPC 按需；未在 whenReady 关键路径自动全量 probe |
| skillStore 创建 | 轻量 | whenReady 内同步创建，通常远小于 shell 快照 |
| quickChat prewarm | 否（createWindow 后） | 后台预热，不挡 BrandStartupLoader |
| 自动更新 check | 否 | createWindow 之后，后台 |
| capability refresh | 否（本机 ~1ms） | bootstrap 内几乎可忽略 |
| llmConfigStore.listProviders | 通常轻 | 本地配置读取，非本机主瓶颈 |
| BrandStartupLoader 动画本身 | 否 | 纯展示，无数据等待逻辑 |

## 4. 本机量级粗算（开发态 monorepo + 重度会话库）

以下为 **可叠加上界粗算**（并行段取 max，串行相加；非精确 profile）：

| 段 | 阻塞对象 | 约耗时 |
| --- | --- | --- |
| shell env snapshot | 窗口创建前 | ~1.2 s |
| bootstrap:get（含 monorepo project index） | 启动页 | ~1.6 s |
| workspace:list → listConversations #1 | 启动页 | ~1.2 s |
| conversationsList → listConversations #2（与 workspaceInfo 并行） | 启动页 | ~1.2 s |
| workspaceInfo(active) project index | 启动页（与上并行） | ~0.1 s（peer-knowledge） |

启动页相关串行粗算：`bootstrap + workspaceList + max(conversations, workspaceInfo)` ≈ **1.6 + 1.2 + 1.2 ≈ 4.0 s**（仅数据路径，不含 bundle/React 挂载）。  
加上窗口前 shell 快照，总冷启动更易到 **~5 s+**；会话库更大或 shell 更重时继续放大。

## 5. 阻塞关键路径 vs 后台工作（一句话对照）

**阻塞离开 BrandStartupLoader 的：**

1. 会话全量 jsonl 扫描（且两次）
2. bootstrap 完成（含 project index）
3. 预加载完成才 setSession 的门闩设计
4. （窗口前）shell login 环境快照

**不阻塞该门闩、可后台做的：**

- MCP 连接与健康检查
- Quick Chat 预热
- 自动更新
- 完整侧栏列表刷新的「非首屏」部分（当前实现却被放进了门闩）

## 6. 修复方向提示（本目标不做实现，仅备忘）

1. **会话列表**：`messageCount` 写入 index meta，禁止 list 时读全文；`listByWorkspace` 先按 meta 过滤再读必要字段。
2. **启动门闩**：`getBootstrap` 成功即可 `setSession` 离开启动页；workspace/conversations 后台填充。
3. **bootstrap:get**：project index 懒加载或缓存；勿每次 bootstrap 同步扫 monorepo git。
4. **shell snapshot**：与 `createWindow` 并行，或超时降级，不阻塞首窗。
5. **workspace:list 发现逻辑**：避免为发现 workspace 触发全量 messageCount 扫描。

## 7. 证据索引

- 会话库规模与 list 耗时：本机 `listConversations` ~1.2s ×2 ≈ 2.4s
- shell login 交互耗时：~1.2s
- monorepo `readProjectIndex`：~1.5–1.6s
- 代码锚点见第 2–3 节路径表

---

**结论一句话**：启动页久，不是动画问题，而是 **「session 门闩绑死了重 I/O 预加载」**，其中最重的是 **为 messageCount 全量读会话 jsonl（启动路径还做两次）**，叠加 **bootstrap 内 monorepo git 项目索引** 与 **窗口前 shell 环境快照**。

---

## 8. 优化落地说明（已实现）

对应 Goal「落地冷启动优化」。实现与验收如下。

### 8.1 messageCount 进 index，list 不再全量读 jsonl

- `packages/conversation-store/src/index.mjs`
  - `createConversation` / `appendMessage` / `replaceMessages` 维护 `meta.messageCount`
  - `listConversations` 默认读 index 中的 `messageCount`；缺省时 `ensureMessageCounts` **批量回填一次**后写回 index
  - `listConversations({ includeMessageCount: false })` 完全跳过计数（供 `workspace:list` 发现路径）
- `apps/desktop/electron/main/main.mjs`：`workspace:list` 使用 `includeMessageCount: false`

### 8.2 listByWorkspace 先 meta 过滤

- `listConversationsByWorkspace` 改为先按 `workspacePath` + status 过滤 index，再 `ensureMessageCounts`，不再「全量 list 后再 filter」

### 8.3 启动门闩与预加载解耦

- `apps/desktop/renderer/src/app/state/useDesktopBootstrap.ts`
  - `getBootstrap` 成功后 **立即 `setSession`**（离开 `BrandStartupLoader`）
  - 再后台加载 `workspaceList` / `workspaceInfo` / `conversationsList` 填充 `startupSnapshot`
  - 预加载失败不影响 session，侧栏走原有 refresh 路径

### 8.4 bootstrap 不再同步扫 monorepo 项目索引

- `bootstrap:get` 返回 `projects: []`
- 需要时仍走 `projects:list` → `readProjectIndex`（按需，不挡冷启动）

### 8.5 shell 环境快照与首窗并行

- `app.whenReady` 中改为 `void createShellEnvSnapshot()`（后台）
- **不再** `await createShellEnvSnapshot()` 后再 `createWindow`
- 快照未就绪时 `buildShellSpawnArgs` 仍 fallback 到 login shell

### 8.6 验收

```bash
node packages/conversation-store/scripts/build.mjs
node --test apps/desktop/electron/main/conversation-store.test.mjs
# 35 pass / 0 fail（含 messageCount index / backfill / byWorkspace / includeMessageCount:false）
```

成功标准核对：

| 标准 | 状态 |
| --- | --- |
| listConversations 不再为 messageCount 读全文 jsonl | 已落地（index + 惰性回填） |
| bootstrap 后可先 setSession 再预加载 | 已落地 |
| createWindow 不再 await shell snapshot | 已落地 |
| conversation-store 相关测试通过 | 35 pass |
## 9. Phase A+B 落地（2026-07-18）

续见 `docs/design/desktop-performance-ab-landing.md`。

- list 热路径不读 jsonl（缺 count 后台迁移）
- conversationsList 支持 limit/cursor 分页
- 侧栏首屏 40 条 + 滚动加载
- Goal 徽标改为 `goalPlans:awaiting-counts`，去掉全量 `goalPlansList`
- 会话变更/focus 刷新改为防抖第一页
