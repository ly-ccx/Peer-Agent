/**
 * 用户引用某条回复说话时，这句话只作用于那条回复涉及的任务。
 * 没有引用时范围是整个项目。spawn 不走这里。
 */

export function resolveAnchorScope({ messages, quoteRefs, replyTo } = {}) {
  const list = Array.isArray(messages) ? messages.filter((item) => item && typeof item === 'object') : [];
  const byId = new Map();
  for (const message of list) {
    const id = messageId(message);
    if (id && !byId.has(id)) byId.set(id, message);
  }
  const triggers = triggeringUsers(list);
  if (triggers.length === 0) {
    const seeds = [...quoteSeeds(quoteRefs), ...idList(replyTo)];
    if (seeds.length === 0) return unscoped();
    return collect(seeds, byId);
  }
  if (triggers.some((message) => utteranceSeeds(message).length === 0)) return unscoped();
  return collect(triggers.flatMap((message) => utteranceSeeds(message)), byId);
}

function unscoped() {
  return { scoped: false, sessionIds: [] };
}

function collect(seeds, byId) {
  const sessionIds = [];
  const seen = new Set();
  const queue = [...seeds];
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const message = byId.get(id);
    if (!message) continue;
    for (const sessionId of sessionIdsOn(message)) pushUnique(sessionIds, sessionId);
    for (const next of chainIds(message)) queue.push(next);
  }
  return { scoped: true, sessionIds };
}

function triggeringUsers(list) {
  const found = [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (!isUser(message)) break;
    found.push(message);
  }
  return found.reverse();
}

function isUser(message) {
  const kind = message?.kind || message?.type || message?.messageKind;
  if (kind === 'user_input') return true;
  if (typeof kind === 'string' && kind) return false;
  return message?.role === 'user';
}

function utteranceSeeds(message) {
  return [...quoteSeeds(message?.quoteRefs), ...idList(message?.replyTo)];
}

function quoteSeeds(quoteRefs) {
  const refs = idList(quoteRefs);
  if (refs.length === 0) return [];
  return [refs[0]];
}

function chainIds(message) {
  return [...idList(message?.replyTo), ...quoteSeeds(message?.quoteRefs)];
}

function sessionIdsOn(message) {
  const ids = [
    ...idList(message?.sources),
    ...idList(message?.meta?.sources),
    ...idList(message?.sessionIds),
  ];
  const single = text(message?.sessionId);
  if (single) ids.push(single);
  return ids;
}

function messageId(message) {
  return text(message?.id) || text(message?.messageId);
}

function idList(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const item of value) {
    const id = text(item);
    if (id) pushUnique(ids, id);
  }
  return ids;
}

function pushUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}
