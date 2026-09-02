import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createTaskAcceptancePromptSource,
  extractAcceptancePins,
  firstUserMessageText,
  lastUserMessageText,
  normalizeTaskAcceptance,
  taskAcceptanceFromMessages,
  TASK_ACCEPTANCE_BRIEF_LIMIT,
  TASK_ACCEPTANCE_PIN_LIMIT,
} from './task-acceptance-source.mjs';

const MASHUMARO_INSTRUCTION = [
  'Implement flatten support for dataclass fields in mashumaro.',
  '',
  'IMPORTANT: flatten_rename keys must be the original field names, not the keys after serialization.',
  '',
  'Also, when a child sets serialize_by_alias, unmapped fields must keep their own alias (fieldB), while mapped fields still use the rename value (my_field -> custom_field).',
  '',
  'These two settings are mutually exclusive for key lookup: validate flatten_rename against the field-name axis, then apply alias only for leftovers.',
  '',
  'You must not treat a green single-axis suite as done.',
  '',
  'Commit the change only after the child serialize_by_alias cross cases pass.',
].join('\n');

test('extractAcceptancePins keeps mashumaro-style contract pins in document order', () => {
  const pins = extractAcceptancePins(MASHUMARO_INSTRUCTION);
  assert.ok(pins.length >= 4);
  assert.ok(pins.length <= TASK_ACCEPTANCE_PIN_LIMIT);
  assert.ok(pins.some((pin) => /IMPORTANT/.test(pin) && /flatten_rename/.test(pin)));
  assert.ok(pins.some((pin) => /serialize_by_alias/.test(pin) && /keep their own/.test(pin)));
  assert.ok(pins.some((pin) => /mutually exclusive/.test(pin) && /validate/.test(pin)));
  assert.ok(pins.some((pin) => /\bcommit\b/i.test(pin)));
});

test('normalizeTaskAcceptance clips the brief and derives pins from text', () => {
  const acceptance = normalizeTaskAcceptance(MASHUMARO_INSTRUCTION);
  assert.ok(acceptance);
  assert.equal(acceptance.source, 'text');
  assert.match(acceptance.brief, /mashumaro/);
  assert.ok(acceptance.pins.some((pin) => /serialize_by_alias/.test(pin)));

  const oversized = `${'x'.repeat(TASK_ACCEPTANCE_BRIEF_LIMIT + 80)} must validate this pin`;
  const clipped = normalizeTaskAcceptance(oversized);
  assert.ok(clipped.brief.endsWith('…'));
  assert.ok(clipped.brief.length <= TASK_ACCEPTANCE_BRIEF_LIMIT);
});

test('normalizeTaskAcceptance honors explicit pins and ignores empty input', () => {
  assert.equal(normalizeTaskAcceptance(''), null);
  assert.equal(normalizeTaskAcceptance({}), null);
  const acceptance = normalizeTaskAcceptance({
    brief: 'Keep the original task in view.',
    pins: ['must validate the rename axis', 'must validate the rename axis', 'commit after both axes pass'],
    source: 'host',
  });
  assert.equal(acceptance.source, 'host');
  assert.deepEqual(acceptance.pins, [
    'must validate the rename axis',
    'commit after both axes pass',
  ]);
});

test('firstUserMessageText reads string and multimodal user parts', () => {
  assert.equal(firstUserMessageText([]), '');
  assert.equal(firstUserMessageText([
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: [{ type: 'text', text: 'IMPORTANT: keep field names' }] },
  ]), 'IMPORTANT: keep field names');
});

test('task-acceptance source stays dark without input and renders L7 facts when pinned', () => {
  const source = createTaskAcceptancePromptSource();
  assert.equal(source.id, 'runtime.task-acceptance');
  assert.equal(source.layer, 'L7_CONTINUITY');
  assert.deepEqual(source.render(source.observe({})), []);
  assert.deepEqual(source.render(source.observe({ mode: 'chat' })), []);

  const sections = source.render(source.observe({ taskAcceptance: MASHUMARO_INSTRUCTION }));
  assert.equal(sections.length, 1);
  assert.equal(sections[0].id, 'runtime.task-acceptance');
  assert.equal(sections[0].layer, 'L7_CONTINUITY');
  assert.match(sections[0].content, /Host-pinned original task/);
  assert.match(sections[0].content, /flatten_rename/);
  assert.match(sections[0].content, /serialize_by_alias/);
  assert.equal(sections[0].source.kind, 'task-acceptance');
  assert.ok(sections[0].source.pinCount >= 4);
});

test('taskAcceptanceFromMessages overlays later user direction on the original brief', () => {
  assert.equal(lastUserMessageText([
    { role: 'user', content: '先发布到线上' },
    { role: 'assistant', content: '好' },
    { role: 'user', content: '先别发线上，剩下的不用继续' },
  ]), '先别发线上，剩下的不用继续');

  const acceptance = taskAcceptanceFromMessages([
    { role: 'user', content: '先发布到线上并验证网关注册' },
    { role: 'assistant', content: '开始做' },
    { role: 'user', content: '先别发线上，剩下的不用继续' },
  ]);
  assert.match(acceptance.brief, /先发布到线上/);
  assert.match(acceptance.brief, /Later user direction \(overrides withdrawn scope\)/);
  assert.match(acceptance.brief, /先别发线上，剩下的不用继续/);

  const source = createTaskAcceptancePromptSource();
  const sections = source.render(source.observe({ taskAcceptance: acceptance }));
  assert.match(sections[0].content, /## Original brief/);
  assert.match(sections[0].content, /overrides withdrawn scope/);
  assert.match(sections[0].content, /先别发线上/);
});
