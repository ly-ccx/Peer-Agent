import test from 'node:test';
import assert from 'node:assert/strict';
import { projectBotSummaryHistory } from './bot-summary-history.mjs';
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

test('200 bot summaries stay warm within the bounded metadata cache and changed versions invalidate exactly one', () => {
  const versions = new Map(Array.from({length:200},(_,i)=>[String(i),1])); let loads=0; let options;
  const store={createHistoryProjection(project,opts){options=opts;return createHistoryProjectionReader({...opts,project,
    describe:id=>({id,version:versions.get(id)}),load:({id})=>{loads++;return {messages:[{id,role:'assistant',kind:'agent_reply',content:'preview '+versions.get(id)}]};}});}};
  const read=createBotSummaryHistory(store);
  for(let round=0;round<5;round++)for(const id of versions.keys())assert.equal(read(id)[0].content,'preview 1');
  assert.equal(loads,200);assert.equal(options.maxBytes,8*1024*1024);assert.ok(options.maxEntries<=512);
  versions.set('73',2);assert.equal(read('73')[0].content,'preview 2');assert.equal(loads,201);
});
import { createBotSummaryHistory } from './bot-summary-history.mjs';
import { createHistoryProjectionReader } from '../../../conversation-store/src/history-projection-reader.mjs';


test('only the current question carries bounded public context; older large replies never grow the list snapshot', () => {
  const messages = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), kind: 'agent_reply', role: 'assistant',
    content: 'public preface '.repeat(1000) + 'Concrete decision at the end', question: { options: ['A', 'B'] } }));
  const summary = projectBotSummaryHistory({ messages });
  assert.equal(summary.filter(row => row.questionContext).length, 1);
  assert.equal(summary.at(-1).questionContext.length, 2000);
  assert.ok(summary.at(-1).questionContext.endsWith('Concrete decision at the end'));
  assert.ok(JSON.stringify(summary).length < 250000);
});
