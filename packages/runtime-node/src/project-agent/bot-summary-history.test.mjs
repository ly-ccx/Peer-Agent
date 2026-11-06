import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotSummaryHistory, projectBotSummaryHistory } from './bot-summary-history.mjs';
import { projectBotListMessage } from './bot-directory.mjs';
import { replyQuestionAnswered } from './card-projection.mjs';

test('summary records bound process bodies while preserving preview, question and unread semantics', () => {
  const messages = [
    { id:'i',kind:'agent_turn',role:'assistant',rounds:[{text:'private process'.repeat(100000)}] },
    { id:'q',kind:'agent_reply',role:'assistant',content:'  项 '.repeat(200),question:{prompt:'which?',answered:false},meta:{surfacing:'silent',unread:false} },
    { id:'answer',kind:'user_input',role:'user',content:'B',answerTo:'card:question:reply:q' },
    { id:'attachment',kind:'user_input',role:'user',content:'',attachments:[{name:'one.png',data:'private pixels'}] },
  ];
  const summary=projectBotSummaryHistory({messages});
  for (const row of messages.slice(1)) assert.deepEqual(projectBotListMessage(summary.find(s=>s.id===row.id)),projectBotListMessage(row));
  assert.equal(replyQuestionAnswered(summary,summary[1]),replyQuestionAnswered(messages,messages[1]));
  assert.ok(JSON.stringify(summary).length<1500);assert.ok(!JSON.stringify(summary).includes('private'));
});

test('list summaries stay on materialized previews and do not load full history when the revision is unchanged', () => {
  let tails = 0;
  const previews = new Map(Array.from({ length: 200 }, (_, i) => [String(i), {
    availability: 'ready', excerpt: 'preview 1', contentRevision: 1, messageId: String(i), role: 'assistant', kind: 'agent_reply',
  }]));
  const store = {
    readSessionPreview(id) { return previews.get(id) ?? null; },
    readConversationWindow() { tails += 1; return { window: [] }; },
    getPersistedConversationHistory() { throw new Error('FULL_HISTORY'); },
    createHistoryProjection() { throw new Error('FULL_HISTORY'); },
  };
  const read = createBotSummaryHistory(store);
  for (let round = 0; round < 5; round += 1) {
    for (const id of previews.keys()) assert.equal(read(id)[0].content, 'preview 1');
  }
  assert.equal(tails, 0);
  previews.set('73', { ...previews.get('73'), excerpt: 'preview 2', contentRevision: 2 });
  assert.equal(read('73')[0].content, 'preview 2');
  assert.equal(tails, 0);
});
test('only the current question carries bounded public context; older large replies never grow the list snapshot', () => {
  const messages = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), kind: 'agent_reply', role: 'assistant',
    content: 'public preface '.repeat(1000) + 'Concrete decision at the end', question: { options: ['A', 'B'] } }));
  const summary = projectBotSummaryHistory({ messages });
  assert.equal(summary.filter(row => row.questionContext).length, 1);
  assert.equal(summary.at(-1).questionContext.length, 2000);
  assert.ok(summary.at(-1).questionContext.endsWith('Concrete decision at the end'));
  assert.ok(JSON.stringify(summary).length < 250000);
});

test('a preview cache miss reads a tail window and never the full history', () => {
  let windowOptions = null;
  const store = {
    readSessionPreview() { return { availability: 'rebuilding', excerpt: '', contentRevision: 4, messageId: '' }; },
    readConversationWindow(_id, options) {
      windowOptions = options;
      return { window: [{ id: 'm', role: 'assistant', kind: 'agent_reply', content: 'tail text' }] };
    },
    getPersistedConversationHistory() { throw new Error('FULL_HISTORY'); },
    createHistoryProjection() { throw new Error('FULL_HISTORY'); },
  };
  const read = createBotSummaryHistory(store);
  assert.equal(read('c')[0].content, 'tail text');
  assert.equal(read('c')[0].content, 'tail text');
  assert.equal(windowOptions.full, undefined);
  assert.equal(windowOptions.limit > 0, true);
});

test('short and long Unicode previews preserve ordinary code point and whitespace semantics', () => {
  for (const text of ['short  text', '中文 '.repeat(120), '😀'.repeat(100), ' '.repeat(20) + 'A\nB\tC', 'x'.repeat(80) + ' y']) {
    for (const limit of [80, 0, -3, 80.5, NaN]) {
      const expected = Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, limit).join('');
      assert.equal(projectBotListMessage({ role: 'assistant', content: text }, limit).text, expected);
    }
  }
});
