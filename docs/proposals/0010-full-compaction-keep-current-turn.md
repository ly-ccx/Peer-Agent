# 0010 — 会话级上下文压缩改为「全量但保当前轮」（旧消息全摘要，仅保留当前轮原文）

状态：提案（A 级变更：触及 **会话级上下文压缩的准入契约 / keep-old 切分语义 / 连续性边界**。不新增 IPC 契约、不改权限通道、不改 `docs/architecture/*`、不改 renderer、不改 `notification` 字段结构）。

关联：
- `docs/proposals/0001-compaction-trigger-uses-provider-prompt-tokens.md`（压缩触发用 provider prompt tokens）
- `docs/proposals/0007-compaction-streaming-progress.md`（压缩进度的流式表达）
- `docs/proposals/0009-compaction-wave-divider.md`（压缩的波浪分隔线表达层）
- `AGENTS.md`：「Compact summaries are continuity context only」「Tool output / file content 不得升格为 system 指令」「New Modules must increase Locality or Leverage」
- `apps/desktop/electron/main/context-compactor.mjs`（会话级压缩的唯一实现处）

## 背景 / 现象

用户希望「压缩就应该是全量压缩」。实测现状并非全量：会话级压缩会**保留最近 10 条原文**，只把更早的消息送 LLM 摘要。用户确认要改为「全量但保当前轮」——旧消息全部摘要，仅保留触发压缩时正在进行的**当前轮**原文（最干净、且不丢失当前任务上下文）。

## 根因分析（代码证据）

`context-compactor.mjs`：

- 配置 `COMPACTION_CONFIG.keepRecentCount: 10`（行 ~14）。
- 核心切分 `splitForCompaction(messages)`（行 ~454）：

  ```
  convMsgs = messages.filter(role !== 'system')
  若 convMsgs.length <= keepRecentCount → 全 keep，不压缩
  否则:
    keep = convMsgs.slice(-keepRecentCount)        // 保留最近 10 条原文
    old  = convMsgs.slice(0, -keepRecentCount)     // 更早的去 LLM 摘要
    再经 expandKeepForToolContinuity 防止 keep 首条悬空 tool_result
  ```

  → 这就是「保留最近 N 条原文」的来源，非全量。

- `shouldRunCompaction` 的 `force` 分支（行 ~421）：`convCount > keepRecentCount` 决定 force 模式是否真的压缩。
- 兜底（行 ~1106/1115）：压缩后若仍超 target，`keep.slice(-5)` 再激进裁到 5 条。

## 目标语义：全量但保当前轮

触发压缩时：
- **keep** = 「最后一个 `user` 消息到末尾」的当前轮（最近一次 user 提问 + 其后的 assistant / tool 消息），再经工具连续性扩展防悬空。
- **old** = keep 之前的全部会话消息 → 全部进 LLM 摘要。

「当前轮」用「最后一个 user 消息的位置」界定，比固定保留 N 条更准确地表达"正在进行的这一轮"。

## 设计取舍

1. **改 `splitForCompaction` 的 keep 选取**（本提案选择）：keep 由「最后一个 user 索引」切分，而非 `slice(-keepRecentCount)`。语义集中在唯一切分点，`compactIfNeeded` 全程依赖其输出，**Locality 集中**，无新增能力面。
2. 备选：把 `keepRecentCount` 设为某个小常量（如 1/2）。缺点：无法准确表达"当前轮可能含多条 tool 消息"，且仍是"保留固定条数"而非"保留语义边界"。

选定方案 1。

### `slice(-0)` 陷阱（必须规避）

若只把 `keepRecentCount` 改成 0：`arr.slice(-0)` ≡ `arr.slice(0)` = **全部**，`arr.slice(0, -0)` ≡ `arr.slice(0, 0)` = **空**。结果会反转为 keep=全部、old=空，压缩完全失效。因此**不能靠改常量为 0 实现**，必须改切分逻辑、用显式的「最后一个 user 索引」。

### 当前轮定位

```
lastUserIdx = convMsgs 中最后一个 role === 'user' 的下标
若不存在 user（异常）→ 回退为保留最后 1 条
keep = convMsgs.slice(lastUserIdx)
old  = convMsgs.slice(0, lastUserIdx)
再经 expandKeepForToolContinuity（复用既有，防 keep 首条悬空 tool_result）
```

## 边界 / 非目标

- **只动会话级压缩**（`splitForCompaction` 及其阈值/兜底）。
- **不动微压缩** `MICROCOMPACTION_CONFIG`（`keepRecentCount: 8`，`microcompactMessagesForContext`）——那是行内消息微压缩的另一套机制，不在本次范围。
- 工具连续性保护 `expandKeepForToolContinuity` 行为不变，继续复用。
- `notification` 字段结构不变（`oldMessageCount` / `keptMessageCount` 等），UI / 波浪分隔线表达层不受影响。
- 不新增 IPC、不改 renderer、不改 `docs/architecture/*` 与 `AGENTS.md`、不改 Evidence 协议。

## 连续性风险与缓解

- 风险：当前轮若本身极长（单轮塞满上下文），保留当前轮可能仍超 target。
  - 缓解：保留兜底路径（`keep.slice(-5)` → 与新语义对齐，见实现）；当前轮即使全留也是"最小不可分语义单元"，符合"不丢当前任务"的目标。
- 风险：force 手动 `/compact` 在「只有当前轮、无更早消息」时不应产生空压缩。
  - 缓解：`shouldRunCompaction` force 分支阈值语义随新切分对齐（old 为空则不压缩）。

## 实现

仅改 `apps/desktop/electron/main/context-compactor.mjs`：

1. `splitForCompaction`：以「最后一个 user 索引」切分 keep/old，规避 `slice(-0)`；`convMsgs` 无更早消息（lastUserIdx<=0）时 old 为空、不压缩。
2. `shouldRunCompaction` force 分支：阈值语义与新切分对齐，避免空压缩。
3. 兜底 `keep.slice(-5)`：与「当前轮」语义对齐（当前轮已是最小集时不再二次裁剪到固定 5 条，或保持但记录）。
4. 保持纯函数、保持 `notification` 字段结构不变；`MICROCOMPACTION` 不动。

## 验证

- 更新/新增 `context-compactor.test.mjs`：
  - 当前轮（最后一个 user 到末尾）保留、其余全进 old
  - 单条会话 / 仅当前轮无更早消息 → 不触发压缩（old 为空）
  - 最后一个 user 定位正确（中间有多条 assistant/tool）
  - keep 首条为 tool_result 时工具连续性扩展生效
  - `slice(-0)` 不被误判为「全保留」
  - force 分支语义自洽
  - 既有断言随新语义更新，而非删除掩盖
- `pnpm -C apps/desktop test` 通过、`pnpm -C apps/desktop typecheck` 通过。
- `git status` 确认改动仅限 `context-compactor.mjs`、`context-compactor.test.mjs`、`docs/proposals/0010-*`。

> 生效说明：`.mjs` 运行时模块不热加载，改动需重启 Electron 应用后才在运行进程生效。
