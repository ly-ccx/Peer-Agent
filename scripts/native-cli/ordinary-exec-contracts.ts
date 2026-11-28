// Actual legacy CLI parsing/model/tool oracles; production is native Rust.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {parsePeerArgv} from '../../apps/tui/src/cli-argv.ts';
import {resolveExecCatalogEntry} from '../../apps/tui/src/cli-model-ref.ts';
import {resolveExecToolAllowlist} from '../../apps/tui/src/cli-tools.ts';
import {SHARED_LOCAL_TOOL_CONTRACT_LIST,LEGACY_LOCAL_CAPABILITY_ID_ALIASES,LEGACY_LOCAL_MODEL_TOOL_NAME_ALIASES} from '../../packages/runtime-core/src/local-tool-contracts.ts';
const argvCases=[[],['question'],['one','two'],['-'],['--','--help'],['--help'],['--access','ask','question'],['--access=session','q'],['--access=full','q'],['--access','restricted','q'],['--output-format=json','q'],['--output-format','yaml','q'],['--provider','channel','--model','channel::model/id','q'],['--effort=off','q'],['--mode=plan','q'],['--mode=bad','q'],['--fast','q'],['--fast=true','q'],['--workspace','/repo','q'],['--max-turns','1','q'],['--max-turns','1e3','q'],['--max-turns','1.0','q'],['--max-turns','0x10','q'],['--max-turns','0','q'],['--max-turns','2.5','q'],['--max-turns','bad','q'],['--max-turns'],['--tools=file,bash','q'],['--tools',',,','q'],['--unknown','q'],['--provider=','q'],['--provider','--model','q']].map(args=>({args,expected:parsePeerArgv(['exec',...args])}));
const tokens=['file','bash',...SHARED_LOCAL_TOOL_CONTRACT_LIST.flatMap(c=>[c.capabilityId,c.toolName]),...Object.keys(LEGACY_LOCAL_CAPABILITY_ID_ALIASES),...Object.keys(LEGACY_LOCAL_MODEL_TOOL_NAME_ALIASES)];
const toolAliases=Object.fromEntries(tokens.map(token=>{const r=resolveExecToolAllowlist([token]);assert(r.ok);return[token,r.capabilityIds];}));
const catalog=[{providerId:'a',modelId:'model/id',entryId:'entry-a',available:true},{providerId:'b',modelId:'model/id',entryId:'entry-b',available:true},{providerId:'c',modelId:'unique',entryId:'entry-c',available:true}];
const modelCases=[{model:'model/id'},{provider:'a',model:'model/id'},{model:'a::model/id'},{provider:'entry-a',model:'model/id'},{provider:'b',model:'a::model/id'},{model:'unique'},{provider:'missing'},{provider:'a'},{model:'missing'},{model:'::model/id'},{model:'a::'}].map(ref=>({catalog,ref,expected:resolveExecCatalogEntry(catalog,ref)}));
const outputs=[['ordinary-exec.json',{version:1,argvCases,toolAliases,modelCases}],['ordinary-exec-tools.json',{version:1,toolAliases}]] as const;
for(const [name,data] of outputs){const file=new URL(`../../packages/protocol/contracts/native-cli/${name}`,import.meta.url);if(process.argv.includes('--write'))writeFileSync(file,JSON.stringify(data,null,2)+'\n');else assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),JSON.parse(JSON.stringify(data)));}
console.log(`${argvCases.length} actual exec argument vectors, ${tokens.length} tool alias observations and ${modelCases.length} model resolutions match.`);
