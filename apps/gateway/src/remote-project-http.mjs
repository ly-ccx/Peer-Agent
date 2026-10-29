const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const STATUS={INVALID_REQUEST:400,PROTOCOL_UNSUPPORTED:400,INPUT_TOO_LONG:400,REQUEST_CONFLICT:409,RATE_LIMITED:429,
  DEVICE_OFFLINE:409,DEVICE_UNAVAILABLE:503,DELEGATION_UNAVAILABLE:503,DELEGATION_EXPIRED:403,PROJECT_DENIED:403,
  MESSAGE_DENIED:403,WORKSPACE_DENIED:403,TASK_DENIED:403,IDENTITY_UNBOUND:403,STALE_CONNECTION:409,
  REQUEST_EXPIRED:409,OUTCOME_UNKNOWN:504};

/** Authenticated HTTP projection. No state or input is retained by this adapter. */
export async function remoteProjectHttp(request,{principal,devices,router,reply,readJsonBody,isAuthenticated}) {
  const url=new URL(request.url),match=/^\/api\/projects(?:\/([^/]+)\/(conversation|input|sessions\/([^/]+)))?$/.exec(url.pathname);
  if(!match)return null;
  if(!principal)return reply(401,{error:'AUTH_REQUIRED'});
  if(!router)return reply(503,{error:'SERVICE_UNAVAILABLE'});
  try {
    const workspaceId=match[1]?decodeURIComponent(match[1]):null,sessionId=match[3]?decodeURIComponent(match[3]):null;
    const allowed=workspaceId&&match[2]==='conversation'?['deviceId','before']:workspaceId?['deviceId']:[];
    for(const key of url.searchParams.keys())if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1)throw new Error('INVALID_REQUEST');
    if(!workspaceId) {
      if(request.method!=='GET'||request.body)throw new Error('INVALID_REQUEST');
      const rows=devices.listDevices(principal.ownerId).filter(row=>!row.revoked).slice(0,200);
      const results=await Promise.all(rows.map(async device=>{
        try{const answer=await router.submit({ownerId:principal.ownerId,deviceId:device.deviceId,operation:'project.list'});
          return {deviceId:device.deviceId,name:device.name,status:'online',projects:(answer.result?.projects??[]).map(row=>({...row,deviceId:device.deviceId}))};
        }catch(error){return {deviceId:device.deviceId,name:device.name,status:/^[A-Z][A-Z_]{0,63}$/.test(error.message)?error.message:'DEVICE_UNAVAILABLE',projects:[]};}
      }));
      if(!isAuthenticated())return reply(401,{error:'AUTH_REQUIRED'});
      return reply(200,{projects:results.flatMap(row=>row.projects).slice(0,200),devices:results.map(({projects,...row})=>row)});
    }
    if(!identifier(workspaceId)||sessionId&&!identifier(sessionId))throw new Error('INVALID_REQUEST');
    let operation,fields,deviceId;
    if(match[2]==='input') {
      if(request.method!=='POST'||url.search)throw new Error('INVALID_REQUEST');
      if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return reply(415,{error:'JSON_REQUIRED'});
      const body=await readJsonBody(request,32*1024);
      if(body?.tooLarge)return reply(413,{error:'BODY_TOO_LARGE'});
      if(!body||Array.isArray(body)||Object.keys(body).sort().join(',')!=='deviceId,inputId,text'
          ||!identifier(body.deviceId)||!identifier(body.inputId)||typeof body.text!=='string')throw new Error('INVALID_REQUEST');
      deviceId=body.deviceId;operation='project.input.submit';fields={workspaceId,requestId:body.inputId,text:body.text};
    }else{
      if(request.method!=='GET'||request.body)throw new Error('INVALID_REQUEST');
      deviceId=url.searchParams.get('deviceId');if(!identifier(deviceId))throw new Error('INVALID_REQUEST');
      operation=sessionId?'project.session.read':'project.conversation.read';
      fields=sessionId?{workspaceId,sessionId}:{workspaceId,limit:50,before:url.searchParams.get('before')};
    }
    const answer=await router.submit({ownerId:principal.ownerId,deviceId,operation,...fields});
    if(!isAuthenticated())return reply(401,{error:'AUTH_REQUIRED'});
    return reply(200,answer);
  }catch(error){const code=/^[A-Z][A-Z_]{0,63}$/.test(error?.message)?error.message:'INVALID_REQUEST';
    return reply(STATUS[code]??502,{error:'PROJECT_UNAVAILABLE',code});}
}
