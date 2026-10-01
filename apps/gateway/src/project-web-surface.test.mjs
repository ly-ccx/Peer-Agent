import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {remoteWebResponse} from './web-surface.mjs';
import {projectScript} from './project-web-surface.mjs';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(handler){const nodes=new Map(),calls=[];let sequence=0;
  const element=tag=>({tag,hidden:false,value:'',textContent:'',children:[],listeners:{},attrs:{},dataset:{},
    append(...rows){this.children.push(...rows);},prepend(...rows){this.children.unshift(...rows);},replaceChildren(...rows){this.children=rows;},
    addEventListener(name,callback){this.listeners[name]=callback;},setAttribute(name,value){this.attrs[name]=value;},focus(){this.focused=true;}});
  const byId=id=>{if(!nodes.has(id))nodes.set(id,element('div'));return nodes.get(id);};
  const document={getElementById:byId,querySelector:()=>byId('shell'),createElement:element,createElementNS:(_,tag)=>element(tag)};
  const fetch=async(url,options)=>{calls.push([url,options]);return handler(url,options);};
  runInNewContext(projectScript,{document,fetch,crypto:{randomUUID:()=>`input-${++sequence}`},Date,Map,Set,Array,JSON,Error,encodeURIComponent});
  return {byId,calls,click:id=>byId(id).listeners.click(),submit:()=>byId('project-input').listeners.submit({preventDefault(){}}),flush};
}
const response=(body,status=200)=>({ok:status===200,status,json:async()=>body});
const bots=[{workspaceId:'bot',deviceId:'device',name:'<script>evil</script>',canMessage:true,state:{running:1},avatar:{shape:'diamond',color:'#a884e5'}},
  {workspaceId:'other',deviceId:'device',name:'Other',canMessage:true,state:{}}];
const standard=(url)=>url==='/api/projects'?response({projects:bots,devices:[{name:'Computer',status:'online'}]})
  :url.includes('/conversation?')?response({result:{messages:[{id:'m',kind:'agent_reply',content:'hello',needsDesktopApproval:true,sourceSessionIds:['task']}],sessions:[],nextCursor:null,canMessage:true}})
  :response({});
test('project static shell uses same-origin assets, text content, SVG avatars and mobile layout',async()=>{
  for(const path of ['/bots','/assets/projects.js','/assets/projects.css']){const result=remoteWebResponse(path);assert.equal(result.status,200);assert.match(result.headers.get('content-security-policy'),/script-src 'self'/);}
  const css=await remoteWebResponse('/assets/projects.css').text();assert.match(css,/max-width:700px/);assert.match(css,/prefers-reduced-motion/);
  assert.doesNotMatch(projectScript,/innerHTML|localStorage|permission\.approve/);
  const f=fixture(standard);await flush();const row=f.byId('project-list').children[0];assert.equal(row.children[1].children[0].textContent,bots[0].name);
  assert.equal(row.children[0].tag,'svg');row.listeners.click();await flush();
  assert.equal(f.byId('project-messages').children[0].children[2].textContent,'需要在电脑上批准');
});
test('unknown input keeps the exact ID, body and target across retries and bot switches',async()=>{
  let sent=0;const f=fixture((url,options)=>url.endsWith('/input')?++sent===1?response({code:'OUTCOME_UNKNOWN'},504):response({result:{status:'received'}}):standard(url));
  await flush();f.byId('project-list').children[0].listeners.click();await flush();
  f.byId('project-text').value='same message';f.byId('project-text').listeners.input();await f.submit();
  assert.match(f.byId('input-status').textContent,/可能已送达/);assert.equal(f.byId('project-text').readOnly,true);
  f.byId('project-list').children[1].listeners.click();await flush();f.byId('project-list').children[0].listeners.click();await flush();
  assert.equal(f.byId('project-text').value,'same message');await f.submit();await flush();
  const requests=f.calls.filter(([url])=>url.endsWith('/input'));assert.equal(requests.length,2);assert.equal(requests[0][0],requests[1][0]);assert.equal(requests[0][1].body,requests[1][1].body);
  assert.deepEqual(JSON.parse(requests[0][1].body),{deviceId:'device',inputId:'input-1',text:'same message'});
  assert.equal(f.byId('project-text').value,'');
});
test('a permission refusal during retry preserves the original uncertain message',async()=>{
  const f=fixture((url)=>url.endsWith('/input')?response({code:'MESSAGE_DENIED'},403):standard(url));await flush();f.byId('project-list').children[0].listeners.click();await flush();
  f.byId('project-text').value='still same';await f.submit();assert.equal(f.byId('project-send').textContent,'重试同一消息');assert.equal(f.byId('project-text').readOnly,true);
});
test('logout suppresses late list and task replies and clears private body',async()=>{
  let complete;const f=fixture(url=>url==='/api/projects'?new Promise(resolve=>{complete=resolve;}):response({}));
  await f.click('project-logout');complete(response({projects:bots,devices:[]}));await flush();assert.equal(f.byId('project-list').children.length,0);assert.equal(f.byId('project-chat').hidden,true);
  const expired=fixture(url=>url==='/api/projects'?response({},401):standard(url));await flush();assert.equal(expired.byId('project-login').hidden,false);assert.equal(expired.byId('project-list').children.length,0);
});
test('typing while a conversation read is pending does not lose the draft',async()=>{
  let finish;const f=fixture(url=>url.includes('/conversation?')?new Promise(resolve=>{finish=resolve;}):standard(url));await flush();f.byId('project-list').children[0].listeners.click();
  f.byId('project-text').value='typed during read';f.byId('project-text').listeners.input();finish(response({result:{messages:[],sessions:[],nextCursor:null,canMessage:true}}));await flush();
  assert.equal(f.byId('project-text').value,'typed during read');
});
