import test from 'node:test';
import assert from 'node:assert/strict';
import { reportedWaitFor, reportedWaitCurrent } from './reported-wait.mjs';
import { prepareReplyReport } from './reply-report-facts.mjs';
const fact={sessionId:'s',status:'waiting_agent',sourceRevision:'r'};
const message={id:'reply',kind:'agent_reply',sources:['s'],meta:{sessionStates:[fact]}};
const setup=()=>({job:{kind:'wake',userInputs:[]},outcome:{rounds:[{toolCalls:[{name:'post_reply',result:{ok:true,suppressed:true,reportedReplyIds:['reply'],sessionStates:[fact]}}]}]},state:{deliveries:{reply:{state:'delivered'}}},messages:[message],sessions:[fact]});
test('hidden report needs actual canonical delivery and current source facts; never substitutes for a new user reply',()=>{
 const f=setup();assert.ok(reportedWaitFor(f));
 for(const change of [{state:{deliveries:{}}},{state:{deliveries:{reply:{state:'prepared'}}}},{messages:[]},{sessions:[{...fact,sourceRevision:'changed'}]},
  {job:{kind:'user',userInputs:[{inputId:'new'}]}},{outcome:{...f.outcome,failed:true}},{outcome:{...f.outcome,stopped:true}},{outcome:{...f.outcome,deliveryPending:true}}])assert.equal(reportedWaitFor({...f,...change}),null);
 assert.equal(reportedWaitCurrent(reportedWaitFor(f),[{...fact,status:'accepted'}]),false);
});
test('new decision is visible; repetition of the same decision waits without rewriting child status',()=>{
 const question={options:['continue','pause']};const prior={...message,question};
 const args={workspaceId:'w',message:{...message,question},reportedMessages:[prior]};
 assert.equal(prepareReplyReport(args).suppressed,true);
 assert.equal(prepareReplyReport({...args,message:{...message,question:{options:['another decision']}}}).suppressed,false);
 assert.equal(prepareReplyReport({...args,currentInputAnchors:['new-input']}).suppressed,false);
 const f=setup();f.messages=[prior];f.outcome.rounds[0].toolCalls[0].result.question=question;
 assert.equal(reportedWaitFor(f).waitingUser,true);
 delete f.outcome.rounds[0].toolCalls[0].result.question;
 assert.equal(reportedWaitFor(f).waitingUser,false,'an old question cannot manufacture a new human wait');
});

test('production reply composer supplies canonical suppression identity and preserves current-user answers',async()=>{
 const {createDesktopReplyComposer}=await import('./reply-composer-port.mjs');
 const composer=createDesktopReplyComposer({readDelivery:()=>({sessionIds:['s'],sessionStates:[fact],reportedMessages:[message]})});
 const input={text:'Current blocker',proactive:true,replyTo:[],sources:['s'],statusClaims:[{sessionId:'s',status:'waiting_agent'}]};
 const view={workspaceId:'w',turnId:'new-turn',messages:[message],currentInputAnchors:[]};
 const suppressed=composer.postReply(input,view);assert.equal(suppressed.suppressed,true);assert.deepEqual(suppressed.reportedReplyIds,['reply']);
 const f=setup();f.outcome.rounds[0].toolCalls[0].result=suppressed;assert.ok(reportedWaitFor(f));
 const user={id:'u',kind:'user_input',role:'user',content:'What happened?'};
 const answer=composer.postReply({...input,replyTo:['u']},{...view,messages:[message,user],currentInputAnchors:['u']});
 assert.equal(answer.suppressed,undefined);assert.deepEqual(answer.message.replyTo,['u']);
});
