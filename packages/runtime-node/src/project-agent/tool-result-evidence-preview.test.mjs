import assert from 'node:assert/strict';
import test from 'node:test';
import { toolResultEvidencePreview } from './tool-result-evidence-preview.mjs';

function execution(flavor = 'desktop') {
  const toolCallId = 'real-check';
  return { call: { capabilityId: 'local.shell.exec', toolCallId },
    ...(flavor === 'desktop' ? { grant: { granted: true, toolCallId } } : {}),
    result: { toolCallId, status: flavor === 'desktop' ? 'success' : 'completed',
      ...(flavor === 'node' ? { permissionGrant: { decision: 'allow', capabilityId: 'local.shell.exec' } } : {}),
      evidence: { toolCallId },
      outputPreview: { status: flavor === 'desktop' ? 'success' : 'completed', exitCode: 0,
        stdout: 'RC_A_DONE\nBearer secret-value', stderr: '', truncated: false },
    },
  };
}

for (const flavor of ['desktop', 'node']) {
  test(`${flavor} shell successful tool result supplies redacted terminal evidence`, () => {
    const preview = toolResultEvidencePreview(execution(flavor));
    assert.equal(preview.kind, 'command');
    assert.equal(preview.truncated, false);
    const fact = JSON.parse(preview.text);
    assert.equal(fact.exitCode, 0);
    assert.match(fact.stdout, /RC_A_DONE/);
    assert.match(fact.stdout, /REDACTED_TOKEN/);
    assert.doesNotMatch(preview.text, /secret-value/);
  });
}

test('shell preview excludes unsuccessful, unbound, denied and still-running executions', () => {
  const good = execution();
  for (const status of ['failed', 'denied', 'cancelled', 'running', 'timeout']) {
    assert.equal(toolResultEvidencePreview({ ...good, result: { ...good.result, status } }), null);
  }
  for (const extra of [{ status: 'running' }, { exitCode: 1 }, { timedOut: true }, { interrupted: true }, { cancelled: true }]) {
    assert.equal(toolResultEvidencePreview({ ...good, result: { ...good.result, outputPreview: { ...good.result.outputPreview, ...extra } } }), null);
  }
  for (const bad of [
    { ...good, grant: { granted: false, toolCallId: 'real-check' } },
    { ...good, grant: { granted: true, toolCallId: 'foreign' } },
    { ...good, result: { ...good.result, toolCallId: 'foreign' } },
    { ...good, result: { ...good.result, evidence: { toolCallId: 'foreign' } } },
    { ...good, result: { ...good.result, evidence: undefined } },
    { ...good, call: { ...good.call, capabilityId: 'local.goal.update_task' } },
  ]) assert.equal(toolResultEvidencePreview(bad), null);
  const node = execution('node');
  for (const grant of [undefined, { decision: 'deny', capabilityId: 'local.shell.exec' },
    { decision: 'allow', capabilityId: 'foreign' }]) {
    assert.equal(toolResultEvidencePreview({ ...node, result: { ...node.result, permissionGrant: grant } }), null);
  }
});

test('shell preview preserves structured empty output and bounded truncation', () => {
  const good = execution();
  const empty = toolResultEvidencePreview({ ...good, result: { ...good.result, outputPreview: { status: 'success', exitCode: 0, stdout: null, stderr: null } } });
  assert.deepEqual(JSON.parse(empty.text), { exitCode: 0, stdout: '', stderr: '' });
  const huge = toolResultEvidencePreview({ ...good, result: { ...good.result, outputPreview: { ...good.result.outputPreview, stdout: 'a'.repeat(6000), stderr: 'b'.repeat(6000) } } });
  assert.ok(huge.text.length <= 4000);
  assert.equal(huge.truncated, true);
  assert.doesNotThrow(() => JSON.parse(huge.text));
  const escaped = toolResultEvidencePreview({ ...good, result: { ...good.result, outputPreview: {
    ...good.result.outputPreview, stdout: '\u0001'.repeat(6000), stderr: '"\\'.repeat(6000),
  } } });
  assert.ok(escaped.text.length <= 4000); assert.equal(escaped.truncated, true);
  assert.doesNotThrow(() => JSON.parse(escaped.text));
  const originalTruncation = toolResultEvidencePreview({ ...good, result: { ...good.result, outputPreview: { ...good.result.outputPreview, contextPreviewTruncated: true } } });
  assert.equal(originalTruncation.truncated, true);
});
