import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProjectInstructionsPromptSource} from '../../packages/system-context/src/sources/project-instructions-source.mjs';
import {createPromptSourceRegistry} from '../../packages/system-context/src/prompt-source-registry.mjs';
import {assembleSystemContext} from '../../packages/system-context/src/prompt-assembler.mjs';
const cases=[];
for(const files of [ {}, {'AGENTS.md':'  中文🙂 guidance\n'}, {'CLAUDE.md':'only this file'},
 {'AGENTS.md':'First guidance','CLAUDE.md':'More guidance'}, {'AGENTS.md':'\uFEFF \n'},
 {'AGENTS.md':'a'.repeat(23999)+'🙂tail'}, {'AGENTS.md':' \n'+'a'.repeat(24001)+' end'},
]) {
 const root=mkdtempSync(join(tmpdir(),'peer-native-instruction-reference-'));
 try {
  for(const [file,content]of Object.entries(files))writeFileSync(join(root,file),content);
  const expected=assembleSystemContext({workspacePath:root,mode:'goal'},{registry:createPromptSourceRegistry({sources:[createProjectInstructionsPromptSource()]})});
  expected.snapshot.createdAt='2026-11-15T00:00:00.000Z';
  cases.push({files,expected:JSON.parse(JSON.stringify(expected).replaceAll(root,'/synthetic/workspace'))});
 } finally {rmSync(root,{recursive:true,force:true});}
}
const result={version:1,cases};const file=new URL('../../packages/protocol/contracts/native-cli/project-instructions.json',import.meta.url);
if(process.argv.includes('--update'))writeFileSync(file,JSON.stringify(result,null,2)+'\n');else assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),result);
console.log(`${cases.length} actual project.instructions Source observations and hashes match.`);
