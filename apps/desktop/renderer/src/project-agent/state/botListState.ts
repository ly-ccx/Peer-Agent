/**
 * 机器人列表的纯投影。排序用协议 sortBotList（最近活动，同刻稳定）。
 * 搜索结果来自 project-agent:search，这里只把它和本地行合并，避免角标被旧命中盖住。
 * 名字规则与 main 的 cleanDisplayName / cleanManagedName 对齐，渲染进程不读文件系统。
 */
import { filterBotList, sortBotList, type BotListItem } from '@peer-agent/protocol';

export const BOT_LIST_WIDTH_DEFAULT = 292;
export const BOT_LIST_WIDTH_MIN = 240;
export const BOT_LIST_WIDTH_MAX = 360;
export const BOT_LIST_WIDTH_STORAGE_KEY = 'peer.projectAgent.botListWidth';

const NAME_MAX = 40;
const RESERVED_MANAGED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function clampBotListWidth(value: number): number {
  if (!Number.isFinite(value)) return BOT_LIST_WIDTH_DEFAULT;
  return Math.min(BOT_LIST_WIDTH_MAX, Math.max(BOT_LIST_WIDTH_MIN, Math.round(value)));
}

export function readBotListWidth(raw: string | null | undefined): number {
  if (raw == null || raw.trim() === '') return BOT_LIST_WIDTH_DEFAULT;
  return clampBotListWidth(Number(raw));
}

/** 与 bot-profile-store.cleanDisplayName 同一套清洗。空结果返回空串。 */
export function cleanBotDisplayName(value: string): string {
  const stripped = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '')
    .replace(/[\u200b-\u200f\u202a-\u202e]/g, '')
    .trim()
    .replace(/[. ]+$/g, '')
    .trim();
  return Array.from(stripped).slice(0, NAME_MAX).join('');
}

/** 空白机器人的名字。无效时与 main 一样返回 INVALID_NAME。 */
export function validateManagedBotName(value: string): { ok: true; name: string } | { ok: false; code: 'INVALID_NAME' } {
  const name = cleanBotDisplayName(value);
  if (!name || name === '.' || name === '..' || RESERVED_MANAGED_NAME.test(name)) {
    return { ok: false, code: 'INVALID_NAME' };
  }
  return { ok: true, name };
}

export function sumNeedsYou(items: readonly BotListItem[]): number {
  return items.reduce((total, item) => total + item.state.needsYou, 0);
}

/** 先按最近活动排，再套「需要你」筛选。筛选不改顺序。 */
export function visibleBotList(
  items: readonly BotListItem[],
  filter: { readonly needsYouOnly?: boolean } = {},
): BotListItem[] {
  return filterBotList(sortBotList(items), {
    needsYouOnly: filter.needsYouOnly === true,
  });
}

/**
 * 搜索命中覆盖可见集。同一 workspaceId 保留本地行，这样未读和需要你不会被搜索快照冲掉。
 * 只在搜索里出现的行（例如任务标题命中）照样留下。
 */
export function mergeBotSearch(
  catalog: readonly BotListItem[],
  hits: readonly BotListItem[],
): BotListItem[] {
  const local = new Map(catalog.map((item) => [item.workspaceId, item]));
  return sortBotList(hits.map((hit) => local.get(hit.workspaceId) ?? hit));
}

/** 局部刷新：有新投影就替换或插入，空投影表示归档或消失。结果重新排序。 */
export function applyBotRefresh(
  items: readonly BotListItem[],
  updates: readonly { readonly workspaceId: string; readonly item: BotListItem | null }[],
): BotListItem[] {
  let next = [...items];
  for (const update of updates) {
    if (!update.item) {
      next = next.filter((item) => item.workspaceId !== update.workspaceId);
      continue;
    }
    const index = next.findIndex((item) => item.workspaceId === update.workspaceId);
    if (index >= 0) next[index] = update.item;
    else next.push(update.item);
  }
  return sortBotList(next);
}

/** 选中的机器人还在全量列表里就保持，即使当前筛选把它藏起来。离开列表才放开。 */
export function retainSelectedId(selectedId: string | null, items: readonly BotListItem[]): string | null {
  if (!selectedId) return null;
  return items.some((item) => item.workspaceId === selectedId) ? selectedId : null;
}

export function moveBotSelection(
  visible: readonly BotListItem[],
  selectedId: string | null,
  delta: -1 | 1,
): string | null {
  if (visible.length === 0) return selectedId;
  const index = visible.findIndex((item) => item.workspaceId === selectedId);
  if (index < 0) return visible[delta > 0 ? 0 : visible.length - 1]!.workspaceId;
  const next = Math.min(visible.length - 1, Math.max(0, index + delta));
  return visible[next]!.workspaceId;
}

export function enterBotSelection(visible: readonly BotListItem[], highlightedId: string | null): string | null {
  if (visible.length === 0) return null;
  if (highlightedId && visible.some((item) => item.workspaceId === highlightedId)) return highlightedId;
  return visible[0]!.workspaceId;
}

export function formatBotListTime(iso: string, now = Date.now()): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return '';
  const date = new Date(parsed);
  const today = new Date(now);
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hours}:${minutes}`;
  return `${date.getMonth() + 1}/${date.getDate()}`;
}
