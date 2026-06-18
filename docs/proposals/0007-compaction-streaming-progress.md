# 0007 — 压缩 LLM 调用改流式 + 字符级真实进度 + 保留压缩分隔标记

状态：提案（B 级变更：触及 **IPC 流事件契约**（`chat:compaction` 新增 `stage: 'progress'` 与进度字段）、**主进程压缩器**（`summarizeWithLLM` 改流式 + `onProgress` 回调）、**renderer 压缩条 UI**（进度条 + 压缩完成后保留分隔标记）。不改权限/Evidence 通道语义，不改 `docs/architecture/*`）。

关联：
- `AGENTS.md`：「Provider-specific request formatting belongs behind a provider encoder seam」「Do not add ad hoc cross-process payloads when a protocol object should exist」「Renderer owns presentation and user interaction only」「Compact summaries are continuity context only」
- `docs/proposals/0001-compaction-trigger-uses-provider-prompt-tokens.md`（压缩触发与 token 估算由来）
- `docs/architecture/19-system-prompt-context-architecture.md`（System Context 装配，只读参考）

## 背景 / 现象

手动 `/compact`（及自动压缩）执行期间，renderer 在时间线底部渲染一条细分隔条「压缩上下文中」+ 转圈 spinner（`ChatSurface.tsx` `isCompacting` 布尔 + `.compaction-notice`）。用户反馈两点：

1. **没有进度**：只有一个转圈，用户不知道压缩进行到哪、还要多久。
2. **压缩完成后分隔条消失**：用户无法从时间线上看出「哪一侧（上文）被压缩了」，分界线丢失。

用户提出的关键洞察：压缩时若用流式 LLM 调用，则可按「已流式收到的字符数 / 预期摘要字符数」算出**真实**进度（不是时间估算）。

## 根因分析（代码证据）

诊断基于实际文件读取：

1. **压缩的 LLM 调用是非流式的，没有任何中间进度可上报。**
   - `context-compactor.mjs` `summarizeWithLLM()`：Anthropic 路径 body `stream: false`，`const data = await res.json()` 一次性取回；OpenAI 路径同样 `stream: false`。
   - 因此 LLM 调用期间（2–4s）renderer 收不到任何中间信号，进度无从谈起。

2. **IPC 事件已有通道，但只有 start/idle/done 三态，无 progress。**
   - `main.mjs` `chat:compact` handler 发 `chat:compaction` 事件，`stage` 取值仅 `'start' | 'idle' | 'done'`。
   - `preload.cjs` 已暴露 `onChatCompaction(listener)` 订阅 API。

3. **renderer 不订阅 onChatCompaction，压缩条只是本地布尔。**
   - `ChatSurface.tsx` `/compact` 分支走 `clientApi.chatCompact(...)` invoke，本地 `setIsCompacting(true/false)`，**未订阅** `onChatCompaction`，所以即便主进程发 progress 也没人接。
   - 压缩完成后 `setIsCompacting(false)` → `.compaction-notice` 整条卸载，分隔标记不保留。

结论：要做「字符级真实进度」必须三层联动：(1) 压缩器改流式并新增 `onProgress`；(2) IPC 契约新增 `progress` 阶段；(3) renderer 订阅事件、渲染进度条、并在完成后保留分隔标记。

## 目标

1. 压缩 LLM 调用改流式（Anthropic SSE + OpenAI SSE），边读边数字符。
2. 进度按 `已收字符 / 预期摘要字符（summaryMaxTokens × charsPerToken）` 估算百分比，封顶 99%，`done` 时置 100%。
3. 压缩条升级为进度条；压缩完成后**保留分隔条**，文案改为「从此处上文已被压缩」。

## 方案

### A — 压缩器 `summarizeWithLLM` 改流式 + onProgress（主进程）
- 新增可选入参 `onProgress`：`({ receivedChars, estimatedTotalChars }) => void`。
- Anthropic：body `stream: true`，按 SSE 解析 `content_block_delta` 的 `delta.text`，累加到摘要文本，同时回调 `onProgress`。
- OpenAI：body `stream: true`，按 SSE 解析 `choices[].delta.content`，同上。
- 复用既有 `buildClaudeCliIdentityHeaders()`（provider encoder seam），不在多处各写一份请求头。
- `estimatedTotalChars = COMPACTION_CONFIG.summaryMaxTokens * COMPACTION_CONFIG.charsPerToken`。
- 流式异常（解析失败 / 中断）仍走既有 catch → structural 兜底，`fallbackReason` 语义不变。

### B — `compactIfNeeded` 透传 onProgress（主进程）
- `compactIfNeeded({..., onProgress})`，在调用 `summarizeWithLLM` 处透传。

### C — IPC 契约新增 progress 阶段（协议）
- `main.mjs` `chat:compact` handler 给 `compactIfNeeded` 传入 `onProgress`，每次回调 `event.sender.send('chat:compaction', { streamId, stage: 'progress', manual: true, receivedChars, estimatedTotalChars, percent })`。
- `percent = min(99, round(receivedChars / estimatedTotalChars * 100))`。
- `stage` 取值扩展为 `'start' | 'progress' | 'idle' | 'done'`。progress 为可选增量事件，旧消费者忽略未知 stage 不受影响。

### D — renderer 进度条 + 保留分隔标记（renderer）
- `ChatSurface.tsx` `/compact` 期间订阅 `onChatCompaction`，按 streamId 门控，`stage:'progress'` 更新 `compactionPercent`。
- `.compaction-notice` 文案区改为进度条（宽度 = percent%）+ 百分比文字。
- 压缩成功后，时间线已由 `CompactionSummaryCard`（既有）呈现压缩点；底部 `.compaction-notice` 文案在收尾阶段切到「从此处上文已被压缩」并短暂保留后随重载消失（压缩分界由 CompactionSummaryCard 持久承载，符合既有「不再使用底部横幅通知」的设计）。

> 注：分界线的**持久**呈现已由时间线内 `CompactionSummaryCard` 承担（`ChatSurface.tsx:941`）。本提案不重复引入第二个持久标记，避免双标记冲突；底部条仅负责「进行中进度」与「收尾即时反馈」。

## 边界与非目标
- 不改压缩触发阈值、token 估算（沿用 0001）。
- 不改 structural 兜底与熔断器语义。
- 不改 Evidence/权限通道。
- 不改 `docs/architecture/*`。
- 进度为估算（预期总长按上限算，实际摘要常更短，故可能提前接近 100% 再 done）——这是流式字符进度的固有特性，优于时间估算。

## 测试
- `context-compactor.test.mjs`：mock 流式响应，断言 `onProgress` 按 chunk 累加 `receivedChars`、`estimatedTotalChars` 正确；流式异常回落 structural。
- 既有压缩相关测试回归。
