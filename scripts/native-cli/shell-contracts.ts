// Development-only conformance reference; no JS runtime is used by peer-native.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {completionScript,runPeerCompletions} from '../../apps/tui/src/cli-completions.ts';
import {formatPeerHelp,parsePeerArgv} from '../../apps/tui/src/cli-argv.ts';
const scripts:Record<string,string>={};
for(const shell of ['bash','zsh','fish'] as const){
 const stdout:string[]=[];
 assert.equal(runPeerCompletions(shell,{stdout:line=>stdout.push(line)}),0);
 assert.equal(stdout.join('\n')+'\n',completionScript(shell));
 scripts[shell]=stdout.join('\n')+'\n';
}
const vectors=[['completions','bash'],['completions','zsh'],['completions','fish'],['completions'],['completions','powershell'],['completions','bash','extra'],['completions','--help'],['completions','bash','--help'],['completions','--version']];
const data={schemaVersion:1,scripts,help:formatPeerHelp('completions'),cases:vectors.map(argv=>({argv,expected:parsePeerArgv(argv)}))};
const file='packages/protocol/contracts/native-cli/shell-completions.json';
const output=JSON.stringify(data,null,2)+'\n';
if(process.argv.includes('--write'))writeFileSync(file,output);else assert.equal(readFileSync(file,'utf8'),output,'regenerate actual TS shell contracts');
console.log('3 actual TS completion scripts and 9 public parser cases match.');
