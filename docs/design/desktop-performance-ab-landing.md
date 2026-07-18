# 桌面端性能根治 Phase A+B 落地状态

> 更新时间：2026-07-18  
> 状态：**A+B 已落地（代码 + 测试）**  
> 设计来源：`peer-knowledge/design/product/desktop-performance-root-cause-design.md`

## 落地摘要

### Phase A — list 热路径与分页

| 项 | 状态 | 说明 |
|---|---|---|
| list 永不读会话正文 | ✅ | 缺 `messageCount` 返回 `0` 占位，`scheduleMessageCountMigration` 后台回填 |
| 显式 backfill | ✅ | `backfillMessageCount: true` 才同步扫 jsonl |
| limit/cursor 分页 | ✅ | `paginated: true` 返回 `{ items, nextCursor, hasMore, total }` |

关键文件：`packages/conversation-store/src/index.mjs`、`apps/desktop/electron/main/main.mjs`（`conversations:list`）

### Phase B — 侧栏 / 徽标 / 刷新

| 项 | 状态 | 说明 |
|---|---|---|
| 首屏只拉第一页 | ✅ | `CONVERSATION_LIST_PAGE_SIZE = 40`；bootstrap / refresh 均 `limit+paginated` |
| 滚动加载更多 | ✅ | Sidebar `onScroll` +「加载更多」按钮 |
| Goal 徽标解耦全量 list | ✅ | `goalPlans:awaiting-counts` + `goalPlansAwaitingCounts`；不再 `goalPlansList({})` |
| 变更/focus 防抖 | ✅ | `scheduleConversationRefresh` 120ms 防抖，只重拉第一页 |

关键文件：`useDesktopBootstrap.ts`、`App.tsx`、`Sidebar.tsx`、`useAwaitingGoalPlans.ts`、`goal-plan-store.mjs`

## 验收

```text
node --test apps/desktop/electron/main/conversation-store.test.mjs
# 36 pass / 0 fail
```

覆盖：
- `listConversations never reads conversation body on hot path`
- `listConversations supports limit/cursor pagination`

## 未做（后续 C/D/E）

- 内容路径 tail 窗口（Phase C）
- 后台任务优先级调度（Phase D）
- 完整 performance budget 探针（Phase E）
