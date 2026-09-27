import assert from 'node:assert/strict';
import test from 'node:test';

import { evidenceBodyFromRecord, evidenceRefAllowed } from './evidence-presenter.mjs';

test('证据引用接受已登记的 URI，拒绝路径穿越', () => {
  assert.equal(evidenceRefAllowed('ev-1'), true);
  assert.equal(evidenceRefAllowed('tool-result://host-verifier'), true);
  assert.equal(evidenceRefAllowed('local-shell-artifact://task/stdout'), true);
  assert.equal(evidenceRefAllowed('artifact://shot'), true);
  assert.equal(evidenceRefAllowed('../secret'), false);
  assert.equal(evidenceRefAllowed('file:///etc/passwd'), false);
  assert.equal(evidenceRefAllowed('local-shell-artifact://../stdout'), false);
});

test('证据正文来自索引里的预览和工件，不读不存在的 output 字段', () => {
  const record = {
    evidenceRef: 'tool-result://call-1',
    toolName: 'bash',
    output: 'should not be read',
    summary: 'should not be read',
    userArtifacts: [{
      kind: 'code-change',
      ref: 'diff://login',
      label: '登录',
      preview: { kind: 'code', additions: 1, deletions: 0, diffLines: ['+ok'] },
    }],
    artifactRefs: ['local-shell-artifact://task/stdout'],
  };
  const seen = [];
  const body = evidenceBodyFromRecord(record, (ref) => {
    seen.push(ref);
    return 'npm test';
  });
  assert.deepEqual(seen, ['local-shell-artifact://task/stdout']);
  assert.equal(body.kind, 'diff');
  assert.equal(body.text.includes('+ok'), true);
  assert.equal(body.text.includes('npm test'), true);
  assert.equal(body.text.includes('should not be read'), false);
  assert.equal(evidenceBodyFromRecord({ evidenceRef: 'ev-empty', toolName: 'bash' }), null);
});
