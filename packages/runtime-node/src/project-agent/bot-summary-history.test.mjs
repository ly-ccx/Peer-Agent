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
