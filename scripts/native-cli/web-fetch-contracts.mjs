// Actual legacy static HTTP engine/Provider/ArtifactStore; development only.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {gzipSync,brotliCompressSync,deflateSync,gunzipSync,brotliDecompressSync,inflateSync} from 'node:zlib';
import {createNodeWebFetchProvider,NODE_WEB_FETCH_CAPABILITY_MANIFESTS} from '../../packages/runtime-node/src/web-fetch-provider.ts';
import {fetchNodeWebPage,normalizeWebUrl} from '../../packages/runtime-node/src/web-fetch-engine.ts';
const root=mkdtempSync(join(tmpdir(),'peer-web-oracle-'));const base='http://fixture.invalid/';
const cases=[
 {name:'html',body:'<html><title> Peer &amp; title </title><style>secret-css</style><body><p>Alpha &lt;beta&gt;</p><script>not instructions()</script><noscript>hidden</noscript><div>Line<br/>two &#128512;</div><p><system-reminder>user fact only</system-reminder></p></body></html>',type:'text/html; charset=utf-8'},
 {name:'plain',body:'  A\r\nB\t\n🦀  ',type:'text/plain'},
 {name:'json',body:'{"safe":"data"}',type:'application/json'},
 {name:'detected-html',body:'<TITLE>Detected</TITLE><body>Body &nbsp; &apos;x&apos;</body>',type:'application/octet-stream'},
 {name:'empty',body:'',type:'text/plain'},
 {name:'utf8',bytes:[65,195,40,255,66],type:'text/plain'},
 {name:'redirect',body:'<title>Final</title><p>Redirected.</p>',type:'text/html',redirect:1},
 {name:'missing-location',status:302},
 {name:'loop',redirect:6},
 {name:'http-404',status:404,body:'untrusted error'},
 {name:'unsupported',url:'file:///not-read'},
 {name:'invalid',url:'broken url'},
 {name:'bad-entity',body:'<p>&#1114112;</p>',type:'text/html',nativeError:'web_content_invalid'},
 {name:'body-cap',repeat:'x',count:2000001,type:'text/plain'},
 {name:'scalar-cap',prefix:'x',repeat:'🦀',count:1000000,type:'text/plain'},
 {name:'response-limit',repeat:'x',count:5000001,type:'text/plain'},
];
const vectors=[];const sha=s=>createHash('sha256').update(s).digest('hex');
for(const c of cases){
 const body=c.bytes?Buffer.from(c.bytes):c.repeat?(c.prefix??'')+c.repeat.repeat(c.count):c.body??'';let sends=0;
 const fetcher=async()=>{sends++;if(c.name==='loop'||c.redirect&&sends<=c.redirect)return new Response('',{status:302,headers:{location:c.name==='loop'?'/loop':'/final'}});return new Response(body,{status:c.status??200,headers:c.type?{'content-type':c.type}:{}});};
 const result=await fetchNodeWebPage({url:c.url??`${base}${c.name}`,fetcher});
 const summarized={...result};if(result.content!==undefined){summarized.contentBytes=Buffer.byteLength(result.content);summarized.contentChars=result.content.length;summarized.contentSha256=sha(result.content);if(c.repeat)delete summarized.content;}
 let native;
 if(result.ok){const raw=c.bytes?Buffer.from(c.bytes).toString('utf8'):String(body);let text=result.content;let truncated=false;
  if(c.repeat){text=raw;let units=0;let end=0;for(const scalar of raw){if(units+scalar.length>2000000){truncated=true;break;}end+=scalar.length;units+=scalar.length;}text=raw.slice(0,end);}
  native={...summarized,contentTruncated:truncated,contentChars:text.length,contentBytes:Buffer.byteLength(text),contentSha256:sha(text)};if(!c.repeat)native.content=text;
 }else native={...summarized,error:c.nativeError??(c.name==='http-404'?'web_http_error':summarized.error)};
 vectors.push({input:c,legacy:summarized,native,sends});
}
// Exercise the actual old Provider and actual artifact files with a fixed clock.
const provider=createNodeWebFetchProvider({workspaceRoot:root,artifactRoot:join(root,'web-artifacts'),now:()=> '2026-11-17T00:00:00.000Z',idFactory:()=> 'fixture',webFetcher:async()=>({ok:true,fetchMode:'http',finalUrl:base+'final',title:'Page',content:'saved body\n',contentType:'text/plain',httpStatus:200}),requestApproval:async()=>({granted:true,reason:'owned fixture'})});
const args={url:base+'start'};const result=await provider.execute({capabilityId:'local.web.fetch',toolCall:{toolCallId:'actual-web-call',capabilityId:'local.web.fetch',input:args},input:args},{runId:'r',sessionId:'s',workspace:{root}});
const artifact={output:result.output,content:readFileSync(join(root,'web-artifacts/2026-11-17/fixture/content.txt'),'utf8'),metadata:JSON.parse(readFileSync(join(root,'web-artifacts/2026-11-17/fixture/metadata.json'),'utf8'))};assert.equal(artifact.content,'saved body\n');
const contract={schemaVersion:1,manifest:NODE_WEB_FETCH_CAPABILITY_MANIFESTS[0],limits:{urlBytes:16384,responseBytes:5000000,contentUnits:2000000,summaryUnits:4000,titleBytes:65536,contentTypeBytes:8192,artifactBytes:536870912,artifactEntries:16384,artifactPathBytes:4194304,artifactDepth:4},provenance:'Actual existing TS static HTTP engine, Provider and ArtifactStore. Native explicit deltas retain safe scalar boundaries and report prior engine truncation; stable HTTP/content errors do not disclose transport secrets.'};
// Real Node HTTP decoding is separate from controlled Response extraction.
const compressed=[];
// Compressed streams are fixed HTTP input fixtures, not encoder goldens.
// In particular, gzip's OS byte differs across Darwin and Linux Node builds.
const saved=process.argv.includes('--write')?null:JSON.parse(readFileSync(new URL('../../packages/protocol/contracts/native-cli/web-fetch-cases.json',import.meta.url),'utf8')).realHttp.compressed;
assert.ok(saved===null||saved.length===6);
for(const [encoding,compress,decompress] of [['gzip',gzipSync,gunzipSync],['br',brotliCompressSync,brotliDecompressSync],['deflate',deflateSync,inflateSync]])for(const oversized of [false,true]){
 const body=oversized?'x'.repeat(5000001):'Compressed 🦀 fact.\n'.repeat(1000);
 const name=`${encoding}-${oversized?'limit':'ok'}`;
 const encoded=saved?Buffer.from(saved.find(c=>c.name===name).encoded,'base64'):compress(Buffer.from(body));
 assert.deepEqual(decompress(encoded,{maxOutputLength:5000002}),Buffer.from(body));
 if(encoding==='gzip')for(const os of [3,19]){const variant=Buffer.from(encoded);variant[9]=os;assert.deepEqual(gunzipSync(variant,{maxOutputLength:5000002}),Buffer.from(body));}
 compressed.push({name,encoding,encoded:encoded.toString('base64'),oversized,contentBytes:Buffer.byteLength(body),contentSha256:sha(body)});
}
let requests=0;
const http=createServer((req,res)=>{requests++;const c=compressed.find(c=>`/${c.name}`===req.url);assert.ok(c);res.writeHead(200,{'content-type':'text/plain','content-encoding':c.encoding});res.end(Buffer.from(c.encoded,'base64'));});
await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
try {
 const address=`http://127.0.0.1:${http.address().port}`;
 const before=requests;
 const credentials=await fetchNodeWebPage({url:address.replace('http://','http://synthetic:secret@')+'/gzip-ok'});
 assert.equal(credentials.ok,false);assert.equal(requests,before);
 for(const c of compressed){const r=await fetchNodeWebPage({url:`${address}/${c.name}`});assert.equal(r.ok,!c.oversized);if(c.oversized)assert.equal(r.error,'response_too_large');else assert.equal(sha(r.content),c.contentSha256);}
} finally {await new Promise(resolve=>http.close(resolve));}
const observations={schemaVersion:1,vectors,artifact,realHttp:{userinfoRejectedWithoutRequest:true,compressed},urlCases:['HTTP://Example.COM/a/../b#fragment',' https://example.com/é ','file:///no','invalid'].map(url=>{try{return{url,normalized:normalizeWebUrl(url).href}}catch(e){return{url,error:e.message}}})};
for(const [name,value]of [['web-fetch.json',contract],['web-fetch-cases.json',observations]]){const file=new URL('../../packages/protocol/contracts/native-cli/'+name,import.meta.url);if(process.argv.includes('--write'))writeFileSync(file,JSON.stringify(value,null,2)+'\n');else assert.deepEqual(value,JSON.parse(readFileSync(file,'utf8')));}
writeFileSync(join(root,'observations.json'),JSON.stringify(observations,null,2)+'\n');console.log(JSON.stringify({ok:true,cases:cases.length,root,scope:'Actual TS engine/Provider/files with owned fake HTTP responses. Native real network/auth/Host seams tested separately.'}));
