import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGoalPlanStore } from '@peer-agent/runtime-node';
import { createDesktopPreviewArtifactStore } from './desktop-preview-artifacts.mjs';
import { createUiDeliveryAuthority } from './ui-delivery-authority.mjs';
import { createWebUiCapture } from './web-ui-capture.mjs';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VvYAAAAASUVORK5CYII=',
  'base64',
);
const hash = value => createHash('sha256').update(String(value)).digest('hex');

function fixture(t) {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-web-capture-test-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = createGoalPlanStore({ storeDir: path.join(home, 'plans') });
  const options = { userDataPath: home, workspaceRoot: home, goalPlanStore: store };
  const artifacts = createDesktopPreviewArtifactStore(options);
  const authority = createUiDeliveryAuthority({ ...options, artifacts });
  const scheduled = [];
  const hostVisualReview = { schedule(plan, stored, context) {
    scheduled.push({ planId: plan.planId, artifactHash: stored.artifactHash, context });
    return { scheduled: true };
  } };
  const capture = createWebUiCapture({ goalPlanStore: store, authority, artifacts, hostVisualReview, workspaceRoot: home });
  const plan = store.createPlan({ conversationId: 'web-conversation', title: 'Web UI', goal: 'Deliver page',
    targetWorkspacePath: home, tasks: [{ taskId: 'observe', title: 'Observe', status: 'pending', evidenceRefs: [] }] });
  const other = store.createPlan({ conversationId: 'another-conversation', title: 'Other', goal: 'Other',
    targetWorkspacePath: home, tasks: [{ taskId: 'x', title: 'X', status: 'pending', evidenceRefs: [] }] });
  const shot = (extra = {}, target = plan, conversationId = 'web-conversation') => {
    const args = { ...captureArgs({ plan: target }, extra), conversationId, planId: target.planId };
    const stored = capture.capture(args);
    recordIndex(store, { planId: target.planId, conversationId, toolCallId: args.toolCallId, stored,
      toolName: 'browser_screenshot', capabilityId: 'local.web.control.screenshot' });
    return stored;
  };
  return { home, store, plan, other, authority, artifacts, capture, scheduled, shot };
}

// 生产链里工具结果会把自己的 evidence/artifact ref 写进证据索引；受治理产物必须已入索引，
// 否则 read() 不会承认它。这里照同一条规则写，避免测试自证。
function recordIndex(store, { planId, conversationId, toolCallId, stored, toolName, capabilityId }) {
  store.recordEvidenceRefs({ planId, conversationId, toolCallId, toolName, capabilityId,
    evidenceRefs: [stored.evidenceRef], artifactRefs: [stored.artifactRef],
    userArtifacts: [{ ref: stored.artifactRef, kind: 'image', label: 'Web.png' }] });
}

const captureArgs = (f, extra = {}) => ({ planId: f.plan.planId, conversationId: 'web-conversation',
  toolCallId: 'web-shot', png, width: 1, height: 1, finalUrl: 'https://example.test/panel',
  renderedText: 'panel body', instanceId: 'tab-1', ...extra });

test('governed-capture/writes-into-shared-store-and-registers-observation', t => {
  const f = fixture(t);
  const stored = f.shot();
  assert.match(stored.artifactRef, /^local-web-ui-artifact:\/\//);
  assert.equal(stored.host, 'web');
  const snapshot = f.authority.read(f.plan.planId);
  assert.equal(snapshot.requirements[0].host, 'web');
  assert.equal(snapshot.observations.length, 1);
  assert.equal(snapshot.observations[0].artifactRef, stored.artifactRef);
  // 身份三字段来自网页本身：会话实例、最终 URL、捕获时渲染文本。
  assert.equal(snapshot.observations[0].instanceId, 'tab-1');
  assert.equal(snapshot.observations[0].sourceFingerprint, hash('https://example.test/panel'));
  assert.equal(snapshot.observations[0].buildFingerprint, hash('panel body'));
});

test('governed-capture/schedules-host-review-once-with-failure-reporting', t => {
  const f = fixture(t);
  f.shot();
  assert.equal(f.scheduled.length, 1);
  assert.equal(f.scheduled[0].planId, f.plan.planId);
  assert.equal(typeof f.scheduled[0].context.onFailure, 'function');
  // 宿主复核自己失败时要落成可诊断判定，而不是静默留空。
  f.scheduled[0].context.onFailure(f.plan.planId, 'visual-review-service-unavailable');
  const snapshot = f.authority.read(f.plan.planId);
  assert.equal(snapshot.judgments[0]?.decision, 'failed');
  assert.equal(snapshot.judgments[0]?.reason, 'visual-review-service-unavailable');
});

test('plan-scope/missing-plan/is-rejected-and-writes-nothing', t => {
  const f = fixture(t);
  assert.throws(() => f.capture.capture(captureArgs(f, { planId: 'no-such-plan' })), /web-plan-missing/);
  assert.equal(f.authority.read(f.plan.planId).required, false);
});

test('plan-scope/other-conversation/is-rejected', t => {
  const f = fixture(t);
  assert.throws(() => f.capture.capture({ ...captureArgs(f), planId: f.other.planId }),
    /web-plan-conversation-mismatch/);
});

test('plan-scope/missing-instance-is-rejected', t => {
  const f = fixture(t);
  assert.throws(() => f.capture.capture(captureArgs(f, { instanceId: '' })), /web-instance-missing/);
});

test('identity/url-change/invalidates-the-old-shot', t => {
  const f = fixture(t);
  const first = f.shot();
  const second = f.shot({ finalUrl: 'https://example.test/other', toolCallId: 'web-shot-2' });
  const snapshot = f.authority.read(f.plan.planId);
  assert.notEqual(second.sourceFingerprint, first.sourceFingerprint);
  // 历史截图仍可追溯，但新页面不能复用旧判定。
  assert.equal(snapshot.observations.length, 2);
  assert.equal(snapshot.observations[0].artifactRef, first.artifactRef);
  assert.equal(snapshot.observations.at(-1).artifactRef, second.artifactRef);
  assert.equal(snapshot.observations.at(-1).sourceFingerprint, hash('https://example.test/other'));
  assert.deepEqual(snapshot.judgments, []);
});

test('identity/rendered-text-change/invalidates-the-old-shot', t => {
  const f = fixture(t);
  const first = f.shot();
  const second = f.shot({ renderedText: 'panel body v2', toolCallId: 'web-shot-2' });
  const snapshot = f.authority.read(f.plan.planId);
  assert.notEqual(second.buildFingerprint, first.buildFingerprint);
  assert.equal(snapshot.observations.length, 2);
  assert.equal(snapshot.observations[0].artifactRef, first.artifactRef, 'keep the indexed historical shot');
  assert.equal(snapshot.observations.at(-1).buildFingerprint, hash('panel body v2'));
  assert.deepEqual(snapshot.judgments, [], 'new content must receive its own review');
});

test('no-close-obligation/invalidation-after-page-change-blocks-prior-capture', t => {
  const f = fixture(t);
  const stored = f.shot();
  assert.equal(f.authority.read(f.plan.planId).observations.length, 1);
  const result = f.capture.invalidateAfterAction({ conversationId: 'web-conversation', action: 'navigate' });
  assert.deepEqual(result.invalidated, [f.plan.planId]);
  const snapshot = f.authority.read(f.plan.planId);
  assert.equal(snapshot.observations.length, 0);
  assert.equal(snapshot.judgments.length, 0);
  assert.equal(snapshot.required, true, 'the delivery requirement survives; only the evidence is void');
  assert.ok(stored.artifactRef);
});

test('no-close-obligation/read-only-action-does-not-invalidate', t => {
  const f = fixture(t);
  f.shot();
  for (const action of ['read_dom', 'hover', 'scroll', undefined]) {
    assert.deepEqual(f.capture.invalidateAfterAction({ conversationId: 'web-conversation', action }).invalidated, []);
  }
  assert.equal(f.authority.read(f.plan.planId).observations.length, 1);
});

test('invalidation/touches-only-web-requirements-in-the-same-conversation', t => {
  const f = fixture(t);
  // 桌面的同会话要求与另一个会话的网页要求都不应被网页动作清掉。
  f.authority.requirePreview(f.other, { sourceFingerprint: 'a'.repeat(64), buildFingerprint: 'b'.repeat(64),
    instanceId: 'desktop-1' }, 'desktop');
  f.authority.beginObservation(f.other, 'application');
  const stored = f.artifacts.write({ plan: f.other,
    observation: { sourceFingerprint: 'a'.repeat(64), buildFingerprint: 'b'.repeat(64), instanceId: 'desktop-1', scene: 'application' },
    toolCallId: 'desk-shot', png, width: 1, height: 1 });
  f.authority.recordObservation(f.other, stored);
  recordIndex(f.store, { planId: f.other.planId, conversationId: f.other.conversationId, toolCallId: 'desk-shot', stored,
    toolName: 'desktop_preview', capabilityId: 'local.desktop.preview' });
  f.shot();
  const otherWeb = f.store.createPlan({ conversationId: 'web-conversation', title: 'Second web', goal: 'Second',
    targetWorkspacePath: f.home, tasks: [{ taskId: 'y', title: 'Y', status: 'pending', evidenceRefs: [] }] });
  const second = f.shot({ toolCallId: 'web-shot-2' }, otherWeb);
  assert.match(second.artifactRef, /^local-web-ui-artifact:\/\//);
  const result = f.capture.invalidateAfterAction({ conversationId: 'web-conversation', action: 'click' });
  assert.deepEqual(result.invalidated.sort(), [f.plan.planId, otherWeb.planId].sort());
  // 桌面要求保留原样。
  const desktop = f.authority.read(f.other.planId);
  assert.equal(desktop.observations.length, 1);
  assert.equal(desktop.requirements[0].host, 'desktop');
});

test('binding/failed-judgment-then-invalidation-cannot-force-a-pass', t => {
  const f = fixture(t);
  f.shot();
  f.scheduled[0].context.onFailure(f.plan.planId, 'visual-review-host-error');
  assert.equal(f.authority.read(f.plan.planId).judgments[0].decision, 'failed');
  f.capture.invalidateAfterAction({ conversationId: 'web-conversation', action: 'type' });
  assert.equal(f.authority.read(f.plan.planId).judgments.length, 0);
});
