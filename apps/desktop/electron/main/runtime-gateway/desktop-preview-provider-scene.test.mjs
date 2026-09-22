import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGoalPlanStore } from '@peer-agent/runtime-node';
import { createLocalDesktopPreviewProvider } from './local-desktop-preview-provider.mjs';
import { fingerprintPreviewSources, fingerprintPreviewBuild } from './desktop-preview-adapter.mjs';
import { desktopPreviewObservationSource } from './desktop-preview-service.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VvYAAAAASUVORK5CYII=', 'base64');
function fixture(t) {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-preview-scenes-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const dir of ['apps/desktop/electron', 'apps/desktop/renderer', 'apps/desktop/dist', 'packages', 'capabilities']) mkdirSync(path.join(home, dir), { recursive: true });
  for (const file of ['pnpm-lock.yaml', 'apps/desktop/package.json', 'apps/desktop/vite.config.ts']) writeFileSync(path.join(home, file), 'fixture');
  const store = createGoalPlanStore({ storeDir: path.join(home, 'plans') });
  const plan = store.createPlan({ conversationId: 'scene-conversation', title: 'Scenes', goal: 'Inspect the panel', tasks: [] });
  const identity = { instanceId: 'owned-instance', sourceFingerprint: fingerprintPreviewSources(home), buildFingerprint: fingerprintPreviewBuild(home) };
  let behavior = 'success', calls = 0, closes = 0, sequence = 0;
  const controller = new AbortController();
  const adapter = {
    get: () => ({ ...identity, child: { connected: true } }), closeAll: async () => {},
    close: async () => { closes++; },
    observe: async (conversationId, signal, scene) => {
      calls++;
      assert.equal(conversationId, plan.conversationId);
      // Recapture preserves history, but must not admit a prior review while UI work is in flight.
      const pending = provider.authority.read(plan.planId);
      assert.deepEqual(pending.judgments, []);
      assert.ok(pending.observations.every(item => item.admittedToRunId === ''));
      if (behavior === 'cancelled') controller.abort();
      if (behavior === 'failure') throw new Error('preview-scene-not-ready');
      return { ...identity, width: 1, height: 1, pngBase64: png.toString('base64'),
        scene: behavior === 'mismatch' ? (scene === 'application' ? 'background-runtime' : 'application') : scene };
    },
  };
  const reviews = [];
  let hostContext = null;
  const hostVisualReview = { schedule(plan, stored, context) {
    reviews.push({ planId: plan.planId, artifactHash: stored.artifactHash }); hostContext = context;
    return { scheduled: true, verifierRunId: `fixture-review-${reviews.length}` };
  } };
  const provider = createLocalDesktopPreviewProvider({ workspaceRoot: home, userDataPath: home, goalPlanStore: store, adapter, hostVisualReview,
    nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }) }) } });
  provider.authority.requirePreview(plan, identity);
  async function invoke(scene, granted = true, action = 'observe') {
    const toolCallId = `scene-${++sequence}`;
    const result = await provider.executeCapability({ call: { capabilityId: 'local.desktop.preview', toolCallId,
      arguments: { action, planId: plan.planId, ...(scene === undefined ? {} : { scene }) } } }, {
      toolContext: { conversationId: plan.conversationId }, signal: controller.signal,
      requestPermission: async request => {
        assert.equal(request.args.scene, scene);
        assert.equal(request.riskLevel, 'L4_privileged');
        return { granted };
      },
    });
    if (result.result.status === 'success') store.recordEvidenceRefs({ planId: plan.planId, conversationId: plan.conversationId,
      toolCallId, toolName: 'desktop_preview', capabilityId: 'local.desktop.preview',
      evidenceRefs: [`tool-result://${toolCallId}`], artifactRefs: result.result.evidence.artifactRefs,
      userArtifacts: result.result.evidence.userArtifacts });
    return result;
  }
  return { home, plan, provider, invoke, controller, setBehavior: value => { behavior = value; },
    counts: () => ({ calls, closes }), reviews, snapshot: () => provider.authority.read(plan.planId),
    hostContext: () => hostContext };
}

test('observe/host-review-failure/persists-a-diagnosable-judgment-and-releases-close', async t => {
  const f = fixture(t);
  const observed = await f.invoke('background-runtime');
  assert.equal(observed.result.status, 'success');
  const context = f.hostContext();
  assert.equal(typeof context.onFailure, 'function');
  context.onFailure(f.plan.planId, 'visual-review-service-unavailable');
  const snapshot = f.snapshot();
  assert.equal(snapshot.judgments.length, 1);
  assert.equal(snapshot.judgments[0].decision, 'failed');
  assert.equal(snapshot.judgments[0].reason, 'visual-review-service-unavailable');
  const closed = await f.invoke(undefined, true, 'close');
  assert.equal(closed.result.status, 'success');
  assert.equal(closed.result.outputPreview.reviewFailure, 'visual-review-service-unavailable');
  assert.equal(f.counts().closes, 1);
});

for (const scene of ['application', 'background-runtime']) {
  for (const outcome of ['granted', 'denied', 'cancelled', 'mismatch', 'failure']) {
    test(`${scene} / ${outcome}: permission, invalidation and exact scene`, async t => {
      const f = fixture(t);
      await f.invoke(scene); // Seed a real indexed fixture image, not a UI acceptance claim.
      const previous = f.snapshot().observations[0];
      f.setBehavior(outcome);
      const reply = await f.invoke(scene, outcome !== 'denied');
      assert.equal(reply.permissionGrant.scope.scene, scene);
      if (outcome === 'denied') {
        assert.equal(reply.result.status, 'denied');
        assert.equal(f.counts().calls, 1);
        assert.equal(f.snapshot().observations[0].artifactRef, previous.artifactRef);
      } else if (outcome === 'granted') {
        assert.equal(reply.result.status, 'success');
        assert.equal(reply.result.outputPreview.scene, scene);
        assert.equal(f.snapshot().observations.length, 2);
        assert.equal(f.snapshot().observations[0].artifactRef, previous.artifactRef, 'retain indexed history');
        assert.notEqual(f.snapshot().observations.at(-1).artifactRef, previous.artifactRef);
        assert.deepEqual(f.snapshot().judgments, [], 'a new image cannot inherit a pass');
        const visual = reply.result.modelContext.visualObservations[0];
        assert.equal(visual.scene, scene);
        const source = desktopPreviewObservationSource(visual);
        assert.equal(f.provider.validateVisualSource(visual, source).scene, scene);
        assert.throws(() => f.provider.validateVisualSource({ ...visual, scene: 'other' }, source), /scene/);
        assert.equal(f.reviews.at(-1)?.planId, f.plan.planId);
        assert.equal(f.reviews.at(-1)?.artifactHash, f.snapshot().observations.at(-1).artifactHash);
      } else {
        assert.equal(reply.result.status, outcome === 'cancelled' ? 'cancelled' : 'failed');
        assert.equal(reply.result.modelContext, undefined);
        assert.equal(f.snapshot().observations.length, 1, 'failed recapture retains history');
        assert.equal(f.snapshot().observations[0].artifactRef, previous.artifactRef);
        assert.equal(f.snapshot().observations[0].admittedToRunId, '');
        assert.deepEqual(f.snapshot().judgments, [], 'failed recapture cannot reuse a prior verdict');
        assert.equal(f.counts().calls, 2);
        assert.equal(f.counts().closes, outcome === 'cancelled' ? 1 : 0);
      }
    });
  }
}
for (const scene of ['other', null, {}, 'background-runtime;window.close()']) {
  test(`invalid scene ${JSON.stringify(scene)}: before permission or UI operation`, async t => {
    const f = fixture(t);
    const reply = await f.provider.executeCapability({ call: { capabilityId: 'local.desktop.preview', toolCallId: 'invalid',
      arguments: { action: 'observe', planId: f.plan.planId, scene } } }, {
      toolContext: { conversationId: f.plan.conversationId }, requestPermission: () => assert.fail('must not request permission'),
    });
    assert.match(reply.result.evidence.summary, /preview-scene-invalid/);
    assert.equal(f.counts().calls, 0);
  });
}
for (const action of ['open', 'close']) {
  test(`${action}: scene only belongs to observe`, async t => {
    const f = fixture(t);
    const reply = await f.invoke('background-runtime', true, action);
    assert.match(reply.result.evidence.summary, /preview-scene-invalid/);
    assert.equal(reply.permissionGrant, undefined);
  });
}
test('background-runtime cannot be downgraded by omitting scene', async t => {
  const f = fixture(t);
  await f.invoke('background-runtime');
  const reply = await f.invoke(undefined);
  assert.match(reply.result.evidence.summary, /preview-scene-downgrade/);
  assert.equal(f.counts().calls, 1);
  assert.equal(f.snapshot().observations[0].scene, 'background-runtime');
});
test('omitted scene: explicit application grant and artifact', async t => {
  const f = fixture(t);
  const reply = await f.invoke(undefined);
  assert.equal(reply.result.status, 'success');
  assert.equal(reply.permissionGrant.scope.scene, 'application');
  assert.equal(f.snapshot().observations[0].scene, 'application');
  assert.equal(readdirSync(path.join(f.home, 'ui-delivery/artifacts')).length, 2);
});
