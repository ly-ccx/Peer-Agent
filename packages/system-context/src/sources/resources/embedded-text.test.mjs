import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { projectAgentRules, workSessionReadonly } from './embedded-text.mjs';

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8').trim();

test('嵌入的提示正文和 markdown 来源一致', () => {
  assert.equal(projectAgentRules, read('project-agent-rules.md'));
  assert.equal(workSessionReadonly, read('work-session-readonly.md'));
});

test('编译进 peer 的来源用模块带上正文，启动时不读 markdown', () => {
  const agent = readFileSync(new URL('../project-agent-source.mjs', import.meta.url), 'utf8');
  const origin = readFileSync(new URL('../work-session-origin-source.mjs', import.meta.url), 'utf8');
  assert.match(agent, /projectAgentRules/);
  assert.match(origin, /workSessionReadonly/);
  assert.doesNotMatch(agent, /readFileSync|readResource\(/);
  assert.doesNotMatch(origin, /readFileSync|readResource\(/);
});
