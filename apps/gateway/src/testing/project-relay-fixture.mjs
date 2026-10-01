import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {request as httpRequest} from 'node:http';
import {WebSocket} from 'ws';
import {createConversationStore} from '../../../../packages/conversation-store/dist/index.mjs';
import {createBotDirectory,createBotLifecycle,createInputQueue,createProjectRegistry} from '../../../../packages/runtime-node/dist/index.js';
import {startRemoteDeviceConnector} from '../../../../packages/runtime-node/src/remote-device-connector.mjs';
import {setupRemoteAccess} from '../../../desktop/electron/main/runtime-gateway/setup-remote-access.mjs';
import {createAccountSessions} from '../account-sessions.mjs';
import {createDeviceStore} from '../device-store.mjs';
import {createAccountHttp} from '../account-http.mjs';
import {createGatewayHttpServer} from '../http-server.mjs';

/** Test-only loopback transport seam. Real identity proof, HTTP, stores and queue. */
export async function createProjectRelayFixture({scriptedReply=false}={}) {
  const root=mkdtempSync(path.join(os.tmpdir(),'peer-project-relay-')),folder=path.join(root,'project');mkdirSync(folder);
  const origin='https://peer.example',ownerId='a'.repeat(64),sessions=createAccountSessions(':memory:'),devices=createDeviceStore(':memory:');
  const token=sessions.issue({ownerId}).token,registry=createProjectRegistry({filePath:path.join(root,'projects','registry.json')});
  const conversations=createConversationStore({storeDir:path.join(root,'conversations')}),lifecycle=createBotLifecycle({rootDir:root,registry,conversationStore:conversations});
  const workspaceId=registry.ensureForPath(folder).workspaceId,profile=lifecycle.ensureBot(workspaceId,{displayName:'项目伙伴'}).profile;
  const task={sessionId:'task-1',workspaceId,title:'核对项目文件',status:'running',updatedAt:new Date().toISOString(),report:{summary:'已读取项目说明，正在核对测试结果。',evidenceRefs:['private-evidence']}};
  const directory=createBotDirectory({rootDir:root,registry,readMessages:id=>conversations.getPersistedConversationHistory(id)?.messages??[],listSessions:()=>[task],getSession:()=>task,
    listApprovals:()=>[{state:'open',summary:'写入项目文件',arguments:{apiKey:'do-not-export'}}]});
  const inputQueue=createInputQueue({rootDir:path.join(root,'project-runtime'),holdsLease:()=>true,resolveConversationId:()=>profile.agentConversationId,
    hasMessage:(id,messageId)=>conversations.getPersistedConversationHistory(id)?.messages.some(row=>row.id===messageId),appendMessage:(id,message)=>conversations.appendMessage(id,message),
    onCommitted:({inputs})=>{if(scriptedReply)for(const input of inputs)conversations.appendMessage(profile.agentConversationId,{id:'reply-'+input.inputId,role:'assistant',kind:'agent_reply',content:'已收到：'+input.text,replyTo:['input-'+input.inputId],sources:['task-1']});}});
  let policy={enabled:true,gatewayOrigin:origin,workspaceId,delegationVersion:1,projectGrants:[{workspaceId,allowProjectRead:true,allowProjectMessage:true}]};
  const handle=createAccountHttp({origin,login:{},sessions,devices}),server=createGatewayHttpServer({origin,handle,deviceStore:devices}),address=await server.listen();
  let secret=null;const sockets=[];
  const remote=setupRemoteAccess({userDataPath:root,gatewayOrigin:origin,deviceName:'验收电脑',workspaceId,projectGrants:policy.projectGrants,
    getRemoteSettings:()=>policy,getProjectAccess:()=>({directory,inputQueue,getSession:id=>id===task.sessionId?task:null,wake:id=>inputQueue.consume(id)}),
    goalPlanStore:{listPlans:()=>[]},sessionStore:{getSession:()=>({sessionId:'unused'})},buildProjection:()=>({capabilities:[]}),host:{execute(){throw Error('Not a project execution port');}},
    identityStore:{loadSecret:async()=>secret,saveSecret:async value=>{secret=value;},deleteSecret:async()=>{secret=null;}},registryFile:null,
    connectorFactory(options){return startRemoteDeviceConnector({...options,socketFactory:()=>{const socket=new WebSocket('ws://127.0.0.1:'+address.port+'/api/device/ws',{headers:{host:'peer.example'}});sockets.push(socket);return socket;},
      onState(event){if(event.status==='pairing')devices.claimPairing(ownerId,event.pairing.challengeId,event.pairing.pairingKey);options.onState(event);}});},
  });
  async function until(check){const deadline=Date.now()+8000;while(Date.now()<deadline){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Fixture pairing timeout');}
  async function close(){remote.stop();for(const socket of sockets)socket.terminate();await server.close();remote.bindingStore.close();sessions.close();devices.close();rmSync(root,{recursive:true,force:true});}
  try{await remote.start();await until(()=>remote.status().online&&server.deviceTransport.connections.route(ownerId,remote.status().deviceId).delegation);}
  catch(error){await close();throw error;}
  const deviceId=remote.status().deviceId;
  const request=(pathname,{method='GET',body,cookie=token,originHeader=origin,headers={}}={})=>new Promise((resolve,reject)=>{
    const outgoing=httpRequest({host:'127.0.0.1',port:address.port,path:pathname,method,headers:{host:'peer.example',origin:originHeader,
      ...(cookie?{cookie:'__Host-peer_session='+cookie}:{}),...(body!==undefined?{'content-type':'application/json'}:{}),...headers}},incoming=>{
      const chunks=[];incoming.on('data',chunk=>chunks.push(chunk));incoming.on('error',reject);incoming.on('end',()=>{
        const resultHeaders=new Headers();for(const [name,value]of Object.entries(incoming.headers))for(const part of Array.isArray(value)?value:[value])if(part!==undefined)resultHeaders.append(name,part);
        resolve(new Response(incoming.statusCode===204?null:Buffer.concat(chunks),{status:incoming.statusCode,headers:resultHeaders}));
      });});
    outgoing.on('error',reject);outgoing.setTimeout(30_000,()=>outgoing.destroy(new Error('HTTP_TIMEOUT')));
    outgoing.end(body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body));
  });
  return {root,origin,ownerId,token,workspaceId,deviceId,profile,conversations,remote,server,request,close,
    history:()=>conversations.getPersistedConversationHistory(profile.agentConversationId)?.messages??[],
    changePolicy:patch=>{policy={...policy,...patch};},policy:()=>policy};
}
