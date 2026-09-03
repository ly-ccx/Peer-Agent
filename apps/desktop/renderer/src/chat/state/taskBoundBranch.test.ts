import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildComposerBranchOptions,
  canSelectComposerSourceBranch,
  defaultComposerUpstreamSpec,
  formatComposerBranchOptionLabel,
  formatComposerEnvCapsule,
  isInternalIsolationBranch,
  parseComposerUpstreamSpec,
  planComposerGitChrome,
  resolveComposerCreateSourceBranch,
  sameComposerBranchRef,
  snapshotDeliveryLine,
} from './taskBoundBranch.ts';

test('snapshotDeliveryLine ignores plans without a git binding', () => {
  assert.equal(snapshotDeliveryLine(null), null);
  assert.equal(snapshotDeliveryLine({}), null);
  assert.equal(snapshotDeliveryLine({ deliveryBinding: { targetBranch: '  ' } }), null);
});

test('snapshotDeliveryLine keeps the recorded source, task line, and isolation fact', () => {
  assert.deepEqual(
    snapshotDeliveryLine({
      deliveryBinding: {
        targetBranch: 'develop',
        taskBranch: 'PeerAgent/fix-login',
        executionIsolation: 'worktree',
        worktreePath: '/tmp/peer-goal-worktrees/fix-login',
      },
    }),
    {
      targetBranch: 'develop',
      taskBranch: 'PeerAgent/fix-login',
      isolated: true,
      delivered: false,
    },
  );
  assert.equal(
    snapshotDeliveryLine({
      deliveryBinding: {
        targetBranch: 'develop',
        taskBranch: 'PeerAgent/fix-login',
        executionIsolation: 'worktree',
      },
    })?.isolated,
    false,
  );
});

test('delivered handoff is no longer current isolation and chrome returns to the source', () => {
  assert.deepEqual(
    snapshotDeliveryLine({
      deliveryBinding: {
        targetBranch: '0.0.7',
        taskBranch: 'PeerAgent/cli-drop-stream-buf',
        executionIsolation: 'worktree',
        worktreePath: '/tmp/peer-goal-worktrees/cli-drop-stream-buf',
      },
      deliveryHandoff: { status: 'delivered' },
    }),
    {
      targetBranch: '0.0.7',
      taskBranch: 'PeerAgent/cli-drop-stream-buf',
      isolated: false,
      delivered: true,
    },
  );
  const chrome = planComposerGitChrome({
    isDraft: false,
    deliveryKnown: true,
    currentHead: '0.0.7',
    delivery: {
      targetBranch: '0.0.7',
      taskBranch: 'PeerAgent/cli-drop-stream-buf',
      isolated: false,
      delivered: true,
    },
  }, { locale: 'zh' });
  assert.equal(chrome.taskLine?.kind, 'source');
  assert.equal(chrome.taskLine?.label, '源头 0.0.7');
  assert.equal(chrome.taskLine?.selectable, false);
  assert.equal(chrome.writeMismatch, null);
});

test('draft chrome keeps workspace HEAD stable and lets the source stay selectable', () => {
  const chrome = planComposerGitChrome({
    isDraft: true,
    delivery: null,
    workspaceBaseBranch: '0.0.7',
    currentHead: '0.0.7',
  }, { locale: 'zh' });
  assert.equal(chrome.workspaceHead?.label, '在 0.0.7');
  assert.equal(chrome.taskLine?.kind, 'source');
  assert.equal(chrome.taskLine?.label, '源头 0.0.7');
  assert.equal(chrome.taskLine?.selectable, true);
  assert.match(chrome.workspaceHead?.title ?? '', /不是本地\/远程标记/);
  assert.match(chrome.taskLine?.title ?? '', /不会切换当前工作区/);
  assert.equal(chrome.writeMismatch, null);
});

test('switching conversations does not change workspace HEAD when only the task line differs', () => {
  const head = '0.0.7';
  const first = planComposerGitChrome({
    isDraft: false,
    deliveryKnown: true,
    currentHead: head,
    delivery: null,
  }, { locale: 'zh' });
  const second = planComposerGitChrome({
    isDraft: false,
    deliveryKnown: true,
    currentHead: head,
    delivery: {
      targetBranch: '0.0.7',
      taskBranch: 'PeerAgent/cli-drop-stream-buf',
      isolated: false,
    },
  }, { locale: 'zh' });
  assert.equal(first.workspaceHead?.label, second.workspaceHead?.label);
  assert.equal(first.taskLine, null);
  assert.equal(second.taskLine?.kind, 'task-line');
  assert.equal(second.taskLine?.label, '任务线 cli-drop-stream-buf');
  assert.equal(second.taskLine?.selectable, false);
});

test('isolated task lines show an isolation mark and never a write mismatch', () => {
  const chrome = planComposerGitChrome({
    isDraft: false,
    deliveryKnown: true,
    currentHead: '0.0.7',
    delivery: {
      targetBranch: '0.0.7',
      taskBranch: 'PeerAgent/cli-drop-stream-buf',
      isolated: true,
    },
  }, { locale: 'zh' });
  assert.equal(chrome.taskLine?.kind, 'isolated');
  assert.equal(chrome.taskLine?.label, 'Worktree · cli-drop-stream-buf');
  assert.match(chrome.taskLine?.title ?? '', /Worktree/);
  assert.equal(chrome.writeMismatch, null);
});

test('non-isolated task lines warn when HEAD does not match the recorded line', () => {
  const chrome = planComposerGitChrome({
    isDraft: false,
    deliveryKnown: true,
    currentHead: '0.0.7',
    delivery: {
      targetBranch: '0.0.7',
      taskBranch: 'PeerAgent/cli-drop-stream-buf',
      isolated: false,
    },
  }, { locale: 'zh' });
  assert.equal(chrome.writeMismatch?.label, '写在当前工作区');
  assert.match(chrome.writeMismatch?.title ?? '', /0\.0\.7/);
});

test('hidden PeerAgent prefixes still count as the same workspace ref', () => {
  assert.equal(sameComposerBranchRef('0.0.7', 'PeerAgent/0.0.7'), true);
  assert.equal(sameComposerBranchRef('0.0.7', 'cli-drop-stream-buf'), false);
  const chrome = planComposerGitChrome({
    isDraft: false,
    deliveryKnown: true,
    currentHead: '0.0.7',
    delivery: { targetBranch: '0.0.7', taskBranch: 'PeerAgent/0.0.7', isolated: false },
  });
  assert.equal(chrome.writeMismatch, null);
});

test('internal isolation refs stay out of the visible task label', () => {
  const taskBranch = 'PeerAgent/automation-3d164dfe-9951-4db0-9aec-d88e1ab8cd5a/run-3d164dfe-9951-4db0-9aec-d88e1ab8cd5a';
  assert.equal(isInternalIsolationBranch(taskBranch), true);
  const chrome = planComposerGitChrome({
    isDraft: false,
    deliveryKnown: true,
    delivery: { targetBranch: 'main', taskBranch, isolated: false },
  }, { locale: 'zh' });
  assert.equal(chrome.taskLine?.label, '隔离线');
  assert.doesNotMatch(chrome.taskLine?.label ?? '', /automation-/);
});

test('an existing session waits for delivery facts before showing a source chip', () => {
  const chrome = planComposerGitChrome({
    isDraft: false,
    deliveryKnown: false,
    workspaceBaseBranch: 'develop',
    currentHead: '0.0.7',
  }, { locale: 'zh' });
  assert.equal(chrome.workspaceHead?.label, '在 0.0.7');
  assert.equal(chrome.taskLine, null);
});

test('env capsule shows Worktree when that is selected, and current workspace is not current branch', () => {
  const draft = planComposerGitChrome({
    isDraft: true,
    deliveryKnown: true,
    currentHead: 'sept-1-changes',
    workspaceBaseBranch: 'sept-1-changes',
  }, { locale: 'zh' });
  assert.equal(
    formatComposerEnvCapsule(draft, { locale: 'zh' })?.label,
    '在 sept-1-changes',
  );
  assert.equal(
    formatComposerEnvCapsule(draft, { locale: 'zh', preferredIsolation: true })?.label,
    'Worktree · 从 sept-1-changes',
  );

  const isolated = planComposerGitChrome({
    isDraft: false,
    deliveryKnown: true,
    currentHead: '0.0.7',
    delivery: {
      targetBranch: '0.0.7',
      taskBranch: 'PeerAgent/cli-drop-stream-buf',
      isolated: true,
    },
  }, { locale: 'zh' });
  assert.equal(
    formatComposerEnvCapsule(isolated, { locale: 'zh', preferredIsolation: false })?.label,
    'Worktree · cli-drop-stream-buf',
  );

  const delivered = planComposerGitChrome({
    isDraft: false,
    deliveryKnown: true,
    currentHead: '0.0.7',
    delivery: {
      targetBranch: '0.0.7',
      taskBranch: 'PeerAgent/cli-drop-stream-buf',
      isolated: false,
      delivered: true,
    },
  }, { locale: 'zh' });
  assert.equal(
    formatComposerEnvCapsule(delivered, { locale: 'zh' })?.label,
    '源头 0.0.7',
  );
  assert.doesNotMatch(
    formatComposerEnvCapsule(delivered, { locale: 'zh' })?.label ?? '',
    /当前分支/,
  );
  assert.equal(
    formatComposerEnvCapsule(delivered, { locale: 'zh', preferredIsolation: true })?.label,
    'Worktree · 从 0.0.7',
  );
  assert.equal(
    formatComposerEnvCapsule(delivered, { locale: 'zh', preferredIsolation: true })?.isolated,
    true,
  );

  const mismatch = planComposerGitChrome({
    isDraft: false,
    deliveryKnown: true,
    currentHead: 'main',
    delivery: {
      targetBranch: '0.0.7',
      taskBranch: 'PeerAgent/cli-drop-stream-buf',
      isolated: false,
    },
  }, { locale: 'zh' });
  assert.equal(
    formatComposerEnvCapsule(mismatch, { locale: 'zh' })?.label,
    '在 main · 写在当前工作区',
  );

  const unisolated = planComposerGitChrome({
    isDraft: false,
    deliveryKnown: true,
    currentHead: 'PeerAgent/cli-drop-stream-buf',
    delivery: {
      targetBranch: '0.0.7',
      taskBranch: 'PeerAgent/cli-drop-stream-buf',
      isolated: false,
    },
  }, { locale: 'zh' });
  assert.equal(
    formatComposerEnvCapsule(unisolated, { locale: 'zh', preferredIsolation: true })?.label,
    '在 cli-drop-stream-buf',
  );
});

test('draft composer can pick a source branch until a session or task line is bound', () => {
  assert.equal(canSelectComposerSourceBranch({ isDraft: true, delivery: null }), true);
  assert.equal(canSelectComposerSourceBranch({ isDraft: false, delivery: null }), false);
  assert.equal(
    canSelectComposerSourceBranch({
      isDraft: true,
      delivery: { targetBranch: '0.0.6', taskBranch: null, isolated: false },
    }),
    false,
  );
  assert.equal(
    canSelectComposerSourceBranch({
      isDraft: true,
      delivery: { targetBranch: null, taskBranch: 'PeerAgent/fix-login', isolated: false },
    }),
    false,
  );
});

test('composer branch options hide isolation UUID paths unless already selected', () => {
  const isolation = 'PeerAgent/automation-3d164dfe-9951-4db0-9aec-d88e1ab8cd5a/run-3d164dfe-9951-4db0-9aec-d88e1ab8cd5a';
  assert.deepEqual(
    buildComposerBranchOptions({
      branches: ['main', '  0.0.6  ', isolation, 'main'],
      selected: '0.0.6',
    }),
    [
      { value: 'main', kind: 'local' },
      { value: '0.0.6', kind: 'local' },
    ],
  );
  assert.deepEqual(
    buildComposerBranchOptions({
      branches: ['main'],
      selected: isolation,
    }),
    [
      { value: 'main', kind: 'local' },
      { value: isolation, kind: 'local' },
    ],
  );
  assert.deepEqual(
    buildComposerBranchOptions({
      localBranches: ['main', '0.0.7'],
      remoteBranches: ['origin/HEAD', 'origin/main', 'origin/0.0.7'],
      selected: 'origin/0.0.7',
    }),
    [
      { value: 'main', kind: 'local' },
      { value: '0.0.7', kind: 'local' },
      { value: 'origin/main', kind: 'remote' },
      { value: 'origin/0.0.7', kind: 'remote' },
    ],
  );
  assert.equal(formatComposerBranchOptionLabel('PeerAgent/0.0.6'), '0.0.6');
});

test('create-from source prefers the current selection over the highlighted list row', () => {
  assert.equal(
    resolveComposerCreateSourceBranch({
      highlighted: 'PeerAgent/0.0.5',
      selected: 'main',
      currentHead: '0.0.7',
    }),
    'main',
  );
  assert.equal(
    resolveComposerCreateSourceBranch({
      highlighted: 'origin/main',
      selected: null,
      currentHead: '0.0.7',
    }),
    'origin/main',
  );
  assert.equal(
    resolveComposerCreateSourceBranch({
      highlighted: '  ',
      selected: 'main',
      currentHead: '0.0.7',
    }),
    'main',
  );
  assert.equal(
    resolveComposerCreateSourceBranch({
      highlighted: null,
      selected: null,
      currentHead: '0.0.7',
    }),
    '0.0.7',
  );
});

test('create-branch upstream defaults to origin plus the local name', () => {
  assert.equal(defaultComposerUpstreamSpec('0.0.11'), 'origin/0.0.11');
  assert.deepEqual(parseComposerUpstreamSpec('', '0.0.11'), { remote: 'origin', branch: '0.0.11' });
  assert.deepEqual(parseComposerUpstreamSpec('origin/0.0.12', '0.0.11'), {
    remote: 'origin',
    branch: '0.0.12',
  });
  assert.deepEqual(parseComposerUpstreamSpec('upstream', 'release'), {
    remote: 'upstream',
    branch: 'release',
  });
  assert.equal(parseComposerUpstreamSpec('origin/--bad', '0.0.11'), null);
  assert.equal(parseComposerUpstreamSpec('origin/has space', '0.0.11'), null);
});
