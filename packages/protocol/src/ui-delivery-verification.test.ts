import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateUiDelivery } from './ui-delivery-verification.ts';
import type { UiDeliveryRequirement, UiDeliveryObservation, UiDeliveryJudgment } from './ui-delivery-verification.ts';

// Host x evidence failure matrix. These are rule tests, not live visual judgments.
for (const host of ['web', 'desktop'] as const) {
  const r: UiDeliveryRequirement = { id: 'layout', host, requirementRevision: 'r1', buildFingerprint: 'dirty-build-1', instanceId: 'preview-1' };
  const o: UiDeliveryObservation = { ...r, requirementId: r.id, evidenceRef: 'observation://1', artifactHash: 'image-hash', admittedToRunId: 'model-1' };
  const j: UiDeliveryJudgment = { requirementId: r.id, observationRef: o.evidenceRef, evidenceRef: 'judgment://1', modelRunId: 'model-1', decision: 'passed' };
  const known = new Set([o.evidenceRef, j.evidenceRef]);
  const run = (obs = [o], judgments = [j], refs = known, requirements = [r]) => evaluateUiDelivery(requirements, obs, judgments, refs);
  test(`${host}: matching current observation and judgment`, () => assert.deepEqual(run(), { passed: true, gaps: [] }));
  test(`${host}: mechanical evidence without judgment`, () => assert.equal(run([], []).gaps[0]?.reason, 'judgment-missing'));
  test(`${host}: observation absent`, () => assert.equal(run([]).gaps[0]?.reason, 'observation-missing'));
  test(`${host}: duplicate observation identity rejected`, () => assert.equal(run([o, o]).passed, false));
  for (const field of ['requirementRevision', 'buildFingerprint', 'instanceId', 'requirementId', 'host'] as const) {
    test(`${host}: stale ${field}`, () => {
      const changed = { ...o, [field]: field === 'host' ? (host === 'web' ? 'desktop' : 'web') : 'old' } as UiDeliveryObservation;
      assert.equal(run([changed]).gaps[0]?.reason, 'observation-stale');
    });
  }
  for (const field of ['artifactHash', 'admittedToRunId'] as const) {
    test(`${host}: missing ${field}`, () => assert.equal(run([{ ...o, [field]: '' }]).gaps[0]?.reason, 'image-not-admitted'));
  }
  test(`${host}: image admitted to a different model run`, () => assert.equal(run([{ ...o, admittedToRunId: 'other' }]).passed, false));
  test(`${host}: empty model run`, () => assert.equal(run([o], [{ ...j, modelRunId: '' }]).passed, false));
  for (const decision of ['failed', 'unknown'] as const) {
    test(`${host}: latest ${decision} supersedes pass`, () => assert.equal(run([o], [j, { ...j, decision }]).gaps[0]?.reason, `judgment-${decision}`));
  }
  test(`${host}: unresolved judgment`, () => assert.equal(run([o], [j], new Set([o.evidenceRef])).gaps[0]?.reason, 'judgment-unresolved'));
  test(`${host}: unresolved observation`, () => assert.equal(run([o], [j], new Set([j.evidenceRef])).gaps[0]?.reason, 'observation-unresolved'));
  test(`${host}: duplicate requirements rejected`, () => assert.equal(run([o], [j], known, [r, r]).passed, false));
  test(`${host}: empty current build rejected`, () => assert.equal(run([o], [j], known, [{ ...r, buildFingerprint: '' }]).passed, false));
}
test('legacy non-UI task has no additional observation requirement', () => {
  assert.deepEqual(evaluateUiDelivery([], [], [], new Set()), { passed: true, gaps: [] });
});
