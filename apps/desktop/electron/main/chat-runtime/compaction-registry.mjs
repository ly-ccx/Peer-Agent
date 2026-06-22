// 压缩态登记表（ADR：压缩横幅真值归属主进程，按 conversationId 索引）。
//
// 背景：压缩横幅此前完全由渲染层组件 state 驱动，切会话时 state 不跟随会话，
// 导致 A 会话触发的压缩横幅会"粘"在任意切入的会话上。修复方式是把"哪个会话
// 正在压缩、进度多少"这一运行真值上移到主进程，按 conversationId 索引；渲染层
// 切会话时查询本表恢复横幅，自身只负责表达。
//
// 自动压缩（compaction-coordinator）与手动 /compact（main.mjs 的 chat:compact）
// 两条路径都在各自 emit 'chat:compaction' 事件的同一处同步写入本表，保证事件流
// 与可查询真值单一来源、不漂移。
//
// 这是一个进程内的小接口深模块：Map + 4 个方法，无外部依赖，便于单测。

/** @type {Map<string, { streamId: string, percent: number | null, manual: boolean, startedAt: number }>} */
const registry = new Map();

/**
 * 标记某会话开始压缩。重复 begin（同会话再次触发）以最新一次为准。
 * @param {{ conversationId?: string | null, streamId?: string | null, manual?: boolean }} params
 */
export function beginCompaction({ conversationId, streamId, manual = false } = {}) {
  if (!conversationId || !streamId) return;
  registry.set(conversationId, {
    streamId,
    percent: null,
    manual: Boolean(manual),
    startedAt: Date.now(),
  });
}

/**
 * 更新某会话的压缩进度（字符级真实进度）。仅当 streamId 与登记一致时生效，
 * 避免迟到的旧流进度覆盖新一轮压缩。
 * @param {{ conversationId?: string | null, streamId?: string | null, percent?: number | null }} params
 */
export function updateCompactionProgress({ conversationId, streamId, percent } = {}) {
  if (!conversationId || !streamId) return;
  const entry = registry.get(conversationId);
  if (!entry || entry.streamId !== streamId) return;
  entry.percent = typeof percent === 'number' ? percent : entry.percent;
}

/**
 * 结束某会话的压缩（done / idle / 失败均调用）。仅当 streamId 与登记一致时清除，
 * 避免旧流的收尾误清掉新一轮压缩的进行态。
 * @param {{ conversationId?: string | null, streamId?: string | null }} params
 */
export function endCompaction({ conversationId, streamId } = {}) {
  if (!conversationId) return;
  const entry = registry.get(conversationId);
  if (!entry) return;
  // streamId 缺省时无条件清除（兜底）；提供时要求匹配。
  if (streamId && entry.streamId !== streamId) return;
  registry.delete(conversationId);
}

/**
 * 查询某会话当前压缩态。供渲染层切会话时恢复横幅。
 * @param {string | null | undefined} conversationId
 * @returns {{ compacting: true, streamId: string, percent: number | null, manual: boolean } | null}
 */
export function getCompaction(conversationId) {
  if (!conversationId) return null;
  const entry = registry.get(conversationId);
  if (!entry) return null;
  return {
    compacting: true,
    streamId: entry.streamId,
    percent: entry.percent,
    manual: entry.manual,
  };
}

/** 测试辅助：清空登记表。 */
export function __resetCompactionRegistry() {
  registry.clear();
}
