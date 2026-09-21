import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createLocalDesktopPreviewProvider } from './local-desktop-preview-provider.mjs';
import { createChatPermissionGate } from '../chat-runtime/permission-gate.mjs';

// Negative-path tests only. Real rendering/provenance is exercised by the Electron smoke.
function fixture(t, overrides = {}, options = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'peer-preview-provider-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const plan = { planId: 'plan', conversationId: 'conversation', goal: 'Observe', successCriteria: [] };
  const actions = [];
  const adapter = { get: () => null, closeAll: async () => {},
    ...Object.fromEntries(['open', 'observe', 'close'].map(action => [action, async (...args) => {
      actions.push(action);
      if (typeof overrides[action] === 'function') return overrides[action](...args);
      throw new Error(`reached-${action}`);
    }])) };
  const provider = createLocalDesktopPreviewProvider({ workspaceRoot: home, userDataPath: home,
    goalPlanStore: { getPlan: id => id === plan.planId ? plan : null, listEvidenceIndex: () => [] }, adapter,
    nativeImage: options.nativeImage ?? { createFromBuffer() { throw new Error('unexpected-image-decode'); } },
    ...(options.hostVisualReview ? { hostVisualReview: options.hostVisualReview } : {}) });
  const invoke = (action, requestPermission, extra = {}) => provider.executeCapability({ call: {
    toolCallId: `call-${action}`, capabilityId: 'local.desktop.preview', arguments: { planId: 'plan', action },
  } }, { toolContext: { conversationId: 'conversation' }, locale: 'en-US', requestPermission, ...extra });
  return { home, plan, provider, invoke, actions };
}

for (const action of ['open', 'observe', 'close']) {
  for (const decision of ['allow', 'deny', 'missing']) {
    test(`${action} / permission ${decision}: preserve identity and failure evidence`, async t => {
      const f = fixture(t);
      let requests = 0;
      if (action === 'observe' && decision === 'allow') f.provider.authority.requirePreview(f.plan, {});
      const result = await f.invoke(action, decision === 'missing' ? undefined : async request => {
        requests++;
        assert.equal(request.capabilityId, 'local.desktop.preview');
        assert.equal(request.toolName, 'desktop_preview');
        assert.equal(request.riskLevel, 'L4_privileged');
        assert.equal(request.dataLevel, 'D2_sensitive');
        assert.deepEqual(request.args, { planId: 'plan', action, workspacePath: f.home });
        return { granted: decision === 'allow', duration: 'once' };
      });
      assert.equal(requests, decision === 'missing' ? 0 : 1);
      assert.equal(result.permissionGrant.granted, decision === 'allow');
      assert.equal(result.result.status, decision === 'allow' ? 'failed' : 'denied');
      assert.match(result.result.evidence.summary, decision === 'allow' ? new RegExp(`reached-${action}`) : /preview-permission-denied/);
      assert.deepEqual(f.actions, decision === 'allow' ? [action] : []);
      assert.equal(result.result.modelContext, undefined);
      assert.equal(existsSync(path.join(f.home, 'ui-delivery')), action === 'observe' && decision === 'allow');
    });
  }
}

for (const action of ['open', 'observe', 'close']) {
  for (const [scope, extra, reason] of [
    ['missing-plan', { callArguments: { action } }, 'preview-plan-required'],
    ['other-conversation', { toolContext: { conversationId: 'other' } }, 'preview-plan-conversation-mismatch'],
  ]) {
    test(`${action} / ${scope}: reject before permission`, async t => {
      const f = fixture(t);
      let requests = 0;
      const result = await f.provider.executeCapability({ call: {
        toolCallId: `call-${action}-${scope}`, capabilityId: 'local.desktop.preview',
        arguments: extra.callArguments ?? { planId: 'plan', action },
      } }, {
        toolContext: extra.toolContext ?? { conversationId: 'conversation' },
        locale: 'en-US',
        requestPermission: async () => { requests += 1; return { granted: true, duration: 'once' }; },
      });
      assert.equal(requests, 0);
      assert.equal(result.result.status, 'failed');
      assert.match(result.result.evidence.summary, new RegExp(reason));
      assert.deepEqual(f.actions, []);
    });
  }
}

test('open / matching-plan: reaches permission', async t => {
  const f = fixture(t);
  let requests = 0;
  await f.invoke('open', async () => { requests += 1; return { granted: false, duration: 'once' }; });
  assert.equal(requests, 1);
});

test('ask-before-local chat shows scoped L4 preview and denial reaches provider evidence', async t => {
  const f = fixture(t);
  const gate = createChatPermissionGate({ activeStreams: new Map(), accessLevel: 'ask_before_local' });
  let prompts = 0;
  const result = await f.invoke('open', gate.createLocalCapabilityPermissionRequester({
    streamId: 'test', toolCallId: 'call-open', workspacePath: f.home,
    webContents: { send(channel, { call }) {
      assert.equal(channel, 'chat:stream:permission-request');
      assert.equal(call.capabilityId, 'local.desktop.preview');
      assert.equal(call.riskLevel, 'L4_privileged');
      assert.deepEqual(call.arguments, { planId: 'plan', action: 'open', workspacePath: f.home });
      prompts++;
      gate.settlePermissionRequest(call.toolCallId, { granted: false, duration: 'once' });
    } },
  }));
  assert.equal(prompts, 1);
  assert.equal(result.result.status, 'denied');
  assert.deepEqual(f.actions, []);
});

for (const [kind, snapshot] of [
  ['required-unreviewed', { required: true, judgments: [] }],
  ['required-passed', { required: true, judgments: [{ decision: 'passed' }] }],
  ['non-ui', { required: false, judgments: [] }],
  ['cancelled-plan', { required: true, judgments: [] }],
]) {
  test(`close/${kind}/review-gate`, async t => {
    const f = fixture(t, { close: async () => ({ closed: true, instanceId: 'preview' }) });
    f.provider.authority.read = () => snapshot;
    f.plan.status = kind === 'cancelled-plan' ? 'cancelled' : 'executing';
    const result = await f.invoke('close', async () => ({ granted: true, duration: 'once' }));
    if (kind === 'required-unreviewed') {
      assert.equal(result.result.status, 'failed');
      assert.match(result.result.evidence.summary, /preview-review-pending/);
      assert.deepEqual(f.actions, []);
    } else {
      assert.equal(result.result.status, 'success');
      assert.deepEqual(f.actions, ['close']);
    }
  });
}

test('full-local retains the existing unified auto-grant policy, without provider bypass', async t => {
  const f = fixture(t);
  const gate = createChatPermissionGate({ activeStreams: new Map(), accessLevel: 'full_local' });
  const result = await f.invoke('close', gate.createLocalCapabilityPermissionRequester({
    streamId: 'test', toolCallId: 'call-close', workspacePath: f.home,
    webContents: { send() { assert.fail('existing full-local policy should auto-grant'); } },
  }));
  assert.equal(result.permissionGrant.granted, true);
  assert.deepEqual(f.actions, ['close']);
  assert.match(result.result.evidence.summary, /reached-close/);
});

test('cancel immediately after capture: no decode, observation, or success; close owned instance', async t => {
  const controller = new AbortController();
  let closes = 0;
  const f = fixture(t, { observe: async () => { controller.abort(); return {}; },
    close: async id => { assert.equal(id, 'conversation'); closes++; } });
  f.provider.authority.requirePreview(f.plan, {});
  const result = await f.invoke('observe', async () => ({ granted: true }), { signal: controller.signal });
  assert.equal(result.result.status, 'cancelled');
  assert.match(result.result.evidence.summary, /preview-aborted/);
  assert.equal(result.result.modelContext, undefined);
  assert.deepEqual(f.provider.authority.read(f.plan.planId).observations, []);
  assert.equal(closes, 1);
});

// Whether a captured image actually got an independent review must be visible outside the host
// path: otherwise "not scheduled" and "scheduled" look identical, and the close gate can sit on
// an empty judgment set with nothing recorded to explain why. These assert the durable ledger,
// which is exactly what the close gate reads (snapshot.judgments[0].decision).
const REVIEW_TEST_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const REVIEW_TEST_IDENTITY = { instanceId: 'preview-instance',
  sourceFingerprint: 'a'.repeat(64), buildFingerprint: 'b'.repeat(64) };
const REVIEW_TEST_IMAGE = { scene: 'application', pngBase64: REVIEW_TEST_PNG, width: 1, height: 1,
  ...REVIEW_TEST_IDENTITY };
const REVIEW_TEST_NATIVE_IMAGE = {
  createFromBuffer: () => ({ getSize: () => ({ width: 1, height: 1 }), isEmpty: () => false }),
};
const allow = async () => ({ granted: true, duration: 'once' });
function durableLedger(home, planId) {
  const digest = createHash('sha256').update(planId).digest('hex');
  return JSON.parse(readFileSync(path.join(home, 'ui-delivery', `${digest}.json`), 'utf8'));
}
function requirePreview(f) { f.provider.authority.requirePreview(f.plan, REVIEW_TEST_IDENTITY); }
// The duplex half of "not silent": whatever the provider decides, it must hand the authority a
// stable visual-review-* reason. Making that durable and releasing the close gate is already
// covered by the desktop-visual-review suite; here we pin the provider end of the handoff.
function capturedReviewReasons(f) {
  const reasons = [];
  f.provider.authority.recordReviewFailure = (planId, token, reason) => reasons.push(reason);
  return reasons;
}

test('observe / no host review: records a diagnosable failure instead of skipping silently', async t => {
  const f = fixture(t, { observe: async () => REVIEW_TEST_IMAGE }, { nativeImage: REVIEW_TEST_NATIVE_IMAGE });
  const reasons = capturedReviewReasons(f);
  requirePreview(f);
  const observed = await f.invoke('observe', allow);
  assert.equal(observed.result.status, 'success');
  assert.deepEqual(observed.result.outputPreview.hostReview,
    { scheduled: false, reason: 'visual-review-host-unavailable' });
  assert.deepEqual(reasons, ['visual-review-host-unavailable']);
});

test('observe / host review refuses to schedule: records why instead of skipping silently', async t => {
  const f = fixture(t, { observe: async () => REVIEW_TEST_IMAGE }, {
    nativeImage: REVIEW_TEST_NATIVE_IMAGE,
    hostVisualReview: { schedule: () => ({ scheduled: false, reason: 'preview-review-identity-missing' }) },
  });
  const reasons = capturedReviewReasons(f);
  requirePreview(f);
  const observed = await f.invoke('observe', allow);
  assert.deepEqual(observed.result.outputPreview.hostReview,
    { scheduled: false, reason: 'visual-review-not-scheduled:preview-review-identity-missing' });
  assert.deepEqual(reasons, ['visual-review-not-scheduled:preview-review-identity-missing']);
});

test('observe / host review throws while scheduling: records a diagnosable failure', async t => {
  const f = fixture(t, { observe: async () => REVIEW_TEST_IMAGE }, {
    nativeImage: REVIEW_TEST_NATIVE_IMAGE,
    hostVisualReview: { schedule: () => { throw new Error('boom'); } },
  });
  const reasons = capturedReviewReasons(f);
  requirePreview(f);
  const observed = await f.invoke('observe', allow);
  assert.deepEqual(observed.result.outputPreview.hostReview,
    { scheduled: false, reason: 'visual-review-host-schedule-error' });
  assert.deepEqual(reasons, ['visual-review-host-schedule-error']);
});

test('observe / host review already in flight: stays benign and records no failure', async t => {
  const f = fixture(t, { observe: async () => REVIEW_TEST_IMAGE }, {
    nativeImage: REVIEW_TEST_NATIVE_IMAGE,
    hostVisualReview: { schedule: () => ({ scheduled: false, reason: 'preview-review-in-flight' }) },
  });
  const reasons = capturedReviewReasons(f);
  requirePreview(f);
  const observed = await f.invoke('observe', allow);
  assert.deepEqual(observed.result.outputPreview.hostReview,
    { scheduled: false, reason: 'preview-review-in-flight', benign: true });
  assert.deepEqual(reasons, []);
  assert.deepEqual(durableLedger(f.home, f.plan.planId).judgments, []);
});

test('observe / host review scheduled: receipt shows it and records no failure', async t => {
  const f = fixture(t, { observe: async () => REVIEW_TEST_IMAGE }, {
    nativeImage: REVIEW_TEST_NATIVE_IMAGE,
    hostVisualReview: { schedule: () => ({ scheduled: true, verifierRunId: 'visual-verifier:test' }) },
  });
  const reasons = capturedReviewReasons(f);
  requirePreview(f);
  const observed = await f.invoke('observe', allow);
  assert.deepEqual(observed.result.outputPreview.hostReview,
    { scheduled: true, verifierRunId: 'visual-verifier:test', reason: null });
  assert.deepEqual(reasons, []);
  assert.deepEqual(durableLedger(f.home, f.plan.planId).judgments, []);
});
