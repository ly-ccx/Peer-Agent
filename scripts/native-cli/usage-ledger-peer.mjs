// A real second Node Store process; synthetic inputs arrive over stdin only.
import { createConversationStore } from '../../packages/conversation-store/src/index.mjs';
import path from 'node:path';
let body=''; for await (const chunk of process.stdin) body+=chunk;
const v=JSON.parse(body);
try { console.log(JSON.stringify({ok:true,value:createConversationStore({storeDir:path.join(v.root,'conversations')}).recordRuntimeTurnUsage(v.id,v.input)})); }
catch(e){ console.log(JSON.stringify({ok:false,code:e.code})); }
