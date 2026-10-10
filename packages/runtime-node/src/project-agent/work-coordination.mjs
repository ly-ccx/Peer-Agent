import { createHash } from 'node:crypto';
import { reduceCoordinationDecision } from './coordination-kernel.mjs';
/** Durable event transfer and handling are different receipts. Replay is deterministic. */
export function reduceCoordination(state, entry) {
  const previous = state || { revision: 0, events: {}, works: {}, deliveries: {} };
  let next = { ...previous, events: { ...previous.events }, works: { ...previous.works }, deliveries: { ...previous.deliveries } };
  if (entry.revision !== next.revision + 1) throw new Error('coordination_revision_gap');
  next.revision = entry.revision;
  if (['coordination_decision', 'coordination_binding', 'coordination_transition'].includes(entry.kind)) {
    next = reduceCoordinationDecision(next, entry);
  } else if (entry.kind === 'transfer') {
    for (const event of entry.events) next.events[event.eventId] ||= { event: structuredClone(event), handled: false };
  } else if (entry.kind === 'handled') {
    for (const id of entry.eventIds) {
      if (!next.events[id]) throw new Error('event_not_transferred');
      next.events[id] = { ...next.events[id], handled: true };
    }
  } else if (entry.kind === 'work') {
    next.works[entry.work.workId] = structuredClone(entry.work);
  } else if (entry.kind === 'reply_prepared') {
    next.deliveries[entry.message.id] ||= { message: structuredClone(entry.message), state: 'prepared' };
  } else if (entry.kind === 'reply_delivered') {
    const delivery = next.deliveries[entry.messageId];
    if (!delivery) throw new Error('reply_not_prepared');
    next.deliveries[entry.messageId] = { ...delivery, state: 'delivered' };
  } else if (entry.kind === 'reply_invalidated') {
    const delivery = next.deliveries[entry.messageId];
    if (!delivery) throw new Error('reply_not_prepared');
    next.deliveries[entry.messageId] = { ...delivery, state: 'invalidated', reason: entry.reason };
  } else if (entry.kind === 'journal_recovered') {
    next.lastRecovery = { at: entry.at, backup: entry.backup };
  } else throw new Error('unknown_coordination_event');
  return next;
}

export function coordinationWorkId(conversationId, inputIds) {
  return `work-${createHash('sha256').update(JSON.stringify([conversationId, [...new Set(inputIds)].sort()])).digest('hex')}`;
}
