# 0009 — 压缩进度统一为一条「波浪形分割线」：波浪线按百分比渐变填充，完成后保留为永久分隔

状态：提案（C/B 级表达层变更：仅触及 **renderer 压缩进度/分隔的 DOM 结构与样式**（`ChatSurface.tsx` 的 `isCompacting` notice、`AssistantContent.tsx` 的 `CompactionSummaryCard`、`chat/styles/chat-surface.css`）。**不改** 压缩数据形状、IPC 事件契约、主进程压缩器、权限/Evidence 通道，**不改** `docs/architecture/*` 与 `AGENTS.md`。）

关联：
- 承接 `0007-compaction-streaming-progress.md`（已实现字符级真实进度 + 进行时分隔条），本提案只重做「表达层」。
- `AGENTS.md`：「Renderer owns presentation and user interaction only」「local UI/styles 属 C 级，但触及 prompt/permission/Evidence/protocol 时升级」——本变更不触及后者，保持表达层内。
- 设计令牌红线：`azure` 为稀缺强调色，须克制使用，以 `--azure-soft` / `--azure-trace` 为主体、`--azure-seal` 仅作高光点缀。

---

## 背景 / 现象

用户期望：压缩在时间线上表现为**一条波浪形分割线**，波浪线**本身**按压缩百分比被**渐变颜色填充**（未完成段为浅色 hairline），填充推进带「流动、自然、随和、缓冲」的动画质感；压缩**完成后波浪分割线保留**，作为该会话被压缩处的永久分界标记。

实际现状（见截图）：进行时是一条**直线**进度条 + 文字「压缩上下文中 60%」，不是波浪、填充感弱；压缩**完成后整条消失**。

---

## 根因分析（代码证据）

1. **波浪与百分比解耦在两套元素上**（`chat-surface.css` 约 1031–1135）：
   - `.compaction-notice::before/::after` 是波浪线（内联 SVG 正弦波 mask + 横向流光 shimmer），但它**只做流光，不承载百分比**。
   - `.compaction-progress` 是**另一条独立的直线**进度条（`width: N%` 承载百分比）。
   - 因此「波浪」和「填充」各自为政，用户看到的「直线 60%」其实是 `.compaction-progress` 这条直条，波浪只在两侧装饰。
   - 旁证：现有波浪/流光样式引用了 `--azure-core`，而 `tokens.css` **未定义** `--azure-core`（仅有 `--azure-seal/soft/trace`），是一处潜在失效引用，需一并纠正。

2. **进行时 notice 完成即从 DOM 移除**（`ChatSurface.tsx` 约 1041–1066）：
   `{isCompacting ? (<div className="compaction-notice">…</div>) : null}`，压缩结束 `isCompacting=false`，整块 notice（含波浪线）被卸载。

3. **完成后的 summary 卡没有波浪外观**（`AssistantContent.tsx` `CompactionSummaryCard` + `chat-surface.css` 约 1224–1236）：
   `.compaction-summary-toggle::before/::after` 是纯 `height:1px; background: var(--chrome-hairline)` 的**直线**。所以即便保留了「压缩摘要」分隔，也不是波浪、更没有按 100% 着色，「波浪分割线」在完成态彻底丢失。

---

## 目标

1. 进行时与完成态**共用同一种「波浪渐变分割线」视觉语言**——波浪线本身是百分比的载体。
2. 波浪线 = 单一主体：在波浪形 mask 下铺一层 `width: N%` 的 **azure 渐变填充**（`--azure-soft → --azure-trace`，`--azure-seal` 作高光），未填充段为 hairline。
3. 填充推进动画具备「缓冲/流动」质感：`width` 过渡用更长缓动（`--za-motion-slow` + `--za-ease-decelerate`/`spring`），叠一层极缓慢的波形位移让填充「活」起来。
4. **完成后保留**为一条「填满 100% 的同款波浪渐变分割线」，承载在 `CompactionSummaryCard` 上，点击展开/折叠摘要的交互不变。
5. 无百分比（indeterminate）时退回流光态，并保留 `role="progressbar"` 语义。

---

## 方案

### A — 进行时 notice（`ChatSurface.tsx`）
- 去掉独立直线进度条 DOM（`.compaction-progress` 直条），改为单一波浪分割线元素：
  - 外层 `role="progressbar"`，有百分比时带 `aria-valuenow/min/max`，无百分比时为 indeterminate。
  - 用 CSS 变量（如 `style={{ ['--compaction-fill' as any]: `${percent}%` }}`）把百分比下发给填充层 `width`。
- 文案「压缩上下文中 N%」保留。

### B — 进行时样式（`chat-surface.css`）
- 波浪条：一个固定高度（约 6–8px）的带子，`-webkit-mask`/`mask` 用内联 SVG 正弦波裁形。
- 填充层：mask 之下铺 `width: var(--compaction-fill)` 的 `linear-gradient(90deg, --azure-soft, --azure-trace)`，末端叠 `--azure-seal` 高光；未填充底为 `--chrome-hairline`。
- 缓冲动画：`transition: width var(--za-motion-slow) var(--za-ease-decelerate)`；再叠一个极慢 `@keyframes` 让 mask 的 `background-position`/波形缓慢位移（流动感）。
- 收敛/移除旧 `.compaction-progress` 直条样式；修正 `--azure-core` 失效引用为 `--azure-soft/seal/trace`。

### C — 完成态 summary 卡（`AssistantContent.tsx` + `chat-surface.css`）
- `CompactionSummaryCard` 折叠态 toggle 的左右分隔，由纯 1px 横线改为**填满 100% 的同款波浪渐变分割线**（复用 B 的样式，`--compaction-fill: 100%`，去掉流动动画或保留极弱）。
- 保留点击展开摘要、count/method/chevron 行为与展开态卡片样式不变。

---

## 边界与非目标
- 不改压缩触发逻辑、`summarizeWithLLM`、`compactIfNeeded`、IPC `chat:compaction` 事件字段、Continuity/Evidence 数据形状。
- 不改主进程、协议、权限通道。
- 不新增设计令牌；仅消费既有 `--azure-soft/seal/trace`、`--za-motion-*`、`--za-ease-*`、`--chrome-hairline`。
- 不触碰 `docs/architecture/*`、`AGENTS.md`。
- 不改 `azure` 红线下的稀缺色权重原则（soft/trace 为主，seal 点缀）。

## 验证
- `pnpm -C apps/desktop typecheck` 绿。
- `pnpm -C apps/desktop test` 绿（本变更为纯表达层，无新增单测目标；如有快照/DOM 测试受影响则同步）。
- `pnpm architecture:check` 绿。
- `git status` 确认改动仅限：本提案、`chat/styles/chat-surface.css`、`ChatSurface.tsx`、`AssistantContent.tsx`（如复用 token 不改 `tokens.css`）。
