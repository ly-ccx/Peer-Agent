import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync, renameSync, symlinkSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGoalPlanStore } from '@peer-agent/runtime-node';
import { evaluateUiDelivery } from '@peer-agent/protocol';
import { createDesktopPreviewArtifactStore } from './desktop-preview-artifacts.mjs';
import { createUiDeliveryAuthority } from './ui-delivery-authority.mjs';
import { deriveTaskArtifacts, extractPlanSteps } from '../task-overview-aggregator.mjs';

// Fixture image tests persistence/integrity only; Electron smoke supplies real UI evidence.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VvYAAAAASUVORK5CYII=', 'base64');
const digest = value => createHash('sha256').update(value).digest('hex');
function fixture(t, scene = 'application') {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-preview-artifacts-test-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const storeDir = path.join(home, 'plans');
  let store = createGoalPlanStore({ storeDir });
  const plan = store.createPlan({ conversationId: 'conversation', title: 'Image test', goal: 'Inspect UI',
    targetWorkspacePath: home, tasks: [{ taskId: 'observe', title: 'Observe', status: 'pending', evidenceRefs: [] }] });
  let current = { sourceFingerprint: 'a'.repeat(64), buildFingerprint: 'b'.repeat(64), instanceId: 'instance-1' };
  const options = () => ({ userDataPath: home, workspaceRoot: home, goalPlanStore: store });
  let artifacts = createDesktopPreviewArtifactStore(options());
  const authorityOptions = () => ({ ...options(), artifacts, currentIdentity: () => current });
  let authority = createUiDeliveryAuthority(authorityOptions());
  authority.requirePreview(plan, current);
  authority.beginObservation(plan, scene);
  const stored = artifacts.write({ plan, observation: { ...current, scene }, toolCallId: 'capture-call', png, width: 1, height: 1 });
  authority.recordObservation(plan, stored);
  const indexInput = { planId: plan.planId, conversationId: plan.conversationId, toolCallId: 'capture-call',
    toolName: 'desktop_preview', capabilityId: 'local.desktop.preview', evidenceRefs: [stored.evidenceRef],
    artifactRefs: [stored.artifactRef], userArtifacts: [{ ref: stored.artifactRef, kind: 'image', label: 'Preview.png' }] };
  store.recordEvidenceRefs(indexInput);
  const ledgerPath = path.join(home, 'ui-delivery', `${digest(plan.planId)}.json`);
  const metadataPath = stored.filePath.replace(/\.png$/, '.json');
  const indexPath = path.join(storeDir, 'evidence-index.jsonl');
  return {
    home, plan, stored, metadataPath, ledgerPath, indexPath,
    get store() { return store; }, get artifacts() { return artifacts; }, get authority() { return authority; },
    setCurrent(value) { current = value; },
    reload() { store = createGoalPlanStore({ storeDir }); artifacts = createDesktopPreviewArtifactStore(options()); authority = createUiDeliveryAuthority(authorityOptions()); },
    changeJson(file, mutate) { const data = JSON.parse(readFileSync(file, 'utf8')); mutate(data); writeFileSync(file, JSON.stringify(data)); },
    changeIndex(mutate) { const rows = readFileSync(indexPath, 'utf8').trim().split('\n').map(JSON.parse); rows.forEach(mutate); writeFileSync(indexPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); },
    read(caller, scope = plan) {
      if (caller === 'runner') return authority.read(scope.planId);
      return deriveTaskArtifacts([stored.evidenceRef], store.listEvidenceIndex(), { resolveArtifact: artifacts.resolveArtifact }, scope);
    },
  };
}
for (const scene of ['application', 'background-runtime']) {
  for (const mutation of ['none', 'metadata-other', 'metadata-missing', 'ledger-other', 'observation-other']) {
    test(`${scene} / ${mutation}: durable scene cannot be silently replaced`, t => {
      const f = fixture(t, scene);
      if (mutation === 'metadata-other') f.changeJson(f.metadataPath, data => { data.scene = 'other'; });
      if (mutation === 'metadata-missing') f.changeJson(f.metadataPath, data => { delete data.scene; });
      if (mutation === 'ledger-other') f.changeJson(f.ledgerPath, data => { data.scene = 'other'; });
      if (mutation === 'observation-other') f.changeJson(f.ledgerPath, data => { data.observations[0].scene = 'other'; });
      f.reload();
      if (mutation === 'none' || (mutation === 'metadata-missing' && scene === 'application')) {
        assert.equal(f.read('runner').observations[0].scene, scene);
      } else assert.throws(() => f.read('runner'), /scene|metadata|mismatch/);
    });
  }
}
test('legacy records without any scene remain application, not background-runtime', t => {
  const f = fixture(t);
  f.changeJson(f.metadataPath, data => { delete data.scene; });
  f.changeJson(f.ledgerPath, data => { delete data.scene; delete data.observations[0].scene; });
  f.reload();
  assert.equal(f.read('runner').observations.length, 1);
  assert.throws(() => f.artifacts.read(f.stored.artifactRef, f.plan, { ...f.stored, scene: 'background-runtime' }), /mismatch/);
});
test('invalid scene is rejected before persisting a new artifact', t => {
  const f = fixture(t);
  assert.throws(() => f.artifacts.write({ plan: f.plan, observation: { ...f.stored, scene: 'other' },
    toolCallId: 'bad-scene', png, width: 1, height: 1 }), /preview-scene-invalid/);
});
test('beginReview/open-instance/allows independent review', t => {
  const f = fixture(t);
  const { token, observation } = f.authority.beginReview(f.plan.planId, 'review');
  assert.equal(observation.instanceId, f.stored.instanceId);
  assert.equal(typeof token, 'object');
});

test('beginReview/idle-closed/reviews-captured-image', t => {
  const f = fixture(t);
  f.setCurrent(null);
  const { token, observation } = f.authority.beginReview(f.plan.planId, 'review');
  assert.equal(observation.instanceId, f.stored.instanceId);
  assert.equal(typeof token, 'object');
});

test('beginReview/no-observation/current-image-missing', t => {
  const f = fixture(t);
  const file = path.join(f.home, 'ui-delivery', `${createHash('sha256').update(f.plan.planId).digest('hex')}.json`);
  const record = JSON.parse(readFileSync(file, 'utf8'));
  record.observations = [];
  writeFileSync(file, JSON.stringify(record));
  assert.throws(() => f.authority.beginReview(f.plan.planId, 'review'), /visual-review-current-image-missing/);
});

test('beginReview/replaced-instance/current-image-missing', t => {
  const f = fixture(t);
  f.setCurrent({ sourceFingerprint: 'c'.repeat(64), buildFingerprint: 'd'.repeat(64), instanceId: 'instance-2' });
  assert.throws(() => f.authority.beginReview(f.plan.planId, 'review'), /visual-review-current-image-missing/);
});

test('recordReviewFailure/no-token/persists-on-captured-image', t => {
  const f = fixture(t);
  f.setCurrent(null);
  f.authority.recordReviewFailure(f.plan.planId, null, 'visual-review-current-image-missing');
  const snapshot = f.authority.read(f.plan.planId);
  assert.equal(snapshot.judgments.length, 1);
  assert.equal(snapshot.judgments[0].decision, 'failed');
  assert.equal(snapshot.judgments[0].reason, 'visual-review-current-image-missing');
  assert.equal(snapshot.judgments[0].modelRunId, null);
});

test('beginObservation invalidates a pending review and keeps the prior observation', t => {
  const f = fixture(t);
  const { token } = f.authority.beginReview(f.plan.planId, 'review');
  f.authority.beginObservation(f.plan, 'background-runtime');
  const snapshot = f.read('runner');
  assert.equal(snapshot.observations.length, 1);
  assert.equal(snapshot.observations[0].artifactRef, f.stored.artifactRef);
  assert.throws(() => f.authority.finishReview(f.plan.planId, token, {}, {}), /stale/);
  assert.throws(() => f.authority.recordObservation(f.plan, f.stored), /scene-mismatch/);
});

test('recapture keeps a failed judgment and a later pass on a new artifact', t => {
  const f = fixture(t);
  f.authority.recordReviewFailure(f.plan.planId, null, 'visual-review-timeout');
  const first = f.authority.read(f.plan.planId);
  assert.equal(first.judgments[0].decision, 'failed');
  assert.equal(first.judgments[0].observationRef, f.stored.evidenceRef);

  const nextIdentity = {
    sourceFingerprint: 'c'.repeat(64),
    buildFingerprint: 'd'.repeat(64),
    instanceId: 'instance-2',
  };
  f.setCurrent(nextIdentity);
  f.authority.requirePreview(f.plan, nextIdentity);
  f.authority.beginObservation(f.plan, 'application');
  const next = f.artifacts.write({
    plan: f.plan,
    observation: { ...nextIdentity, scene: 'application' },
    toolCallId: 'capture-next',
    png,
    width: 1,
    height: 1,
  });
  f.authority.recordObservation(f.plan, next);
  const passEvidence = 'visual-review://repair-pass';
  f.store.recordEvidenceRefs({
    planId: f.plan.planId,
    conversationId: f.plan.conversationId,
    toolCallId: 'capture-next',
    toolName: 'desktop_preview',
    capabilityId: 'local.desktop.preview',
    evidenceRefs: [next.evidenceRef, passEvidence],
    artifactRefs: [next.artifactRef],
    userArtifacts: [{ ref: next.artifactRef, kind: 'image', label: 'Preview.png' }],
  });
  f.changeJson(f.ledgerPath, record => {
    record.judgments.push({
      requirementId: 'ui-artifact',
      observationRef: next.evidenceRef,
      modelRunId: 'repair-run',
      evidenceRef: passEvidence,
      decision: 'passed',
      artifactRef: next.artifactRef,
      artifactHash: next.artifactHash,
    });
  });

  const disk = JSON.parse(readFileSync(f.ledgerPath, 'utf8'));
  assert.equal(disk.observations.length, 2);
  assert.equal(disk.observations[0].artifactRef, f.stored.artifactRef);
  assert.equal(disk.observations[1].artifactRef, next.artifactRef);
  assert.equal(disk.judgments.length, 2);
  assert.equal(disk.judgments[0].decision, 'failed');
  assert.equal(disk.judgments[0].artifactRef, f.stored.artifactRef);
  assert.equal(disk.judgments[1].decision, 'passed');
  assert.equal(disk.judgments[1].artifactRef, next.artifactRef);

  const snapshot = f.authority.read(f.plan.planId);
  assert.equal(snapshot.observations.length, 2);
  assert.equal(snapshot.observations.at(-1).artifactRef, next.artifactRef);
  assert.equal(snapshot.judgments.length, 1);
  assert.equal(snapshot.judgments[0].decision, 'passed');
  assert.equal(snapshot.judgments[0].observationRef, next.evidenceRef);
  const gate = evaluateUiDelivery(
    snapshot.requirements,
    snapshot.observations,
    snapshot.judgments,
    new Set(f.store.listEvidenceIndex().map(record => record.evidenceRef)),
  );
  assert.equal(gate.passed, true);
});

test('an earlier pass cannot satisfy the current observation after recapture', t => {
  const f = fixture(t);
  const stalePass = 'visual-review://stale-pass';
  f.store.recordEvidenceRefs({
    planId: f.plan.planId,
    conversationId: f.plan.conversationId,
    toolCallId: 'stale-pass',
    toolName: 'desktop_preview',
    capabilityId: 'local.desktop.preview',
    evidenceRefs: [stalePass],
    artifactRefs: [f.stored.artifactRef],
    userArtifacts: [{ ref: f.stored.artifactRef, kind: 'image', label: 'Preview.png' }],
  });
  f.changeJson(f.ledgerPath, record => {
    record.judgments = [{
      requirementId: 'ui-artifact',
      observationRef: f.stored.evidenceRef,
      modelRunId: 'stale-run',
      evidenceRef: stalePass,
      decision: 'passed',
      artifactRef: f.stored.artifactRef,
      artifactHash: f.stored.artifactHash,
    }];
  });
  assert.equal(f.authority.read(f.plan.planId).judgments[0].decision, 'passed');

  const nextIdentity = {
    sourceFingerprint: 'c'.repeat(64),
    buildFingerprint: 'd'.repeat(64),
    instanceId: 'instance-2',
  };
  f.setCurrent(nextIdentity);
  f.authority.requirePreview(f.plan, nextIdentity);
  f.authority.beginObservation(f.plan, 'application');
  const next = f.artifacts.write({
    plan: f.plan,
    observation: { ...nextIdentity, scene: 'application' },
    toolCallId: 'capture-next',
    png,
    width: 1,
    height: 1,
  });
  f.authority.recordObservation(f.plan, next);
  f.store.recordEvidenceRefs({
    planId: f.plan.planId,
    conversationId: f.plan.conversationId,
    toolCallId: 'capture-next',
    toolName: 'desktop_preview',
    capabilityId: 'local.desktop.preview',
    evidenceRefs: [next.evidenceRef],
    artifactRefs: [next.artifactRef],
    userArtifacts: [{ ref: next.artifactRef, kind: 'image', label: 'Preview.png' }],
  });

  const disk = JSON.parse(readFileSync(f.ledgerPath, 'utf8'));
  assert.equal(disk.judgments.some(entry => entry.decision === 'passed' && entry.artifactRef === f.stored.artifactRef), true);
  const snapshot = f.authority.read(f.plan.planId);
  assert.equal(snapshot.observations.at(-1).artifactRef, next.artifactRef);
  assert.equal(snapshot.judgments.some(entry => entry.decision === 'passed'), false);
  const gate = evaluateUiDelivery(
    snapshot.requirements,
    snapshot.observations,
    snapshot.judgments,
    new Set(f.store.listEvidenceIndex().map(record => record.evidenceRef)),
  );
  assert.equal(gate.passed, false);
});

const scenarios = [
  ['valid', () => {}, true],
  ['reload', f => f.reload(), true],
  ['closed-instance-history', f => f.setCurrent(null), true],
  ['replaced-instance-history', f => f.setCurrent({ sourceFingerprint: 'c'.repeat(64), buildFingerprint: 'd'.repeat(64), instanceId: 'instance-2' }), true],
  ['changed-requirement-history', f => {
    const file = path.join(f.home, 'plans', `${f.plan.planId}.json`);
    f.changeJson(file, plan => { plan.goal = 'Changed requirement'; }); f.reload();
  }, true],
  ['png-changed', f => writeFileSync(f.stored.filePath, Buffer.concat([png, Buffer.from('changed')])), false],
  ['png-missing', f => rmSync(f.stored.filePath), false],
  ['png-oversized', f => writeFileSync(f.stored.filePath, Buffer.alloc(8 * 1024 * 1024 + 1)), false],
  ['metadata-corrupt', f => writeFileSync(f.metadataPath, '{'), false],
  ['metadata-missing', f => rmSync(f.metadataPath), false],
  ['wrong-conversation', f => f.changeJson(f.metadataPath, r => { r.conversationId = 'other'; }), false],
  ['wrong-workspace', f => f.changeJson(f.metadataPath, r => { r.workspacePath = path.dirname(f.home); }), false],
  ['index-call-mismatch', f => f.changeIndex(r => { r.toolCallId = 'other'; }), false],
  ['index-latest-mismatch', f => {
    const latest = { ...f.store.listEvidenceIndex()[0], toolCallId: 'other' };
    writeFileSync(f.indexPath, JSON.stringify(latest) + '\n', { flag: 'a' });
  }, false],
  ['index-conversation-mismatch', f => f.changeIndex(r => { r.conversationId = 'other'; }), false],
  ['index-plan-mismatch', f => f.changeIndex(r => { r.planId = 'other'; }), false],
  ['index-capability-mismatch', f => f.changeIndex(r => { r.capabilityId = 'local.file.read'; }), false],
  ['index-artifact-mismatch', f => f.changeIndex(r => { r.artifactRefs = []; }), false],
  ['png-symlink', f => { const moved = `${f.stored.filePath}.saved`; renameSync(f.stored.filePath, moved); symlinkSync(moved, f.stored.filePath); }, false],
  ['directory-symlink', f => { const dir = path.dirname(f.stored.filePath); renameSync(dir, `${dir}-saved`); symlinkSync(`${dir}-saved`, dir); }, false],
];
for (const caller of ['artifact-list', 'runner']) {
  for (const [name, mutate, valid] of scenarios) {
    test(`${caller} / ${name}`, t => {
      const f = fixture(t);
      mutate(f);
      if (!valid) {
        if (caller === 'runner') assert.throws(() => f.read(caller));
        else assert.deepEqual(f.read(caller), []);
        return;
      }
      const result = f.read(caller);
      if (caller === 'artifact-list') assert.equal(result[0]?.openPath, f.stored.filePath);
      else {
        assert.equal(result.required, true);
        assert.equal(result.judgments.length, 0);
        assert.equal(result.observations[0].admittedToRunId, '');
        if (name === 'changed-requirement-history') assert.notEqual(result.requirements[0].requirementRevision, result.observations[0].requirementRevision);
        if (name === 'closed-instance-history') assert.equal(result.requirements[0].instanceId, f.stored.instanceId);
        if (name === 'replaced-instance-history') assert.notEqual(result.requirements[0].buildFingerprint, result.observations[0].buildFingerprint);
      }
    });
  }
}
for (const caller of ['artifact-list', 'runner']) {
  test(`${caller} / path-traversal`, t => {
    const f = fixture(t);
    const bad = 'local-desktop-preview-artifact://../../outside';
    if (caller === 'runner') {
      f.changeJson(f.ledgerPath, r => { r.observations[0].artifactRef = bad; });
      assert.throws(() => f.read(caller));
    } else {
      f.changeIndex(r => { r.userArtifacts[0].ref = bad; r.userArtifacts[0].path = f.stored.filePath; });
      assert.deepEqual(f.read(caller), []);
    }
  });
}
test('runner / forged-judgment (historical artifact remains readable)', t => {
  const f = fixture(t);
  f.changeJson(f.ledgerPath, r => { r.judgments = [{ status: 'passed' }]; });
  // A hand-written judgment is dropped rather than failing the whole read: dropping is
  // fail-closed (no judgment, no admission), while throwing would break every reader.
  const snapshot = f.read('runner');
  assert.equal(snapshot.judgments.length, 0);
  assert.equal(snapshot.observations[0].admittedToRunId, '');
  assert.equal(f.read('artifact-list')[0].openPath, f.stored.filePath);
});
for (const [name, mutate] of [
  ['forged-admission', r => { r.observations[0].admittedToRunId = 'fake-run'; }],
  ['observation-hash-mismatch', r => { r.observations[0].artifactHash = 'e'.repeat(64); }],
]) {
  test(`runner / ${name} (historical artifact remains readable)`, t => {
    const f = fixture(t);
    f.changeJson(f.ledgerPath, mutate);
    assert.throws(() => f.read('runner'));
    assert.equal(f.read('artifact-list')[0].openPath, f.stored.filePath);
  });
}
test('runner / missing requirement files stays required through durable index', t => {
  const f = fixture(t);
  rmSync(f.ledgerPath);
  rmSync(path.join(f.home, 'ui-delivery/required', digest(f.plan.planId)));
  assert.throws(() => f.read('runner'), /marker-missing/);
});
test('artifact-list / wrong caller plan cannot reuse another plan evidence', t => {
  const f = fixture(t);
  const other = f.store.createPlan({ conversationId: 'other', title: 'Other', goal: 'Other', tasks: [{ taskId: 'x', title: 'x', evidenceRefs: [f.stored.evidenceRef] }] });
  const steps = extractPlanSteps(other, f.store.listEvidenceIndex(), { resolveArtifact: f.artifacts.resolveArtifact });
  assert.equal(steps[0].artifacts, undefined);
});
test('artifact-list / invalid ref cannot bypass resolver with declared path', t => {
  const f = fixture(t);
  f.changeIndex(r => { r.userArtifacts[0].path = f.stored.filePath; });
  writeFileSync(f.metadataPath, '{}');
  assert.deepEqual(f.read('artifact-list'), []);
});
test('runner / legacy non-UI task remains optional', t => {
  const f = fixture(t);
  const other = f.store.createPlan({ conversationId: 'other', title: 'Code', goal: 'Code', tasks: [] });
  assert.deepEqual(f.authority.read(other.planId), { required: false });
});
test('artifact-list / unrelated file keeps existing resolution', t => {
  const f = fixture(t);
  const file = path.join(f.home, 'notes.txt'); writeFileSync(file, 'notes');
  const rows = [{ evidenceRef: 'file-evidence', userArtifacts: [{ ref: file, path: file, kind: 'file', label: 'notes.txt' }] }];
  assert.equal(deriveTaskArtifacts(['file-evidence'], rows, { resolveArtifact: f.artifacts.resolveArtifact })[0].openPath, file);
});
test('writer / symlinked directory is refused before writing outside root', t => {
  const f = fixture(t);
  const dir = path.dirname(f.stored.filePath); const outside = path.join(f.home, 'outside'); mkdirSync(outside);
  renameSync(dir, `${dir}-old`); symlinkSync(outside, dir);
  assert.throws(() => f.artifacts.write({ plan: f.plan, observation: {}, png, width: 1, height: 1, toolCallId: 'new' }), /path/);
});
test('getPlan / UI projection must not recurse through artifact identity', { timeout: 2000 }, t => {
  const f = fixture(t);
  let nested = 0;
  const originalGetPlan = f.store.getPlan.bind(f.store);
  f.store.getPlan = (planId) => {
    nested += 1;
    assert.ok(nested < 8, 'artifact identity must not re-enter projected getPlan');
    return originalGetPlan(planId);
  };
  const started = Date.now();
  const snapshot = f.authority.read(f.plan.planId, f.plan);
  assert.ok(Date.now() - started < 1000);
  assert.equal(nested, 0, 'hostPlan must satisfy artifact identity without getPlan');
  assert.equal(snapshot.required, true);
  const wired = createGoalPlanStore({
    storeDir: path.join(f.home, 'plans'),
    readUiDelivery: (plan) => f.authority.read(plan.planId, plan),
  });
  const listed = wired.listPlans();
  const plan = wired.getPlan(f.plan.planId);
  assert.ok(Date.now() - started < 1000);
  assert.equal(listed[0].planId, f.plan.planId);
  assert.notEqual(plan.status, undefined);
});

// 网页格的前置：同一个账本要能声明宿主，且两种宿主的观察不能互相顶替。
function webFixture(t) {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-web-artifacts-test-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const storeDir = path.join(home, 'plans');
  const store = createGoalPlanStore({ storeDir });
  const plan = store.createPlan({ conversationId: 'web-conversation', title: 'Web image test', goal: 'Inspect web UI',
    targetWorkspacePath: home, tasks: [{ taskId: 'observe', title: 'Observe', status: 'pending', evidenceRefs: [] }] });
  const identity = { sourceFingerprint: 'e'.repeat(64), buildFingerprint: 'f'.repeat(64), instanceId: 'web-session-1' };
  const options = { userDataPath: home, workspaceRoot: home, goalPlanStore: store };
  const artifacts = createDesktopPreviewArtifactStore(options);
  const authority = createUiDeliveryAuthority({ ...options, artifacts,
    currentIdentity: (conversationId, host) => (host === 'desktop' ? null : identity) });
  return { home, store, plan, identity, artifacts, authority };
}

test('host/web/requirement-and-capture/can-be-reviewed', t => {
  const f = webFixture(t);
  f.authority.requirePreview(f.plan, f.identity, 'web');
  assert.equal(f.authority.read(f.plan.planId).requirements[0].host, 'web');
  f.authority.beginObservation(f.plan, 'application');
  const stored = f.artifacts.write({ plan: f.plan,
    observation: { ...f.identity, host: 'web', scene: 'application' }, toolCallId: 'web-capture', png, width: 1, height: 1 });
  assert.equal(stored.host, 'web');
  f.store.recordEvidenceRefs({ planId: f.plan.planId, conversationId: f.plan.conversationId, toolCallId: 'web-capture',
    toolName: 'browser_screenshot', capabilityId: 'local.web.control.screenshot', evidenceRefs: [stored.evidenceRef],
    artifactRefs: [stored.artifactRef], userArtifacts: [{ ref: stored.artifactRef, kind: 'image', label: 'Web.png' }] });
  f.authority.recordObservation(f.plan, stored);
  const snapshot = f.authority.read(f.plan.planId);
  assert.equal(snapshot.observations.length, 1);
  assert.equal(snapshot.observations[0].host, 'web');
  assert.equal(typeof f.authority.beginReview(f.plan.planId, 'web-review').token, 'object');
});

test('host/web/desktop-capture/cannot-satisfy-web-requirement', t => {
  const f = webFixture(t);
  f.authority.requirePreview(f.plan, f.identity, 'web');
  f.authority.beginObservation(f.plan, 'application');
  const stored = f.artifacts.write({ plan: f.plan,
    observation: { ...f.identity, scene: 'application' }, toolCallId: 'desktop-capture', png, width: 1, height: 1 });
  assert.equal(stored.host, 'desktop');
  assert.throws(() => f.authority.recordObservation(f.plan, stored), /preview-observation-host-mismatch/);
  assert.equal(f.authority.read(f.plan.planId).observations.length, 0);
});

test('host/desktop/web-capture/cannot-satisfy-desktop-requirement', t => {
  const f = fixture(t);
  assert.throws(() => f.authority.recordObservation(f.plan, { ...f.stored, host: 'web' }),
    /preview-observation-host-mismatch/);
  assert.equal(f.authority.read(f.plan.planId).observations.length, 1);
});

test('host/unknown/is-rejected-before-any-capture', t => {
  const f = webFixture(t);
  assert.throws(() => f.authority.requirePreview(f.plan, f.identity, 'mobile'), /preview-host-invalid/);
  assert.throws(() => f.artifacts.write({ plan: f.plan, observation: { ...f.identity, host: 'mobile' },
    toolCallId: 'bad-host', png, width: 1, height: 1 }), /preview-host-invalid/);
});

test('host/defaults-to-desktop/when-record-omits-it', t => {
  const f = fixture(t);
  const snapshot = f.authority.read(f.plan.planId);
  assert.equal(snapshot.requirements[0].host, 'desktop');
  assert.equal(snapshot.observations[0].host, 'desktop');
});

test('host/web/artifact-ref/is-not-mistaken-for-a-desktop-capture', t => {
  const f = webFixture(t);
  f.authority.requirePreview(f.plan, f.identity, 'web');
  f.authority.beginObservation(f.plan, 'application');
  const stored = f.artifacts.write({ plan: f.plan,
    observation: { ...f.identity, host: 'web', scene: 'application' }, toolCallId: 'web-prefix', png, width: 1, height: 1 });
  assert.match(stored.artifactRef, /^local-web-ui-artifact:\/\//);
  assert.doesNotMatch(stored.artifactRef, /desktop-preview/);
});

test('host/ref-prefix-and-record-host/must-agree', t => {
  const f = fixture(t);
  const stored = f.artifacts.write({ plan: f.plan,
    observation: { ...f.stored, scene: 'application' }, toolCallId: 'prefix-swap', png, width: 1, height: 1 });
  const swapped = { ...stored,
    artifactRef: stored.artifactRef.replace('local-desktop-preview-artifact://', 'local-web-ui-artifact://') };
  assert.throws(() => f.artifacts.read(swapped.artifactRef, f.plan, swapped), /preview-artifact-record/);
});

// 复核是在 observe 工具调用内部调度的，那时工具结果还没写进证据索引。失败判定绝不能沿用
// 需要索引的 read()，否则失败会在每层 catch{} 里被吞掉——第 30.2 节要消灭的静默。
test('recordReviewFailure/before-indexing/still-lands-a-diagnosis', t => {
  const f = fixture(t);
  const plan = f.plan.planId;
  // 观察已记录，但刻意不把产物写进证据索引：这正是 observe 调用内部的真实时序。
  f.authority.recordReviewFailure(plan, null, 'visual-review-timeout');
  const snapshot = f.authority.read(plan);
  assert.equal(snapshot.judgments.length, 1);
  assert.equal(snapshot.judgments[0].decision, 'failed');
  assert.equal(snapshot.judgments[0].reason, 'visual-review-timeout');
  assert.equal(snapshot.judgments[0].modelRunId, null);
});

test('recordReviewFailure/stale-token/is-a-no-op', t => {
  const f = fixture(t);
  const plan = f.plan.planId;
  // 带 token 的失败必须匹配当前在飞复核：陈旧 token 不得改动账本。
  f.authority.recordReviewFailure(plan, 'stale-token-that-was-never-minted', 'visual-review-host-error');
  assert.equal(f.authority.read(plan).judgments.length, 0);
});

// ---- 必需反例（知识第 7 节）：这两条此前只有生产代码、没有断言 ----

test('invalid-image/not-a-png/is-rejected-before-persisting', t => {
  const f = fixture(t);
  assert.throws(() => f.artifacts.write({ plan: f.plan, observation: { ...f.stored, scene: 'application' },
    toolCallId: 'bad-png', png: Buffer.from('definitely not a png'), width: 1, height: 1 }),
  /preview-invalid-png/);
});

test('invalid-image/dimension-mismatch/is-rejected', t => {
  const f = fixture(t);
  // 声明的尺寸与真实 PNG 头不符：不得把「说的尺寸」当成事实落盘。
  assert.throws(() => f.artifacts.write({ plan: f.plan, observation: { ...f.stored, scene: 'application' },
    toolCallId: 'bad-size', png, width: 900, height: 900 }),
  /preview-invalid-png/);
});

test('cross-instance-reference/other-instance-observation/is-rejected', t => {
  const f = fixture(t);
  // 产物属于 instance-1；用另一个实例的观察去引用它必须被拒。
  assert.throws(() => f.artifacts.read(f.stored.artifactRef, f.plan,
    { ...f.stored, instanceId: 'some-other-instance' }), /preview-observation-mismatch/);
});

test('cross-instance-reference/other-build-observation/is-rejected', t => {
  const f = fixture(t);
  assert.throws(() => f.artifacts.read(f.stored.artifactRef, f.plan,
    { ...f.stored, buildFingerprint: 'c'.repeat(64) }), /preview-observation-mismatch/);
});

function nestedWorkspaceFixture(t, { originWorkspacePath, targetWorkspacePath } = {}) {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-preview-nested-ws-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const nested = path.join(home, 'apps', 'desktop');
  mkdirSync(nested, { recursive: true });
  const store = createGoalPlanStore({ storeDir: path.join(home, 'plans') });
  const plan = store.createPlan({
    conversationId: 'conversation',
    title: 'Nested workspace',
    goal: 'Inspect UI',
    originWorkspacePath: originWorkspacePath ?? nested,
    targetWorkspacePath: targetWorkspacePath ?? nested,
    tasks: [{ taskId: 'observe', title: 'Observe', status: 'pending', evidenceRefs: [] }],
  });
  const current = { sourceFingerprint: 'a'.repeat(64), buildFingerprint: 'b'.repeat(64), instanceId: 'instance-1' };
  const artifacts = createDesktopPreviewArtifactStore({
    userDataPath: home,
    workspaceRoot: home,
    goalPlanStore: store,
  });
  const authority = createUiDeliveryAuthority({
    userDataPath: home,
    workspaceRoot: home,
    goalPlanStore: store,
    artifacts,
    currentIdentity: () => current,
  });
  authority.requirePreview(plan, current);
  authority.beginObservation(plan, 'background-runtime');
  const declared = originWorkspacePath ?? nested;
  Object.assign(plan, {
    originWorkspacePath: declared,
    targetWorkspacePath: targetWorkspacePath ?? declared,
    executionWorkspacePath: declared,
  });
  return { home, nested, plan, current, artifacts, authority, store };
}

test('artifact write allows a plan workspace nested inside the registered root', t => {
  const f = nestedWorkspaceFixture(t);
  const stored = f.artifacts.write({
    plan: f.plan,
    observation: { ...f.current, scene: 'background-runtime' },
    toolCallId: 'nested-ok',
    png,
    width: 1,
    height: 1,
  });
  f.authority.recordObservation(f.plan, stored);
  f.store.recordEvidenceRefs({
    planId: f.plan.planId,
    conversationId: f.plan.conversationId,
    toolCallId: 'nested-ok',
    toolName: 'desktop_preview',
    capabilityId: 'local.desktop.preview',
    evidenceRefs: [stored.evidenceRef],
    artifactRefs: [stored.artifactRef],
    userArtifacts: [{ ref: stored.artifactRef, kind: 'image', label: 'Preview.png' }],
  });
  const read = f.artifacts.read(stored.artifactRef, f.plan);
  assert.equal(read.artifactRef, stored.artifactRef);
});

test('artifact write rejects a different repository and a prefix-spoofed sibling', t => {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-preview-ws-root-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sibling = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-preview-ws-other-')));
  t.after(() => rmSync(sibling, { recursive: true, force: true }));
  const spoof = `${home}-other`;
  mkdirSync(spoof, { recursive: true });
  t.after(() => rmSync(spoof, { recursive: true, force: true }));

  const store = createGoalPlanStore({ storeDir: path.join(home, 'plans') });
  const current = { sourceFingerprint: 'a'.repeat(64), buildFingerprint: 'b'.repeat(64), instanceId: 'instance-1' };
  const artifacts = createDesktopPreviewArtifactStore({
    userDataPath: home,
    workspaceRoot: home,
    goalPlanStore: store,
  });
  const authority = createUiDeliveryAuthority({
    userDataPath: home,
    workspaceRoot: home,
    goalPlanStore: store,
    artifacts,
    currentIdentity: () => current,
  });

  const siblingPlan = store.createPlan({
    conversationId: 'sibling',
    title: 'Other repo',
    goal: 'Inspect UI',
    originWorkspacePath: sibling,
    targetWorkspacePath: sibling,
    tasks: [{ taskId: 'observe', title: 'Observe', status: 'pending', evidenceRefs: [] }],
  });
  authority.requirePreview(siblingPlan, current);
  authority.beginObservation(siblingPlan, 'background-runtime');
  Object.assign(siblingPlan, {
    originWorkspacePath: sibling,
    targetWorkspacePath: sibling,
    executionWorkspacePath: sibling,
  });
  const siblingStored = artifacts.write({
    plan: siblingPlan,
    observation: { ...current, scene: 'background-runtime' },
    toolCallId: 'sibling-bad',
    png,
    width: 1,
    height: 1,
  });
  assert.throws(() => artifacts.read(siblingStored.artifactRef, siblingPlan, siblingStored),
    /preview-artifact-workspace/);

  const spoofPlan = store.createPlan({
    conversationId: 'spoof',
    title: 'Prefix spoof',
    goal: 'Inspect UI',
    originWorkspacePath: spoof,
    targetWorkspacePath: spoof,
    tasks: [{ taskId: 'observe', title: 'Observe', status: 'pending', evidenceRefs: [] }],
  });
  authority.requirePreview(spoofPlan, current);
  authority.beginObservation(spoofPlan, 'background-runtime');
  Object.assign(spoofPlan, {
    originWorkspacePath: spoof,
    targetWorkspacePath: spoof,
    executionWorkspacePath: spoof,
  });
  const spoofStored = artifacts.write({
    plan: spoofPlan,
    observation: { ...current, scene: 'background-runtime' },
    toolCallId: 'spoof-bad',
    png,
    width: 1,
    height: 1,
  });
  assert.throws(() => artifacts.read(spoofStored.artifactRef, spoofPlan, spoofStored),
    /preview-artifact-workspace/);
});
