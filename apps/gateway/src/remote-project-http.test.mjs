import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createAccountHttp} from './account-http.mjs';
function fixture(){let signedIn=true;const calls=[];
  const router={submit:async request=>{calls.push(request);return {requestId:request.requestId??'read',status:'ok',result:request.operation==='project.list'?{projects:[{workspaceId:'bot',name:'Bot'}]}:{status:'received'}};}};
  const account=createAccountHttp({origin:'https://peer.example',login:{},sessions:{authenticate:token=>signedIn&&token==='session'?{ownerId:'owner'}:null},devices:{listDevices:()=>[{deviceId:'device',name:'Computer',revoked:false}]}});
  const send=(path,{method='GET',body,origin='https://peer.example',type='application/json',cookie=true}={})=>account(new Request('https://peer.example'+path,{method,headers:{origin,'content-type':type,...(cookie?{cookie:'__Host-peer_session=session'}:{})},...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})}),{deviceProjects:router});
  return {send,calls,router,logout:()=>{signedIn=false;}};
}
test('four HTTP operations derive owner and exact request fields from authenticated state',async()=>{
  const f=fixture();assert.equal((await f.send('/api/projects')).status,200);
  assert.equal((await f.send('/api/projects/bot/conversation?deviceId=device&before=cursor')).status,200);
  assert.equal((await f.send('/api/projects/bot/sessions/task?deviceId=device')).status,200);
  assert.equal((await f.send('/api/projects/bot/input',{method:'POST',body:{deviceId:'device',inputId:'stable',text:'hello'}})).status,200);
  assert.deepEqual(f.calls,[{ownerId:'owner',deviceId:'device',operation:'project.list'},
    {ownerId:'owner',deviceId:'device',operation:'project.conversation.read',workspaceId:'bot',limit:50,before:'cursor'},
    {ownerId:'owner',deviceId:'device',operation:'project.session.read',workspaceId:'bot',sessionId:'task'},
    {ownerId:'owner',deviceId:'device',operation:'project.input.submit',workspaceId:'bot',requestId:'stable',text:'hello'}]);
});
test('authentication and origin are checked before routing; paths and server errors are not returned',async()=>{
  const f=fixture();assert.equal((await f.send('/api/projects',{cookie:false})).status,401);
  assert.equal((await f.send('/api/projects/bot/input',{method:'POST',body:{},origin:'https://evil.example'})).status,403);
  assert.equal(f.calls.length,0);
  f.router.submit=async()=>{throw Error('/private/credentials/api-key');};
  const reply=await f.send('/api/projects/bot/conversation?deviceId=device');assert.equal(reply.status,400);assert.equal((await reply.text()).includes('/private'),false);
});
test('known offline and sent-but-unanswered errors remain distinct',async()=>{
  for(const [code,status]of [['DEVICE_OFFLINE',409],['OUTCOME_UNKNOWN',504],['MESSAGE_DENIED',403],['REQUEST_CONFLICT',409]]){
    const f=fixture();f.router.submit=async()=>{throw Error(code);};const response=await f.send('/api/projects/bot/input',{method:'POST',body:{deviceId:'device',inputId:'stable',text:'hello'}});
    assert.equal(response.status,status);assert.equal((await response.json()).code,code);
  }
});
test('session revoked while awaiting a device answer withholds the private result',async()=>{
  const f=fixture();let resolve;f.router.submit=()=>new Promise(done=>{resolve=done;});
  const reading=f.send('/api/projects/bot/conversation?deviceId=device');f.logout();resolve({status:'ok',result:{messages:[{content:'private'}]}});
  const result=await reading;assert.equal(result.status,401);assert.equal((await result.text()).includes('private'),false);
});
