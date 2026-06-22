# 批量并行检索 + 聚合编排（方案丙）设计文档

> 状态：Draft（已获用户方向审批，进入实现）
> 变更级别：**A 级**（新增能力暴露 + Runtime Projection + 协议字段扩展）
> 适用范围：本文件为 `docs/design/` 设计记录，不修改只读的 `docs/architecture/*`。架构基线参见 `docs/architecture/20-architecture-governance.md`、`docs/architecture/15-plugin-skill-mcp-system.md`、`docs/architecture/16-skill-call-lifecycle.md`。

## 1. 背景与目标

### 1.1 现状（基于代码核查）

| 能力 | 现状 | 证据 |
|---|---|---|
| 单路文件内容检索 | ✅ 已有 `search_files` | `apps/desktop/electron/main/runtime-gateway/local-file-provider.mjs` 中 `local.file.search` → `runFileSearch`，grep 式子串匹配，限定 workspace、跳过依赖/构建目录 |
| 同轮多 tool 调用 | ⚠️ 模型可发多个 tool_use，但 runtime **串行**执行 | `anthropic-agent-loop.mjs` 的 `for (const tu of effectiveToolUseBlocks) { await executeModelToolCall(...) }` |
| 多路并行 fan-out + 聚合 | ❌ 不存在 | chat-runtime 内无 `Promise.all` 多路检索编排；`providerRegistry.execute` 逐个返回独立 `{call, grant, result}` |
| 语义代码检索 / 记忆检索通道 | ❌ 不存在 | provider 注册表仅含 file/shell/goal/interaction/web/mcp/health |

截图（Cursor 风格）展示的形态是：**一个搜索意图 → 拆成多条子查询并发执行 → 逐条显示状态（检索中 / 已检索 · N 个结果）→ 聚合成一个结果面板**。该形态当前不具备。

### 1.2 目标（Definition of Done）

实现"批量并行检索 + 聚合编排"（方案丙）：

1. 新增模型可见的单一工具 `batch_search`，模型**一次调用**给出多条子查询。
2. 由本地 `local.search.aggregate` Provider 内部**并发 fan-out**，复用现有 `search_files` 执行体跑每条子查询。
3. 聚合、去重、重排后返回**一份**聚合 Evidence + **一份**只读 PermissionGrant。
4. 扩展协议的**分路(lane)进度事件**，让 Renderer 还原截图式逐条检索状态。
5. 对核心 agent-loop 串行执行**零侵入**；并发完全收敛在 Provider 内。

### 1.3 成功标准

- 模型侧只看到一个工具、一次调用即可触发多路检索。
- 每条子查询有独立的 `started` / `completed` 进度事件（含结果计数），UI 可逐条还原。
- 单条子查询失败/超时被隔离，不影响其余子路与最终聚合。
- 取消（signal abort）能终止尚未完成的子路。
- 聚合结果对同一 `path:line` 去重，并按相关性（命中子查询数 / 命中次数）重排。
- 现有 `search_files`、`anthropic-agent-loop` 行为无回归。

## 2. 范围

### 2.1 In Scope（一期）

- `batch_search` 工具定义 + prompt + Runtime Projection 注册。
- `local.search.aggregate` Provider（并发 fan-out / 聚合 / 去重 / 重排 / 隔离 / 取消）。
- 协议 lane 字段扩展（向后兼容）。
- Renderer 分路状态机折叠 + 分路卡片 UI + 聚合结果面板。
- 聚焦单测（provider 并发/聚合/部分失败/取消；reducer lane 折叠）。

### 2.2 Out of Scope（一期不做）

- 语义/向量代码检索通道（截图中的"检索代码"语义版）。
- 记忆检索通道（`packages/protocol/src/memory.ts` 类型已存在，但不在本期投影成工具）。
- 改造核心 agent-loop 让任意工具同轮并发执行（方案乙，不采纳）。
- 跨 workspace / 跨组织检索。
- 检索结果的持久化缓存。

> 一期把"检索通道种类"收敛为仅文件/代码内容检索；后续如需语义/记忆检索，作为子查询的新 `kind` 增量接入，不改聚合编排骨架。

## 3. 能力契约（batch_search / local.search.aggregate）

### 3.1 模型可见入参

```jsonc
{
  "queries": [                       // 必填，1..N 条子查询（建议上限 8）
    {
      "id": "repo",                 // 可选，子路稳定标识；缺省由 Provider 生成
      "label": "检索仓库",          // 可选，用于 UI 分路标签
      "query": "createCapabilityProviderRegistry", // 必填，子串
      "path": "apps/desktop",       // 可选，限定 workspace 内子路径
      "case_sensitive": false,        // 可选
      "max_results": 50               // 可选，单路上限
    }
  ],
  "max_concurrency": 4,              // 可选，默认 4；Provider 内夹紧到 [1, 8]
  "dedupe": true                     // 可选，默认 true
}
```

- `kind` 字段预留：一期隐含 `kind: "file_content"`，校验时仅接受该值或缺省。为后续语义/记忆通道留扩展位，但一期不实现其它 `kind`。

### 3.2 聚合返回（Evidence 内容）

```jsonc
{
  "status": "success",              // success | partial | failed
  "tool": "batch_search",
  "laneCount": 3,
  "lanes": [
    {
      "id": "repo",
      "label": "检索仓库",
      "query": "...",
      "status": "completed",        // completed | failed | timeout | cancelled
      "matchCount": 12,
      "fileCount": 5,
      "truncated": false,
      "errorMessage": null
    }
  ],
  "aggregated": {
    "totalUniqueMatches": 27,
    "matches": [                     // 去重 + 重排后的合并结果
      {
        "path": "apps/.../x.mjs",
        "line": 42,
        "text": "...",
        "laneIds": ["repo", "code"],// 命中该位置的子路
        "hitCount": 2               // 重排权重输入
      }
    ]
  },
  "preview": "Found 27 unique match(es) across 3 lane(s) ..."
}
```

- 整体 `status`：全部子路成功 → `success`；部分失败/超时但有成功 → `partial`；全部失败 → `failed`。
- 返回 **一份** PermissionGrant：只读、`D1_internal`（与 `search_files` 同档），覆盖本次聚合涉及的 workspace 范围。

## 4. 分路进度事件模型

### 4.1 协议落点（重要：纠正计划中的路径偏差）

计划子任务 `protocol-lane` 原写 `packages/protocol/src/runtime-gateway.ts` —— **该文件不存在**。经核查，工具事件/卡片类型实际定义在 `packages/protocol/src/execution.ts`：

- `ToolCard`（约 L137）：`toolCallId` / `toolId` / `status` / `steps: SkillStep[]` / `clientToolStatus` / `stdout` / `stderr` 等。
- `ClientToolStatus`：`dispatching | acked | ... | completed | failed | ...`。
- `SkillStep`（约 L97）：`status: pending | running | completed | error`。

因此 lane 扩展落在 `execution.ts`，而非新建 `runtime-gateway.ts`。实现时以 execution.ts 为准。

### 4.2 lane 字段扩展（向后兼容）

在 `ToolCard` 上新增**可选** lane 维度（不破坏现有单卡工具）：

```ts
export interface ToolCardLane {
  readonly laneId: string;
  readonly laneLabel?: string;
  readonly lanePhase: 'pending' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled';
  readonly laneResultCount?: number;   // 已检索结果数（截图中的 "· N 个结果"）
  readonly laneQuery?: string;
}

export interface ToolCard {
  // ...existing fields unchanged...
  readonly lanes?: readonly ToolCardLane[];   // 仅聚合检索类工具填充
}
```

- 所有新增字段 optional；现有工具卡 `lanes === undefined`，行为不变。
- 复用既有 `SkillStep` 机制亦可，但 lane 语义（带 resultCount、与 query 绑定）与 step 不同，单列 `lanes` 更贴合 Locality。

### 4.3 事件时序

每条子路独立发：
1. `lane started`：`lanePhase: 'running'`，UI 显示"检索中"。
2. `lane completed`：`lanePhase: 'completed'` + `laneResultCount`，UI 显示"已检索 · N 个结果"。
3. 失败/超时/取消：对应 `lanePhase`，UI 标记该子路异常但不阻塞整体。

事件经现有 ToolCard 流式通道下发（与 stdout/clientToolStatus 同路径），断线丢失由最终聚合 Evidence 兜底（与现有约定一致）。

## 5. 并发 / 聚合 / 去重 / 重排规则

### 5.1 并发 fan-out

- 在 `local-search-aggregate-provider.mjs` 内用受控并发池执行子查询，并发度 = `clamp(max_concurrency, 1, 8)`。
- 每条子路复用 `local-file-provider` 的 `runFileSearch` 执行体（抽出为可复用函数或经内部调用），不重写检索逻辑。
- 每条子路 start 时发 lane `running` 事件，结束时发终态事件。

### 5.2 去重

- key = `path + ':' + line`（同一行多 query 命中视为一条）。
- 合并时累积 `laneIds` 与 `hitCount`。
- `dedupe: false` 时跳过合并，按子路顺序拼接（仍保留 laneIds）。

### 5.3 重排

排序键（降序）：
1. `hitCount`（被越多子查询命中越靠前）。
2. `laneIds.length`（跨子路覆盖度）。
3. 文件路径字典序（稳定兜底）。

最终对聚合结果应用全局上限（默认 200，夹紧），超出标记 `truncated`。

## 6. 异常与取消语义

- **单条失败隔离**：某子路抛错 → 该 lane `failed` + `errorMessage`，其余子路与聚合继续；整体 `status` 视存活情况为 `partial`/`failed`。
- **超时隔离**：单路超时（默认与 search 一致或单独配置）→ lane `timeout`，按失败隔离处理。
- **取消**：Provider 接收 `signal`（AbortSignal）。abort 时：尚未开始的子路不再调度；进行中的子路尽力中断并标 `cancelled`；已完成子路结果仍纳入聚合（best-effort）。整体返回 `cancelled`/`partial`。
- **入参校验失败**：`queries` 为空或非法 `kind` → 直接 `blocked`（不发起任何子路），复用 `formatToolFailure` 风格。
- **权限**：聚合工具整体只读，单次 PermissionGrant；不为每条子路单独申请权限（与 `search_files` 同档 `D1_internal`）。

## 7. 架构影响与一致性

- **本地负责能力**：并发/聚合/去重/重排全部收敛在新 Provider（Implementation），模型只见一个 `batch_search`（Interface）。符合"本地负责能力 / 界面负责表达 / 契约负责边界 / 证据负责治理"。
- **Runtime Projection**：经 `tools/runtime-projection-tool-materializer.mjs` 暴露，不绕过投影。
- **非协商运行链**：Capability Provider → Manifest → Runtime Projection → Tool Call → PermissionGrant → Evidence，全链复用，不新建旁路。
- **agent-loop 零侵入**：不改 `anthropic-agent-loop.mjs` 串行执行；并发只在 Provider 内。
- **协议向后兼容**：lane 字段全 optional。
- **Module 取舍**：新增聚合 Provider 是"深 Module"（小 Interface：一次调用多 query；高 Leverage：并行+聚合+分路事件）。避免做成对 `search_files` 的浅包装——它新增了并发编排、聚合、分路证据三项实质 Leverage。

## 8. 涉及文件

| 文件 | 动作 | 子任务 |
|---|---|---|
| `docs/design/batch-search-parallel-aggregation.md` | 新增（本文件） | design-doc |
| `packages/protocol/src/execution.ts` | 扩展 `ToolCard` + 新增 `ToolCardLane`（lane 可选字段） | protocol-lane |
| `apps/desktop/electron/main/runtime-gateway/local-search-aggregate-provider.mjs` | 新增聚合 Provider | aggregate-provider |
| `apps/desktop/electron/main/runtime-gateway/local-file-provider.mjs` | 抽出/导出可复用 `runFileSearch`（若需要） | aggregate-provider |
| `apps/desktop/electron/main/tools/legacy-local-tool-definitions.mjs`（或新增定义文件）+ `tools/prompts/batch_search.txt` + `tools/index.mjs` + `tools/tool-registry.mjs` | 新增 `batch_search` 定义/prompt/注册 | tool-def |
| `apps/desktop/electron/main/runtime-gateway/local-tool-host.mjs` | 注册新 Provider 进 providerRegistry | host-wiring |
| `apps/desktop/renderer/src/chat/components/thread/*` + chat 状态/reducer（`packages/chat-kernel/src/*` 视归属） | 分路折叠 + 分路卡片 + 聚合面板 | renderer-ui |
| `*.test.mjs` / reducer 测试 + 视需要 `scripts/check-architecture-governance.mjs` | 单测/校验 | tests |

> 注：renderer reducer 实际归属待 renderer-ui 子任务核查确认（`apps/desktop/renderer/src/chat/` 与 `packages/chat-kernel/src/` 二者之一）。

## 9. 验证计划

- `local-search-aggregate-provider` 单测：并发执行、聚合去重、重排顺序、部分失败隔离、取消。
- reducer 单测：按 `toolCallId + laneId` 折叠子路状态机。
- 构建 + 架构治理检查（`scripts/check-architecture-governance.mjs`）通过。
- 回归确认：`search_files`、`anthropic-agent-loop` 行为不变。

## 10. 实现结果与边界决策（落地补记）

### 10.1 实际落点（相对计划的修正）

- 协议字段落在 `packages/protocol/src/execution.ts`（`ToolCard` 新增可选 `lanes`，新增 `ToolCardLane`），**非**计划中误写的 `runtime-gateway.ts`（该文件不存在）。
- `batch_search` 定义独立成 `apps/desktop/electron/main/tools/search-tool-definitions.mjs`（未塞进 legacy 定义文件），经 `tools/index.mjs` 接入 registry。
- Renderer reducer 归属确认为 `apps/desktop/renderer/src/chat/state/`（新增纯函数 `batchSearchLaneView.ts`）+ 组件 `components/thread/BatchSearchToolCard.tsx`，**非** `packages/chat-kernel/`。

### 10.2 explorer 模式边界决策

`batch_search` 一期 `availableInModes` 为 `['chat', 'goal']`，**不含 explorer**。
原因：explorer 子 Agent 的只读工具是 ADR 35 定义的显式 allowlist（`read_file` / `search_files`），
将 `batch_search` 纳入会扩展该 allowlist 契约，属 A 级且超出本方案"对核心 loop 零侵入"的边界。
`tool-registry.test.mjs` 对此 allowlist 有断言锁定，故本期保持不变；后续如需 explorer 使用聚合检索，
应作为独立的 ADR 35 契约评估推进。

### 10.3 实时分路进度的下一 seam

Provider 侧已留 `context.emitLaneProgress` 回调 seam 并在每条子路 started/completed 触发；
但"实时逐条 running 中间态"需要 `emitLaneProgress → IPC → ChatStreamEvent` 的跨进程通道。
本期 Renderer 先基于最终聚合 Evidence 的 `lanes` 字段还原分路视图（`buildBatchSearchView` 兜底），
实时流式作为后续显式 seam，不在本期扩大 IPC 改造面。

### 10.4 验证结论

- typecheck：`packages/protocol` 与 `apps/desktop` 均 `tsc --noEmit` 退出码 0。
- 新增聚焦测试：provider 10 用例 + reducer 7 用例，全部通过（17/17）。
- 全量 `npm test`（apps/desktop）：本变更引入的 2 个 explorer 投影回归已修复；剩余失败
  （`transport-blocked` 恢复 ×2、`llm chat service tool materialization`）经 `git stash` 基线复现，
  确认为**预先存在、与本变更无关**。
- 架构治理检查的失败项（AGENTS.md 文本、`docs/architecture/*` 被 git 跟踪）同样经基线复现，
  为预先存在；本变更未触碰 `AGENTS.md` 与 `docs/architecture/*`。
- agent-loop 无回归：未改 `anthropic-agent-loop.mjs`，并发收敛在 Provider 内。
