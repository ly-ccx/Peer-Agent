import assert from 'node:assert/strict';
import test from 'node:test';
import { attachmentsFromMessages } from './session-supervisor.mjs';

test('delegation carries only attachments belonging to its anchor messages', () => {
  const attachment = { id: 'doc', name: 'brief.md', size: 4, mimeType: 'text/markdown',
    sourceKind: 'user_upload', kind: 'text', text: 'fact' };
  const messages = [{ id: 'wanted', attachments: [attachment] },
    { id: 'other', attachments: [{ ...attachment, id: 'secret', text: 'not requested' }] }];
  assert.deepEqual(attachmentsFromMessages(messages, ['wanted']), [attachment]);
  assert.deepEqual(attachmentsFromMessages(messages, []), []);
});

test('delegation does not silently truncate a collection of anchored uploads', () => {
  const messages = Array.from({ length: 9 }, (_, i) => ({ id: `${i}`, attachments: [{ id: `f${i}`,
    name: 'file', size: 0, mimeType: 'application/pdf', sourceKind: 'user_upload', kind: 'unsupported' }] }));
  assert.throws(() => attachmentsFromMessages(messages, messages.map(m => m.id)), /more than 8 attachments/);
});
