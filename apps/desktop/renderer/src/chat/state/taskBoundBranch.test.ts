import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildComposerBranchOptions,
  canSelectComposerSourceBranch,
  formatComposerBoundBranch,
  formatComposerBranchOptionLabel,
  isInternalIsolationBranch,
  snapshotDeliveryLine,
} from './taskBoundBranch.ts';

test('snapshotDeliveryLine ignores plans without a git binding', () => {
  assert.equal(snapshotDeliveryLine(null), null);
  assert.equal(snapshotDeliveryLine({}), null);
  assert.equal(snapshotDeliveryLine({ deliveryBinding: { targetBranch: '  ' } }), null);
});

test('snapshotDeliveryLine keeps the recorded source and task line', () => {
  assert.deepEqual(
    snapshotDeliveryLine({
      deliveryBinding: { targetBranch: 'develop', taskBranch: 'PeerAgent/fix-login' },
    }),
    { targetBranch: 'develop', taskBranch: 'PeerAgent/fix-login' },
  );
});

test('formatComposerBoundBranch prefers the task line over workspace HEAD', () => {
  const view = formatComposerBoundBranch({
    delivery: { targetBranch: 'develop', taskBranch: 'PeerAgent/fix-login' },
    workspaceBaseBranch: 'main',
    currentHead: 'feature/wip',
  }, { locale: 'zh' });
  assert.equal(view?.kind, 'task-line');
  assert.equal(view?.label, 'fix-login · from develop');
  assert.match(view?.title ?? '', /PeerAgent\/fix-login/);
});

test('formatComposerBoundBranch hides automation UUID paths in the visible label', () => {
  const taskBranch = 'PeerAgent/automation-3d164dfe-9951-4db0-9aec-d88e1ab8cd5a/run-3d164dfe-9951-4db0-9aec-d88e1ab8cd5a';
  assert.equal(isInternalIsolationBranch(taskBranch), true);
  const view = formatComposerBoundBranch({
    delivery: { targetBranch: 'main', taskBranch },
  }, { locale: 'zh' });
  assert.equal(view?.kind, 'task-line');
  assert.equal(view?.label, 'from main');
  assert.match(view?.title ?? '', /automation-3d164dfe/);
  assert.doesNotMatch(view?.label ?? '', /automation-/);
  assert.equal(
    formatComposerBoundBranch({
      delivery: { targetBranch: null, taskBranch },
    }, { locale: 'zh' })?.label,
    '隔离线',
  );
});

test('formatComposerBoundBranch shows a bound source before a workspace preview', () => {
  const view = formatComposerBoundBranch({
    delivery: { targetBranch: 'release/0.0.6', taskBranch: null },
    currentHead: 'develop',
  });
  assert.equal(view?.kind, 'bound-source');
  assert.equal(view?.label, 'release/0.0.6');
});

test('formatComposerBoundBranch previews configured baseBranch, then HEAD, and never invents main', () => {
  assert.equal(
    formatComposerBoundBranch({
      delivery: null,
      workspaceBaseBranch: 'develop',
      currentHead: 'feature/wip',
    })?.label,
    'develop',
  );
  assert.equal(
    formatComposerBoundBranch({
      delivery: null,
      currentHead: 'PeerAgent/0.0.6',
    })?.label,
    '0.0.6',
  );
  assert.equal(
    formatComposerBoundBranch({
      delivery: null,
      workspaceBaseBranch: '  ',
      currentHead: null,
    }),
    null,
  );
});

test('draft composer can pick a source branch until a session or task line is bound', () => {
  assert.equal(canSelectComposerSourceBranch({ isDraft: true, delivery: null }), true);
  assert.equal(canSelectComposerSourceBranch({ isDraft: false, delivery: null }), false);
  assert.equal(
    canSelectComposerSourceBranch({
      isDraft: true,
      delivery: { targetBranch: '0.0.6', taskBranch: null },
    }),
    false,
  );
  assert.equal(
    canSelectComposerSourceBranch({
      isDraft: true,
      delivery: { targetBranch: null, taskBranch: 'PeerAgent/fix-login' },
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
    ['main', '0.0.6'],
  );
  assert.deepEqual(
    buildComposerBranchOptions({
      branches: ['main'],
      selected: isolation,
    }),
    ['main', isolation],
  );
  assert.equal(formatComposerBranchOptionLabel('PeerAgent/0.0.6'), '0.0.6');
  assert.equal(
    formatComposerBoundBranch({
      delivery: null,
      currentHead: 'PeerAgent/0.0.6',
    })?.value,
    'PeerAgent/0.0.6',
  );
});
