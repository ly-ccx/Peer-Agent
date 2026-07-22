/**
 * 输入框（草稿 + 待发送队列）的跨会话持久化。
 *
 * 设计边界（遵循能力代理治理基线）：
 * - 复用既有「用户设置」存储缝（~/.peer-agent/settings.json，主进程 settings-store 顶层浅合并），
 *   不另造执行路径，也不写 Chromium localStorage。表达层（ChatSurface）只读取/回写这一份偏好。
 * - 这是「表达层连续性」状态，不是 Tool Result / Evidence；队列项是用户的待发意图缓冲，
 *   不是已发送真值。真正的发送仍走 submitMessage → chatSend 单一路径。
 * - settings 顶层只占用一个 key（composerDrafts），其值是以 conversationId 为坐标的映射：
 *     { "<conversationId>": { draft, queue }, ... }
 *
 * 依赖方向：本模块通过一个可替换的 SettingsPort（Seam）读写设置，默认 Adapter 读
 * window.peerAgent。这样既不在表达层散落 IPC 细节，也让单测可注入假端口。
 *
 * 一致性：initialSettings 只是启动快照，写入后不会回填它；本模块在内存维护一份
 * 镜像（cache），启动时从 initialSettings 初始化，之后读写都以 cache 为准，并异步落盘。
 *
 * 取舍：草稿仅持久化「文本」，不持久化草稿区的附件（base64 dataUrl 可能很大，而
 * settings.json 在启动时被同步读取，写入大 blob 会拖慢启动）。已入队的消息（queue）按
 * 用户明确要求整体持久化，包含其附件——队列项是已提交的发送意图，需保真。
 */

const SETTINGS_KEY = 'composerDrafts';
const PERSIST_DEBOUNCE_MS = 300;

export interface PersistedAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'text' | 'unsupported';
  dataUrl?: string;
  text?: string;
}

export type PersistedEffort = 'off' | 'low' | 'default' | 'high' | 'xhigh' | 'max';

export interface PersistedQueuedMessage {
  id: string;
  text: string;
  attachments: PersistedAttachment[];
  effort: PersistedEffort;
}

export interface PersistedComposerEntry {
  /** 输入框中未发送的草稿文本。 */
  draft: string;
  /** 当前轮运行时排队、尚未发送的消息。 */
  queue: PersistedQueuedMessage[];
}

/** 设置读写缝：默认绑定 window.peerAgent；测试可注入假端口。 */
export interface ComposerSettingsPort {
  /** 启动快照（只读一次，用于初始化内存镜像）。 */
  readInitialSettings(): Record<string, unknown> | undefined;
  /** 写回部分设置（顶层浅合并）。 */
  updateSettings(partial: Record<string, unknown>): void;
}

type ComposerDraftMap = Record<string, PersistedComposerEntry>;

const defaultPort: ComposerSettingsPort = {
  readInitialSettings() {
    if (typeof window === 'undefined') return undefined;
    return window.peerAgent?.initialSettings as Record<string, unknown> | undefined;
  },
  updateSettings(partial) {
    if (typeof window === 'undefined') return;
    void window.peerAgent?.updateSettings(partial);
  },
};

let port: ComposerSettingsPort = defaultPort;
let cache: ComposerDraftMap | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let beforeUnloadHooked = false;
// 仅当确有未落盘的改动时才写回，避免 flush/卸载钩子产生无谓的 IPC 写入。
let dirty = false;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeEntry(raw: unknown): PersistedComposerEntry | null {
  if (!isPlainObject(raw)) return null;
  const draft = typeof raw.draft === 'string' ? raw.draft : '';
  const queue = Array.isArray(raw.queue) ? (raw.queue as PersistedQueuedMessage[]) : [];
  if (draft.length === 0 && queue.length === 0) return null;
  return { draft, queue };
}

function getMap(): ComposerDraftMap {
  if (cache) return cache;
  const raw = port.readInitialSettings()?.[SETTINGS_KEY];
  const next: ComposerDraftMap = {};
  if (isPlainObject(raw)) {
    for (const [id, entry] of Object.entries(raw)) {
      const clean = sanitizeEntry(entry);
      if (clean) next[id] = clean;
    }
  }
  cache = next;
  return cache;
}

function flushNow(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!cache || !dirty) return;
  dirty = false;
  // 回写整份 composerDrafts（settings 顶层浅合并，只覆盖这一个 key）。
  port.updateSettings({ [SETTINGS_KEY]: cache });
}

function schedulePersist(): void {
  dirty = true;
  if (typeof window !== 'undefined' && !beforeUnloadHooked) {
    beforeUnloadHooked = true;
    // 关闭/刷新前尽力落盘，缩小 debounce 窗口内丢失的可能（异步 IPC，尽力而为）。
    window.addEventListener('beforeunload', flushNow);
  }
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushNow();
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * 替换设置读写端口并重置内存镜像。仅供测试/特殊宿主使用；生产默认绑定 window.peerAgent。
 */
export function __setComposerSettingsPort(next: ComposerSettingsPort | null): void {
  port = next ?? defaultPort;
  cache = null;
  dirty = false;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}

/** 立即把待落盘的输入框状态写出（取消 debounce）。供应用退出/测试等需要确定性落盘的场景。 */
export function flushComposerPersistence(): void {
  flushNow();
}

/** 读取某会话已持久化的输入框状态；无则返回 null。 */
export function loadComposerEntry(conversationId: string): PersistedComposerEntry | null {
  const map = getMap();
  const entry = map[conversationId];
  return entry ? { draft: entry.draft, queue: entry.queue } : null;
}

/** 输入叶子重新挂载时，仅阻止初始空态覆盖尚待恢复的磁盘数据。 */
export function shouldDeferEmptyComposerSave(
  hydrationReady: boolean,
  draft: string,
  queue: readonly unknown[],
  persisted: PersistedComposerEntry | null,
): boolean {
  return !hydrationReady && draft.length === 0 && queue.length === 0 && persisted !== null;
}

/**
 * 切换会话时决定 composer 草稿/队列用哪一份真值。
 *
 * 规则：
 * - 会话桶里已有草稿或队列（同会话二次进入）→ 保留内存态，避免被尚未落盘的空持久化覆盖；
 * - 内存为空 → 回落持久化（冷启动 / 首次进入该会话）。
 *
 * 这样「入队后立刻切走再切回」不会把 UI 冲成空队列，同时仍支持跨重启恢复。
 */
export function resolveComposerHydration(
  live: { readonly draft: string; readonly messageQueue: readonly unknown[] },
  persisted: PersistedComposerEntry | null,
): { draft: string; queue: PersistedQueuedMessage[] | readonly unknown[]; source: 'live' | 'persisted' } {
  if (live.draft.length > 0 || live.messageQueue.length > 0) {
    return { draft: live.draft, queue: live.messageQueue, source: 'live' };
  }
  return {
    draft: persisted?.draft ?? '',
    queue: persisted?.queue ?? [],
    source: 'persisted',
  };
}

/**
 * 写入某会话的输入框状态（debounce 落盘）。
 * 当草稿为空且队列为空时，移除该会话条目，避免 settings 里堆积空壳。
 */
export function saveComposerEntry(conversationId: string, entry: PersistedComposerEntry): void {
  if (!conversationId) return;
  const map = getMap();
  const draft = entry.draft ?? '';
  const queue = entry.queue ?? [];
  if (draft.length === 0 && queue.length === 0) {
    if (!(conversationId in map)) return;
    delete map[conversationId];
  } else {
    map[conversationId] = { draft, queue };
  }
  schedulePersist();
}

/** 删除某会话的输入框持久化条目（如会话被删除时调用）。 */
export function clearComposerEntry(conversationId: string): void {
  if (!conversationId) return;
  const map = getMap();
  if (!(conversationId in map)) return;
  delete map[conversationId];
  schedulePersist();
}
