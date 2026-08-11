import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyLocalStreamingWorkspaceChange,
  deriveRunningWorkspacePaths,
  hasRunningWorkspaceOtherThan,
  hasRunningWorkspaces,
  isWorkspaceRunning,
  normalizeWorkspacePathKey,
} from './runningWorkspaceState.ts';

describe('runningWorkspaceState', () => {
  it('normalizes trailing slashes for stable workspace keys', () => {
    assert.equal(normalizeWorkspacePathKey('/tmp/ws/'), '/tmp/ws');
    assert.equal(normalizeWorkspacePathKey('/tmp/ws'), '/tmp/ws');
    assert.equal(normalizeWorkspacePathKey('/'), '/');
    assert.equal(normalizeWorkspacePathKey('  '), null);
    assert.equal(normalizeWorkspacePathKey(null), null);
  });

  it('derives running workspaces from origin projection (prefer origin over execution)', () => {
    const next = deriveRunningWorkspacePaths([
      { originWorkspacePath: '/knowledge/', workspacePath: '/code' },
      { workspacePath: '/tmp/other' },
      { originWorkspacePath: null, workspacePath: null },
    ]);
    assert.deepEqual([...next].sort(), ['/knowledge', '/tmp/other']);
  });

  it('clears all workspace dots when the last local stream stops', () => {
    const prev = new Set(['/ws-a', '/ws-b']);
    const next = applyLocalStreamingWorkspaceChange({
      prev,
      workspacePath: '/ws-a',
      isStreaming: false,
      remainingRunningConversationCount: 0,
    });
    assert.equal(next.size, 0);
  });

  it('adds the active workspace on local stream start', () => {
    const next = applyLocalStreamingWorkspaceChange({
      prev: new Set(),
      workspacePath: '/ws-a/',
      isStreaming: true,
      remainingRunningConversationCount: 1,
    });
    assert.deepEqual([...next], ['/ws-a']);
  });

  it('drops only the finishing workspace when other conversations still run', () => {
    const next = applyLocalStreamingWorkspaceChange({
      prev: new Set(['/ws-a', '/ws-b']),
      workspacePath: '/ws-a',
      isStreaming: false,
      remainingRunningConversationCount: 1,
    });
    assert.deepEqual([...next], ['/ws-b']);
  });

  it('treats trailing-slash variants as the same workspace for other-dot detection', () => {
    const running = new Set(['/ws-a']);
    assert.equal(hasRunningWorkspaceOtherThan(running, '/ws-a/'), false);
    assert.equal(hasRunningWorkspaceOtherThan(running, '/ws-b'), true);
    assert.equal(isWorkspaceRunning(running, '/ws-a/'), true);
    assert.equal(isWorkspaceRunning(running, '/ws-b'), false);
  });

  it('aggregates any running workspace for the global workbench indicator', () => {
    assert.equal(hasRunningWorkspaces(undefined), false);
    assert.equal(hasRunningWorkspaces(new Set()), false);
    assert.equal(hasRunningWorkspaces(new Set(['/ws-a'])), true);
    assert.equal(hasRunningWorkspaces(new Set(['/ws-a', '/ws-b'])), true);
  });

  it('idle streams project to no workspace dots', () => {
    const running = deriveRunningWorkspacePaths([]);
    assert.equal(running.size, 0);
    assert.equal(hasRunningWorkspaces(running), false);
    assert.equal(hasRunningWorkspaceOtherThan(running, '/ws-a'), false);
  });
});
