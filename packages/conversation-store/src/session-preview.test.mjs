import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assignSessionPreview,
  coerceSessionPreview,
  previewFactsFromMessage,
  previewFactsFromMessages,
  truncatePreview,
} from './session-preview.mjs';

test('preview truncation counts code points and collapses whitespace', () => {
  assert.equal(truncatePreview('  项 \n 目  '), '项 目');
  assert.equal(Array.from(truncatePreview('😀'.repeat(100))).length, 80);
  assert.equal(truncatePreview('中文'.repeat(50)).length, 80);
});

test('internal turns and verdict cards do not become the list excerpt', () => {
  const messages = [
    { id: 'user', role: 'user', kind: 'user_input', content: '核对结果' },
    { id: 'turn', role: 'assistant', kind: 'agent_turn', rounds: [{ text: 'private process' }] },
    { id: 'reply', role: 'assistant', kind: 'agent_reply', content: '结果仍有一项尚未核验。' },
    { id: 'verdict', role: 'assistant', kind: 'system_card', content: 'passed',
      cards: [{ kind: 'verdict', content: 'passed' }] },
    { id: 'tool', role: 'assistant', kind: 'tool_result', content: '工具原文不进预览' },
  ];
  assert.equal(previewFactsFromMessage(messages[1]), null);
  assert.equal(previewFactsFromMessage(messages[3]), null);
  assert.equal(previewFactsFromMessages(messages).excerpt, '结果仍有一项尚未核验。');
  assert.equal(previewFactsFromMessages(messages).messageId, 'reply');
});

test('an attachment-only message previews the filename and a later hidden row keeps it', () => {
  const meta = { id: 'c', title: '会话', contentRevision: 2, updatedAt: '2026-11-05T00:00:00.000Z' };
  assignSessionPreview(meta, {
    id: 'upload', role: 'user', kind: 'user_input', content: '',
    attachments: [{ name: 'diagram.png', data: 'private pixels' }],
  });
  assert.equal(meta.preview.excerpt, 'diagram.png');
  assert.deepEqual(meta.preview.attachmentNames, ['diagram.png']);
  assert.equal(JSON.stringify(meta.preview).includes('private'), false);
  meta.contentRevision = 3;
  assignSessionPreview(meta, { id: 'tool', role: 'assistant', kind: 'tool_result', content: '隐藏' });
  assert.equal(meta.preview.excerpt, 'diagram.png');
  assert.equal(meta.preview.contentRevision, 3);
});

test('a preview from another revision is rebuilding and does not keep the stale excerpt', () => {
  const preview = coerceSessionPreview({
    id: 'c',
    title: '标题',
    contentRevision: 4,
    updatedAt: '2026-11-05T00:00:00.000Z',
    preview: { excerpt: '旧摘要', contentRevision: 3, availability: 'ready' },
  });
  assert.equal(preview.availability, 'rebuilding');
  assert.equal(preview.excerpt, '');
  assert.equal(preview.contentRevision, 4);
});
