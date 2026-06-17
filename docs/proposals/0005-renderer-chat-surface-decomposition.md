# 0005 — Renderer 重构：拆解 ChatSurface god module + 样式单轨归位

状态：提案（B 级变更为主：触及 chat 运行时编排、System Context 装配、API 消息映射、prompt/上下文组装的 renderer 侧；附带 C 级样式归位。**不改运行时契约、不改权限/Evidence 通道、不改 `docs/architecture/*`**）。

关联：
- `AGENTS.md`：「Renderer owns presentation and user interaction only」「System prompt construction must be treated as System Context assembly, not ad hoc string concatenation」「Do not keep growing god modules such as chat runtime, tool runtime, prompt assembly, or large React surfaces」「New Modules must increase Locality or Leverage. Avoid shallow pass-through wrappers」
- `docs/architecture/19-system-prompt-context-architecture.md`（System Context 装配，作为只读参考）
- `docs/architecture/01-project-structure.md`（目录分层，作为只读参考）
- `docs/proposals/0004-goal-mode-runtime-gate.md`（goal 模式运行时闸门 / InteractionContext 由来）

## 背景 / 现象

针对 `apps/desktop/renderer` 做了一次只读架构合规诊断。结论：**跨层硬边界（能力/界面/契约/证据）没有被破坏，问题集中在 renderer 内部的「职责归位」**。最大的违规是单个 React 组件 `ChatSurface.tsx` 膨胀为 god module，把多类非渲染职责内联其中，违反「Renderer owns presentation only」与「不要继续养大 large React surfaces」。

本提案的目标：在**不改变任何运行时契约、不改变行为**的前提下，把 `ChatSurface` 的非渲染职责下沉到带接口、可测试、可替换的 Module（Seam），让 `ChatSurface` 回归「只做 UI 容器编排」。

## 根因分析（代码证据）

诊断全部基于实际工具结果（`find` / `grep` / `wc` / 文件读取），证据要点：

### 合规项（本提案不触碰，避免扩大改动）

- **renderer 零本地能力直连**：`grep -rE "fs|child_process|electron|@modelcontextprotocol"` 在 `src/**/*.ts(x)` 中 `NONE FOUND`；本地能力统一经 `window.peerAgent` 桥接（`composerPersistence.ts` / `appearance/AppearanceProvider.tsx` / `clientApi.ts`）。
- **权限真相在主进程**：approve/deny 经 `clientApi.approveLocalAction/denyLocalAction` → preload `bootstrapPreloadApi`（返回 `PermissionGrant`）；renderer 仅持 `pendingPermissionCalls` 这一 UI 待决态（`ChatSurface.tsx:840`）。
- **契约/Evidence 结构化**：附件/续传/配置指令使用协议类型（`ContextAttachmentItem` / `ContinuityContextItem` / `ConfigInstructionContextItem`）；附件被标注 `sourceKind=user_upload / scope=conversation / lifecycle=ephemeral`，即用户上下文未被升格为系统指令。
- **已有良好接缝**：`chat/state/` 为纯逻辑 + 单测（`clientToolCallEvents` / `clientToolEvidence` / `composerPersistence` / `historicalLocalRecord` / `interactionToolView` 均带 `.test.ts`）；`hooks/` / `components/thread/` / `components/markdown/` 已分出。

### 违规项（本提案要解决）

| # | 问题 | 证据 | 等级 |
|---|------|------|------|
| 1 | `ChatSurface.tsx` **2488 行** god module，混合 7 类职责：UI 容器 + Context 装配 + API 映射 + 流式分段合并 + token 估算 + 文件读取 + 权限 UI 态 | 顶层符号清单（`buildConfigInstructionContext` / `toApiMessages` / `normalizeStreamSegment` / `estimateMessageTokens` / `readAsDataUrl` / `pendingPermissionCalls` 等均在同一文件） | B |
| 2 | **Context Source / API 映射等纯逻辑内联在 UI 组件**，而非 `state/` 接缝；System Context 装配成为 UI 组件的副业 | `buildConfigInstructionContext` / `buildAttachmentContext` / `buildConversationAttachmentContext` / `buildConversationContinuityContext` / `toApiMessages` 定义在 `ChatSurface.tsx` 内 | B |
| 3 | **样式双轨**：`styles.css` 同时 `@import "./chat/styles/sidebar.css"` 与 `"./styles/sidebar.css"`（同名重复，皆全局作用域）；`styles/chat-surface.css`(1485 行) 留在全局 `styles/` 而非 chat feature 内 | `src/styles.css` 的 `@import` 列表；`ls src/styles` 与 `ls src/chat/styles` 出现同名 `sidebar.css` | C |

规模数据：TS/TSX 合计 9512 行，CSS 合计 8382 行。头部文件 `ChatSurface.tsx` 2488、`styles/chat-surface.css` 1485、`capability-workbench.css` 1431、`settings-page.css` 1013、`tokens.css` 720。

## 目标架构（重构后 renderer 应有的形态）

核心原则：`ChatSurface` 只做「表达 + 用户交互」的容器编排；所有非渲染职责成为带接口的 Module。`app/` `appearance/` `capabilities/` 三个 feature 切分已合理，本提案不动。

```text
src/chat/
├─ components/                 # 只负责表达：纯展示 + 事件回调
│  ├─ ChatSurface.tsx          # 瘦容器：编排子组件 + 调 hooks（目标 < 300 行）
│  ├─ Composer/                # 输入区（含附件条 / 找一找）
│  ├─ Thread/                  # 消息流（由现有 thread/ 提升）
│  └─ markdown/                # 保留
├─ state/                      # 纯逻辑 Module（无 React，可单测）
│  ├─ contextSources.ts        # ← 抽：Context Source 装配（违规#2 核心）
│  ├─ apiMessageMapping.ts     # ← 抽：toApiMessages / getApiMessageContent / ...
│  ├─ streamSegments.ts        # ← 抽：normalizeStreamSegment / mergeReattachedSegments / segmentsSignature / groupSegments
│  ├─ tokenEstimate.ts         # ← 抽：estimateTextTokens / estimateMessageTokens / estimateAttachmentTokens
│  ├─ attachmentIntake.ts      # ← 抽：readAsDataUrl / readAsText / isTextLikeFile + 上限常量
│  └─ format.ts                # ← 抽：formatBytes / formatTime / formatDuration / formatTokenCount
├─ hooks/
│  └─ useChatConversation.ts   # ← 抽：消息队列 / 流式生命周期 / pendingPermissionCalls 编排
└─ styles/                     # chat feature 样式唯一来源（删除全局重复轨）

src/styles/                    # 只留真正全局：tokens / base / shell / card
```

### 关键设计决策

1. **Context Source 成为独立 Module（解决违规 #2）**
   `contextSources.ts` 暴露纯函数（如 `assembleChatContext(messages, settings, attachments)`），把「System Context 装配」从 UI 副业变为有 Interface、可测试、可替换的 Seam，符合 AGENTS.md「System Context assembly, not ad hoc concatenation」。注意：本提案只是**搬运并固化现有结构化逻辑**，不改变其语义（附件仍为 ephemeral 用户上下文，不升格为系统指令）。

2. **`useChatConversation` 收编编排态（解决违规 #1 主体）**
   消息队列、流式生命周期、`pendingPermissionCalls` 进入该 hook。`ChatSurface` 改为消费 hook 返回值并渲染。提升 Locality（改动/调试集中）与 Leverage（容器变薄）。权限通道不变：approve/deny 仍走 `clientApi` → preload → `PermissionGrant`。

3. **样式单轨（解决违规 #3）**
   `chat/styles/` 为 chat feature 唯一来源；移除 `styles/chat-surface.css`、`styles/sidebar.css` 的重复轨；全局 `styles/` 仅保留 tokens/base/shell/card。`styles.css` 的 `@import` 列表相应去重。

## 分批执行方案（行为不变 + 测试护栏）

顺序：先抽纯逻辑（最安全）→ 再抽 hook → 最后拆 UI / 归位样式。每批独立可验证、可回滚。

- **批次 1（B/C，最安全）**：抽 `format.ts` / `tokenEstimate.ts` / `attachmentIntake.ts` / `streamSegments.ts` / `apiMessageMapping.ts` / `contextSources.ts`，每个补单测（沿用 `chat/state/*.test.ts` 惯例）。`ChatSurface` 改为 import，行为不变。
- **批次 2（B）**：抽 `useChatConversation.ts`，`ChatSurface` 瘦身到容器级。
- **批次 3（C）**：拆 `Composer/`、`Thread/` 子组件 + 样式单轨归位。

每批验收：`pnpm -C apps/desktop typecheck` 通过、相关 `*.test.ts` 通过、`ChatSurface` 行为人工冒烟无回归。

## 边界与非目标（Out of Scope）

- 不修改任何运行时契约：preload contract、`clientApi`、协议类型、IPC 形状保持不变。
- 不修改权限/Evidence 通道与主进程逻辑。
- 不修改 `docs/architecture/*`（按用户仓库偏好，架构文档只读）。
- 不引入新依赖、不改设计 token 语义（`tokens.css` 内容不变，仅样式文件归位）。
- 不重构 `app/` `appearance/` `capabilities/` 的目录结构。

## 异常处理 / 回滚

- 任一批次 typecheck 或测试失败：停在该批次，不向下推进；该批次为纯搬运，可整批回退到搬运前。
- 若搬运过程中发现某段逻辑实际依赖 React 状态（无法纯函数化）：保留在 hook 层而非 state 层，并在本文件追记。

## 涉及文件（预期）

- 新增：`src/chat/state/{contextSources,apiMessageMapping,streamSegments,tokenEstimate,attachmentIntake,format}.ts` 及对应 `*.test.ts`；`src/chat/hooks/useChatConversation.ts`；`src/chat/components/{Composer,Thread}/*`。
- 修改：`src/chat/components/ChatSurface.tsx`（瘦身为容器）；`src/styles.css`（去重 import）。
- 删除/合并：`src/styles/chat-surface.css`、`src/styles/sidebar.css`（归位到 `chat/styles/`）。

## 验证（Definition of Done）

- `ChatSurface.tsx` 行数显著下降（目标 < 300 行），非渲染职责全部移出。
- 新增 state Module 均有单测并通过。
- 样式单轨：`styles.css` 无重复 `@import`，chat 样式集中在 `chat/styles/`。
- typecheck + 测试通过；UI 行为无回归。
