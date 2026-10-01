import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectLifecycleEffects } from './project-lifecycle-effects.mjs';

for (const readable of [false, true]) {
  test(`verified familiarity memory requires readable Evidence (${readable})`, async () => {
    const writes = [];
    const settled = [];
    let profile = { familiarize: { sessionId: 's1', memoryRecorded: false } };
    const effects = createProjectLifecycleEffects({
      profileStore: { read: () => profile, save: value => { profile = value; } },
      lifecycle: { recordVerifiedFindings: (workspaceId, findings) => {
        writes.push({ workspaceId, findings });
        return { ok: true, items: [{ id: 'memory-1' }] };
      } },
      supervisor: {
        acceptance: () => ({ verdict: { outcome: 'passed', checks: [{ passed: true }],
          evidenceRefs: ['file-ref', 'wrapper-ref'] } }),
        get: () => ({ workspaceId: 'w1', status: 'accepted' }),
        settle: async id => { settled.push(id); },
      },
      conversationStore: { updateMessageById() {} },
      resolveConversationId: () => 'parent',
      resolveEvidence: ref => readable && ref === 'file-ref' ? 'observed project fact' : '',
    });
    await effects.onReplied('w1', { id: 'reply', content: 'Project finding', sources: ['s1'] });
    assert.deepEqual(settled, ['s1']);
    assert.equal(profile.familiarize.memoryRecorded, readable);
    assert.deepEqual(writes, readable ? [{ workspaceId: 'w1',
      findings: [{ text: 'Project finding', sourceRefs: ['file-ref'] }] }] : []);
  });
}
