import assert from 'node:assert/strict';
import test from 'node:test';

import type { GoalPlanProjectionSnapshot } from './task-overview.ts';
import { projectGoalPlan } from './task-overview.ts';
import type { ModelSelectionSnapshot } from './model-routing.ts';
import {
  createDelegationEvent,
  decideAcceptance,
  decideSurfacing,
  delegationEventId,
  projectMessageDispositions,
  projectWorkSession,
  type AcceptanceSessionFacts,
  type SurfacingEvent,
  type VerificationVerdict,
  type WorkSessionConversationMeta,
} from './delegation.ts';

const selection = {
  providerId: 'p',
  modelId: 'm',
  modelProviderId: 'p/m',
  family: 'f',
};

const modelSelection: ModelSelectionSnapshot = {
  worker: selection,
  explorer: selection,
  verifier: { ...selection, sameFamilyAsWorker: false },
  source: { worker: 'global' },
  resolvedAt: '2026-09-26T00:00:00.000Z',
};

const origin = {
  anchorMessageId: 'anchor',
  inputId: 'input-1',
  surface: 'desktop' as const,
  memorySnapshotId: 'snap-1',
  modelSelection,
  depth: 1,
};

function plan(overrides: Partial<GoalPlanProjectionSnapshot> = {}): GoalPlanProjectionSnapshot {
  return {
    planId: 'plan-1',
    status: 'executing',
    title: '修登录',
    conversationId: 'conv-1',
    updatedAt: '2026-09-26T01:00:00.000Z',
    ...overrides,
  };
}

function meta(overrides: Partial<WorkSessionConversationMeta> = {}): WorkSessionConversationMeta {
  return {
    workspaceId: 'ws-1',
    origin,
    spawnedAt: '2026-09-26T00:30:00.000Z',
    ...overrides,
  };
}

function agrees(snapshot: GoalPlanProjectionSnapshot, conversation: WorkSessionConversationMeta = meta()) {
  const session = projectWorkSession(snapshot, conversation);
  const projected = projectGoalPlan(snapshot);
  assert.equal(session.actionRight, projected.actionRight);
  assert.equal(session.nextAction, projected.nextAction);
  assert.equal(session.statusLabel, projected.statusLabel);
  assert.equal(session.needsYouReason, projected.needsYouReason);
  return session;
}

test('work session conclusion matches the goal-plan projection', () => {
  const awaiting = agrees(plan({ status: 'awaiting_approval' }));
  assert.equal(awaiting.status, 'waiting_user');
  assert.equal(awaiting.actionRight, 'needs_you');
  assert.equal(awaiting.needsYouReason, 'plan_approval');

  const running = agrees(plan({ runnerStatus: 'running' }));
  assert.equal(running.status, 'running');
  assert.equal(running.actionRight, 'peer_advancing');

  const waiting = agrees(plan({ status: 'executing', runnerStatus: 'waiting_user' }));
  assert.equal(waiting.status, 'waiting_user');
  assert.equal(waiting.needsYouReason, 'user_input');

  const paused = agrees(plan({ status: 'paused' }));
  assert.equal(paused.status, 'queued');
  assert.equal(paused.actionRight, 'paused');
  assert.equal(paused.statusLabel, '已暂停');

  const interrupted = agrees(plan({ status: 'interrupted', interrupted: true }));
  assert.equal(interrupted.status, 'queued');
  assert.equal(interrupted.actionRight, 'paused');

  const failed = agrees(plan({ status: 'failed' }));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.actionRight, 'terminal');

  const cancelled = agrees(plan({ status: 'cancelled' }));
  assert.equal(cancelled.status, 'cancelled');

  const done = agrees(plan({ status: 'completed' }));
  assert.equal(done.status, 'accepted');
  assert.equal(done.actionRight, 'terminal');

  const delivering = agrees(plan({ status: 'completed', deliveryHandoffStatus: 'delivering' }));
  assert.equal(delivering.status, 'accepted');
  assert.equal(delivering.actionRight, 'peer_advancing');
  assert.equal(delivering.statusLabel, '正在合进源头');

  const approved = agrees(plan({ status: 'approved' }));
  assert.equal(approved.status, 'queued');
  assert.equal(approved.statusLabel, '排队待执行');
});

test('verifying, result_ready, starting, and superseded are delegation statuses', () => {
  assert.equal(
    projectWorkSession(plan({ status: 'completed' }), meta({ acceptance: 'confirm' })).status,
    'result_ready',
  );
  assert.equal(
    projectWorkSession(plan({ status: 'completed' }), meta({ verifying: true })).status,
    'verifying',
  );
  assert.equal(
    projectWorkSession(plan({ runnerStatus: 'exploring' }), meta()).status,
    'verifying',
  );
  assert.equal(
    projectWorkSession(plan({ runnerStatus: 'running' }), meta({ phase: 'starting' })).status,
    'starting',
  );
  const superseded = agrees(plan({ runnerStatus: 'running' }), meta({ supersededBy: 'plan-2' }));
  assert.equal(superseded.status, 'superseded');
  assert.equal(superseded.supersededBy, 'plan-2');
  assert.equal(superseded.actionRight, 'peer_advancing');
});

test('dispositions answer the last user message and keep quoted sessions in scope', () => {
  const dispositions = projectMessageDispositions(
    [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
      { id: 'u2', role: 'user', quoteSessionIds: ['s-keep'] },
      { id: 'a2', role: 'assistant' },
      { id: 'a3', role: 'assistant', replyTo: ['u1'] },
    ],
    [
      { kind: 'spawn', anchorMessageId: 'u1', sessionId: 's1' },
      { kind: 'stop', anchorMessageId: 'u2', sessionId: 's-other', reason: 'stop that one' },
      { kind: 'merge', anchorMessageId: 'u2', sessionId: 's-keep' },
    ],
  );
  assert.deepEqual(
    dispositions.find((item) => item.kind === 'parallel'),
    { kind: 'parallel', messageId: 'u1', sessionIds: ['s1'] },
  );
  assert.deepEqual(
    dispositions.find((item) => item.kind === 'out_of_scope'),
    { kind: 'out_of_scope', messageId: 'u2', sessionId: 's-other' },
  );
  assert.deepEqual(
    dispositions.find((item) => item.kind === 'merged'),
    { kind: 'merged', messageId: 'u2', sessionId: 's-keep' },
  );
  assert.deepEqual(
    dispositions.filter((item) => item.kind === 'answered'),
    [
      { kind: 'answered', messageId: 'u1', replyMessageIds: ['a1'] },
      { kind: 'answered', messageId: 'u2', replyMessageIds: ['a2'] },
      { kind: 'answered', messageId: 'u1', replyMessageIds: ['a3'] },
    ],
  );
});

test('delegation event ids ignore object key order', () => {
  const left = delegationEventId({
    kind: 'session_spawned',
    sessionId: 's1',
    at: '2026-09-26T00:00:00.000Z',
    payload: { b: 1, a: { d: true, c: 'x' } },
  });
  const right = createDelegationEvent({
    kind: 'session_spawned',
    sessionId: 's1',
    at: '2026-09-26T00:00:00.000Z',
    payload: { a: { c: 'x', d: true }, b: 1 },
  });
  assert.equal(left, right.eventId);
  assert.equal(right.payload && typeof right.payload, 'object');
});

function surfacing(
  event: SurfacingEvent,
  proactivity: 'off' | 'low' | 'normal' | 'high',
  extra: { quietHours?: boolean; needsYou?: boolean; foreground?: boolean } = {},
) {
  return decideSurfacing({
    event,
    proactivity,
    foreground: extra.foreground ?? false,
    quietHours: extra.quietHours ?? false,
    needsYou: extra.needsYou ?? false,
  });
}

test('surfacing follows the delegation table from top to bottom', () => {
  const attention = ['needs_user', 'confirm', 'failure_needs_decision', 'objective_risk'] as const;
  for (const kind of attention) {
    assert.deepEqual(
      surfacing({ origin: 'user_request', kind, novelty: true, severity: 'info' }, 'off'),
      { decision: 'interrupt', reason: 'attention' },
    );
  }
  assert.equal(
    surfacing(
      { origin: 'user_request', kind: 'needs_user', novelty: true, severity: 'info' },
      'high',
      { quietHours: true },
    ).decision,
    'message',
  );
  assert.equal(
    surfacing(
      { origin: 'objective_signal', kind: 'objective_risk', novelty: true, severity: 'urgent', deadlineImminent: true },
      'off',
      { quietHours: true },
    ).decision,
    'interrupt',
  );
  assert.equal(
    surfacing(
      { origin: 'objective_signal', kind: 'objective_risk', novelty: true, severity: 'urgent' },
      'off',
      { quietHours: true },
    ).decision,
    'message',
  );

  assert.equal(surfacing({ origin: 'user_request', kind: 'result', novelty: true, severity: 'info' }, 'off').decision, 'message');
  assert.equal(surfacing({ origin: 'user_request', kind: 'result', novelty: true, severity: 'info' }, 'low').decision, 'message');
  assert.equal(surfacing({ origin: 'user_request', kind: 'result', novelty: true, severity: 'info' }, 'normal').decision, 'interrupt');
  assert.equal(surfacing({ origin: 'user_request', kind: 'result', novelty: true, severity: 'info' }, 'high').decision, 'interrupt');

  assert.deepEqual(
    surfacing({ origin: 'agent_idea', kind: 'observation', novelty: false, severity: 'urgent' }, 'high'),
    { decision: 'silent', reason: 'not_novel' },
  );
  assert.equal(
    surfacing({ origin: 'objective_signal', kind: 'observation', novelty: false, severity: 'notable' }, 'high').decision,
    'silent',
  );
  assert.equal(
    surfacing({ origin: 'agent_idea', kind: 'observation', novelty: true, severity: 'urgent' }, 'off').decision,
    'interrupt',
  );

  const notable = { origin: 'agent_idea' as const, kind: 'observation' as const, novelty: true, severity: 'notable' as const };
  assert.equal(surfacing(notable, 'off').decision, 'digest');
  assert.equal(surfacing(notable, 'low').decision, 'digest');
  assert.equal(surfacing(notable, 'normal').decision, 'message');
  assert.equal(surfacing(notable, 'high').decision, 'interrupt');
  assert.equal(
    surfacing({ origin: 'agent_idea', kind: 'idea', novelty: true, severity: 'notable' }, 'low').decision,
    'digest',
  );

  const info = { origin: 'agent_idea' as const, kind: 'observation' as const, novelty: true, severity: 'info' as const };
  assert.equal(surfacing(info, 'off').decision, 'silent');
  assert.equal(surfacing(info, 'low').decision, 'digest');
  assert.equal(surfacing(info, 'normal').decision, 'digest');
  assert.equal(surfacing(info, 'high').decision, 'message');
  assert.equal(
    surfacing({ origin: 'objective_signal', kind: 'idea', novelty: true, severity: 'info' }, 'high').decision,
    'message',
  );

  assert.deepEqual(
    surfacing({ origin: 'user_request', kind: 'observation', novelty: true, severity: 'info' }, 'off', { needsYou: true }),
    { decision: 'interrupt', reason: 'needs_you' },
  );
  const background = surfacing(notable, 'normal', { foreground: false });
  const foreground = surfacing(notable, 'normal', { foreground: true });
  assert.deepEqual(background, foreground);
});

const passedVerdict: VerificationVerdict = {
  outcome: 'passed',
  independentVerifier: 'passed',
  checks: [],
  evidenceRefs: ['ev-1'],
};

function acceptance(
  session: AcceptanceSessionFacts,
  extras: {
    verdict?: VerificationVerdict;
    policy?: 'auto' | 'confirm';
    userOverride?: { accept: boolean } | null;
  } = {},
) {
  return decideAcceptance({
    verdict: extras.verdict ?? passedVerdict,
    policy: extras.policy ?? 'auto',
    session,
    userOverride: extras.userOverride,
  });
}

test('policy acceptance requires a clean verdict, a posted reply, and the close gate', () => {
  assert.deepEqual(acceptance({ reported: true, closeGatePassed: true }), {
    mode: 'auto',
    acceptedBy: 'policy',
    reasons: [],
  });
  assert.deepEqual(acceptance({ reported: true, closeGatePassed: true }, { userOverride: { accept: false } }), {
    mode: 'auto',
    acceptedBy: 'policy',
    reasons: [],
  });
  assert.deepEqual(acceptance({ reported: true, closeGatePassed: true }, { userOverride: { accept: true } }), {
    mode: 'auto',
    acceptedBy: 'policy',
    reasons: [],
  });
  assert.deepEqual(acceptance({ closeGatePassed: true }), { mode: 'auto', reasons: [] });
  assert.deepEqual(acceptance({ reported: true, closeGatePassed: false }), { mode: 'auto', reasons: [] });
  assert.deepEqual(acceptance({ reported: true }), { mode: 'auto', reasons: [] });
});

test('confirm reasons stay ordered and a user override cannot mint policy acceptance', () => {
  const reasons = acceptance(
    {
      reported: true,
      closeGatePassed: true,
      manualCriteriaPending: true,
      externalSideEffects: true,
      destructiveOperation: true,
      outOfScopeWrite: true,
      userRequestedReview: true,
      verificationBelowFloor: true,
    },
    {
      policy: 'confirm',
      verdict: { ...passedVerdict, outcome: 'failed' },
    },
  );
  assert.deepEqual(reasons.reasons, [
    'verdict_not_passed',
    'manual_criteria_pending',
    'external_side_effects',
    'destructive_operation',
    'out_of_scope_write',
    'project_requires_confirm',
    'user_requested_review',
    'verification_below_floor',
  ]);
  assert.equal(reasons.mode, 'confirm');
  assert.equal(reasons.acceptedBy, undefined);

  const userAccepted = acceptance(
    { reported: true, closeGatePassed: true, destructiveOperation: true },
    { userOverride: { accept: true } },
  );
  assert.equal(userAccepted.mode, 'confirm');
  assert.equal(userAccepted.acceptedBy, 'user');
  assert.deepEqual(userAccepted.reasons, ['destructive_operation']);

  const blocked = acceptance(
    { reported: true, closeGatePassed: false, destructiveOperation: true },
    { userOverride: { accept: true } },
  );
  assert.equal(blocked.acceptedBy, undefined);
  assert.equal(blocked.mode, 'confirm');
});
