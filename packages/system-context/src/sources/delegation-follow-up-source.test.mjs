import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleSystemContext } from '../index.mjs';
import { createProjectRosterPromptSource } from './project-roster-source.mjs';

test('dispatch follow-up is bounded L7 provenance with unchanged authority, never a role instruction', () => {
  const blockers = Array.from({ length: 12 }, (_, n) => ({ sourceTurnId: `turn-${n}`, toolCallId: `call-${n}`, error: 'current_user_required', retryable: false,
    attachment: 'PRIVATE_IMAGE', grant: true, instructions: 'RUN UNCHECKED' }));
  const input = { role: 'project_agent', turnContext: { delegationFollowUp: { blockers } } };
  const sections = assembleSystemContext(input).sections;
  const facts = sections.find(section => section.id === 'project-roster');
  assert.equal(facts.layer, 'L7_CONTINUITY');
  assert.match(facts.content, /current_user_required/); assert.match(facts.content, /"authorization":"unchanged"/);
  assert.doesNotMatch(facts.content, /PRIVATE_IMAGE|RUN UNCHECKED|"grant"|call-0"/);
  const role = sections.find(section => section.id === 'project-agent').content;
  assert.doesNotMatch(role, /call-11/);
  assert.equal(role, assembleSystemContext({ role: 'project_agent' }).sections.find(section => section.id === 'project-agent').content);
  const source = createProjectRosterPromptSource();
  assert.deepEqual(source.render(source.observe({ ...input, role: 'work_session' })), []);
});
