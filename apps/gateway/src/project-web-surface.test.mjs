import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {remoteWebResponse} from './web-surface.mjs';
import {projectScript} from './project-web-surface.mjs';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(handler) {
  const nodes = new Map(), calls = [], events = {};
  let sequence = 0;
  const document = { activeElement: null, addEventListener(name, callback) { events['document:' + name] = callback; } };
  function element(tag) {
    return { tag, hidden: false, disabled: false, value: '', textContent: '', children: [], listeners: {}, attrs: {}, dataset: {}, parent: null,
      scrollTop: 0, clientHeight: 100,
      get scrollHeight() { return this.children.length * 100; },
      get isConnected() { return this.root || Boolean(this.parent?.isConnected); },
      get onclick() { return this.listeners.click; }, set onclick(value) { this.listeners.click = value; },
      append(...rows) { for (const row of rows) { row.parent = this; this.children.push(row); } },
      replaceChildren(...rows) {
        if (this.contains(document.activeElement)) document.activeElement = null;
        for (const row of this.children) row.parent = null;
        this.children = []; this.append(...rows);
      },
      contains(value) { return Boolean(value && (value === this || this.children.some(child => child.contains(value)))); },
      querySelectorAll() { return this.children.flatMap(child => [...(child.dataset.navKey ? [child] : []), ...child.querySelectorAll()]); },
      getBoundingClientRect() { const top = this.parent ? this.parent.children.indexOf(this) * 100 - this.parent.scrollTop : 0; return { top, bottom: top + 100 }; },
      addEventListener(name, callback) { this.listeners[name] = callback; },
      setAttribute(name, value) { this.attrs[name] = value; },
      focus() { document.activeElement = this; },
      requestSubmit() { return this.listeners.submit({ preventDefault() {} }); },
      click() { return this.listeners.click?.(); },
    };
  }
  const byId = id => { if (!nodes.has(id)) { const el = element('div'); el.root = true; nodes.set(id, el); } return nodes.get(id); };
  Object.assign(document, { getElementById: byId, querySelector: () => byId('shell'), createElement: element, createElementNS: (_, tag) => element(tag) });
  const fetch = async (url, options) => { calls.push([url, options]); return handler(url, options); };
  runInNewContext(projectScript, { document, fetch, window: { addEventListener(name, callback) { events[name] = callback; } },
    crypto: { randomUUID: () => `input-${++sequence}` }, Date, Map, Set, Array, JSON, Error, encodeURIComponent });
  return { byId, calls, events, document, click: id => byId(id).listeners.click(), submit: () => byId('project-input').requestSubmit(), flush };
}
const response=(body,status=200)=>({ok:status===200,status,json:async()=>body});
const bots=[{workspaceId:'bot',deviceId:'device',name:'<script>evil</script>',canMessage:true,state:{running:1},avatar:{shape:'diamond',color:'#a884e5'}},
  {workspaceId:'other',deviceId:'device',name:'Other',canMessage:true,state:{}}];
const standard=(url)=>url==='/api/projects'?response({projects:bots,devices:[{deviceId:'device',name:'Computer',status:'online'}]})
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
  let sent=0;const f=fixture((url,options)=>url.endsWith('/input')?++sent===1?response({code:'OUTCOME_UNKNOWN'},504):response({requestId:JSON.parse(options.body).inputId,status:'ok',result:{status:'received'}}):standard(url));
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

test('remote composition cannot send and an unrelated receipt cannot clear the original input', async () => {
  const f = fixture(url => url.endsWith('/input') ? response({ requestId: 'other', status: 'ok', result: { status: 'received' } }) : standard(url));
  await flush(); f.byId('project-list').children[0].listeners.click(); await flush();
  const text = f.byId('project-text'); text.value = 'keep'; text.listeners.compositionstart();
  await f.submit(); assert.equal(f.calls.filter(([url]) => url.endsWith('/input')).length, 0);
  text.listeners.compositionend(); await f.submit();
  assert.equal(text.value, 'keep'); assert.equal(text.readOnly, true); assert.match(f.byId('input-status').textContent, /可能已送达/);
});
test('closing a task preview ignores its late response and returns focus to its opener', async () => {
  let finish;
  const f = fixture(url => url.includes('/sessions/') ? new Promise(resolve => { finish = resolve; }) : standard(url));
  await flush(); f.byId('project-list').children[0].listeners.click(); await flush();
  const opener = f.byId('project-messages').children[0].children.at(-1); opener.listeners.click();
  assert.equal(f.byId('project-task-detail').hidden, false);
  f.click('task-close'); finish(response({ result: { title: 'late', summary: 'private', status: 'completed' } })); await flush();
  assert.equal(f.byId('project-task-detail').hidden, true); assert.equal(f.byId('detail-summary').textContent, '');
  assert.equal(f.document.activeElement, opener);
});
test('refresh preserves message nodes, reading position and composer caret ownership', async () => {
  const f = fixture(standard); await flush(); f.byId('project-list').children[0].listeners.click(); await flush();
  const messages = f.byId('project-messages'), original = messages.children[0], text = f.byId('project-text');
  messages.scrollTop = 30; messages.listeners.wheel({}); text.value = 'draft'; text.listeners.input(); text.focus();
  f.click('chat-refresh'); await flush();
  assert.equal(messages.children[0], original); assert.equal(messages.scrollTop, 30);
  assert.equal(f.document.activeElement, text); assert.equal(text.value, 'draft');
});
test('page suspension preserves uncertain input and cannot let a late receipt clear it', async () => {
  let finish;
  const f = fixture(url => url.endsWith('/input') ? new Promise(resolve => { finish = resolve; }) : standard(url));
  await flush(); f.byId('project-list').children[0].listeners.click(); await flush();
  f.byId('project-text').value = 'pending'; const sending = f.submit(); await flush();
  f.events.pagehide(); finish(response({ requestId: 'input-1', status: 'ok', result: { status: 'received' } })); await sending;
  f.events.pageshow({ persisted: true }); await flush();
  assert.equal(f.byId('project-text').value, 'pending'); assert.equal(f.byId('project-send').textContent, '重试同一消息');
});
