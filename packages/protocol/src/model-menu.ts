/** Presentation-only model menu projection shared by local clients. No sorting or deduplication. */
export function modelMenuChannelName(name: string | undefined, model: string, authMethod: string | undefined, isZh: boolean): string {
  const trimmed = name?.trim();
  if (authMethod === 'oauth_chatgpt' && (!trimmed || trimmed === 'ChatGPT 订阅' || trimmed === 'ChatGPT Subscription')) {
    return isZh ? 'ChatGPT 订阅' : 'ChatGPT Subscription';
  }
  return trimmed || model;
}

export interface ModelMenuRow {
  readonly id: string;
  readonly groupId?: string;
  readonly groupLabel: string;
  readonly model: string;
  readonly modelLabel?: string;
  readonly available: boolean;
}

export function buildModelMenuGroups(rows: readonly ModelMenuRow[], hideDisabled = false) {
  const groups = new Map<string, { id: string; label: string; items: { id: string; label: string; disabled: boolean }[] }>();
  for (const row of rows) {
    const key = row.groupId || row.id;
    let group = groups.get(key);
    if (!group) {
      group = { id: key, label: row.groupLabel, items: [] };
      groups.set(key, group);
    }
    if (!hideDisabled || row.available) {
      group.items.push({ id: row.id, label: row.modelLabel || row.model, disabled: !row.available });
    }
  }
  return [...groups.values()]
    .filter((group) => !hideDisabled || group.items.length > 0)
    .map((group) => ({ ...group, disabled: group.items.every((item) => item.disabled) }));
}
