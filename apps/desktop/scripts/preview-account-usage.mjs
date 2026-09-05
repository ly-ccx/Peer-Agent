// Local-only visual harness: bundles the production component, never loads credentials.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
const require = createRequire(new URL('../package.json', import.meta.url));
const { build } = createRequire(require.resolve('vite'))('esbuild');
const root = fileURLToPath(new URL('../renderer/src/', import.meta.url));
const result = await build({ stdin: { contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {AccountUsageDetails} from './app/components/AccountUsageDetails';
const params=new URLSearchParams(location.search);
document.documentElement.dataset.theme=params.get('theme')||'dark';
const quota={success:true,partial:true,fetchedAt:'2026-09-05T09:14:12Z',windows:[{id:'five',label:'5 小时',usedPercent:0},{id:'week',label:'每周',usedPercent:95},{id:'month',label:'每月',usedPercent:70}].map(w=>({...w,scope:'subscription',source:'api_key',resetsAt:'2026-09-07T01:00:00Z'})),unavailable:[{dimension:'balance',reason:'Zen 按量余额需要独立 OpenCode 网页会话',requiredAuth:'web_session'},{dimension:'spend',reason:'Go 订阅接口不提供现金消费'}],localUsage:{source:'local',scope:'local_only',requests:1374,inputTokens:28134424,outputTokens:901014,cacheReadTokens:106494383,cacheWriteTokens:8333753,estimatedCostUsd:24.208992943999995,from:'2026-08-07T11:29:58Z',to:'2026-09-05T12:05:22Z',note:'仅统计通过 Peer Agent 发出的用量（最多最近 5000 条全渠道记录），不代表完整历史或厂商账户总账；可能包含换账号前的记录。费用为本地估算。'}};
function App(){const [loading,setLoading]=React.useState(['loading','initial-loading'].includes(params.get('state')));const state=params.get('state');const data=['empty','initial-loading'].includes(state)?undefined:state==='balance'?{...quota,balances:[{currency:'CNY',total:'124.123456',paid:'100',granted:'24.123456',source:'api_key',scope:'account'}]}:state==='failed'?{...quota,success:false,status:'fetch_failed'}:state==='stale'?{...quota,stale:true}:quota;return <main style={{width:params.get('width')==='narrow'?'340px':'920px',maxWidth:'100%',margin:'32px auto'}}><h2>受控预览 · OpenCode Go</h2><p>测试数据 · 不访问厂商账户</p><div className="llm-provider-group"><div className="llm-group-header"><AccountUsageDetails quota={data} loading={loading} zh onRefresh={()=>{setLoading(true);setTimeout(()=>setLoading(false),params.get('slow')==='1'?10000:800)}}/></div></div></main>};
createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, outdir: 'preview', jsx: 'automatic', platform: 'browser' });
const js = result.outputFiles.find(f=>f.path.endsWith('.js')).text;
const css = result.outputFiles.find(f=>f.path.endsWith('.css'))?.text ?? '';
const tokens = readFileSync(new URL('../renderer/src/styles/tokens.css', import.meta.url),'utf8');
const settings = readFileSync(new URL('../renderer/src/styles/llm-settings.css', import.meta.url),'utf8');
const server=createServer((req,res)=>{res.setHeader('Cache-Control','no-store');if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(js);return;}res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${tokens}\n${settings}\n${css}\nbody{margin:0;padding:16px;font-family:system-ui;background:var(--chrome-canvas);color:var(--graphite-base)}*{box-sizing:border-box}h2{font-size:16px}main>p{font-size:12px;color:var(--graphite-soft)}</style><div id="root"></div><script src="/bundle.js"></script></html>`);});
server.listen(5198,'127.0.0.1',()=>console.log('Account usage preview: http://127.0.0.1:5198 (theme=light|dark, width=narrow, state=empty|balance|loading|initial-loading|failed|stale, slow=1 for a 10s refresh)'));
