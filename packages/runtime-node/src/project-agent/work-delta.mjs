const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const copy = value => JSON.parse(JSON.stringify(value));
const fields = value => Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== undefined));

/** Storage adapter for the existing saveWork command; consumers never submit arbitrary JSON patches. */
export function encodeWorkUpdate(previous = {}, incoming) {
  const next = fields({ ...previous, ...incoming });
  const work = {}, removed = [];
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (key === 'budget' || key === 'progressFacts') continue;
    if (!(key in next)) removed.push(key);
    else if (!equal(previous[key], next[key])) work[key] = next[key];
  }
  const event = { kind: 'work_updated', workId: next.workId, work, removed };
  if (!equal(previous.budget, next.budget)) {
    event.budget = fields(next.budget);
    delete event.budget.observations;
    if (next.budget?.observations) event.observations = Object.keys(next.budget.observations).filter(key => !previous.budget?.observations?.[key]);
  }
  if (!equal(previous.progressFacts, next.progressFacts)) {
    const old = new Set(previous.progressFacts || []), fresh = new Set(next.progressFacts || []);
    event.progress = { add: [...fresh].filter(key => !old.has(key)), remove: [...old].filter(key => !fresh.has(key)) };
  }
  return copy(event);
}

export function applyWorkUpdate(previous, event) {
  if (!event.workId || !event.work || typeof event.work !== 'object' || Array.isArray(event.work)
    || event.work.workId && event.work.workId !== event.workId
    || Object.keys(event.work).some(key => ['__proto__', 'constructor', 'prototype', 'budget', 'progressFacts'].includes(key))) {
    throw new Error('coordination_work_update_invalid');
  }
  const next = { ...previous, ...copy(event.work), workId: event.workId };
  for (const key of event.removed || []) delete next[key];
  if (event.budget) next.budget = { ...copy(event.budget), ...(previous?.budget?.observations ? { observations: previous.budget.observations } : {}) };
  if (event.observations?.length) next.budget = { ...next.budget,
    observations: { ...next.budget?.observations, ...Object.fromEntries(event.observations.map(key => [key, true])) } };
  if (event.progress) next.progressFacts = [...new Set([...(previous?.progressFacts || []).filter(key => !event.progress.remove.includes(key)), ...event.progress.add])];
  return next;
}
