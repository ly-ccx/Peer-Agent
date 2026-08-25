import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  clearProjectIndexCaches,
  readProjectIndex,
  setProjectIndexGitExecutor,
} from './project-index.mjs';

function makeGitExecutor(calls) {
  return (workspaceRoot, args) => {
    calls.push({ args: [...args], cwd: workspaceRoot });
    if (args[0] === 'branch') return 'main';
    if (args[0] === 'remote') return 'git@example.com:peer/agent.git';
    if (args[0] === 'status') {
      if (args.includes('--') && args.includes('apps/desktop')) {
        return '## main\n M apps/desktop/package.json';
      }
      return '## main...origin/main [ahead 1]\n M README.md\n?? scratch.txt';
    }
    return '';
  };
}

test('readProjectIndex reuses short TTL git cache across repeated calls', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-project-index-'));
  const calls = [];
  try {
    mkdirSync(path.join(root, '.git'));
    mkdirSync(path.join(root, 'apps', 'desktop'), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'peer-root' }));
    writeFileSync(path.join(root, 'apps', 'desktop', 'package.json'), JSON.stringify({ name: '@peer-agent/desktop' }));

    clearProjectIndexCaches();
    setProjectIndexGitExecutor(makeGitExecutor(calls));

    const first = readProjectIndex({ workspaceRoot: root });
    const firstCalls = calls.length;
    assert.ok(firstCalls > 0, 'first read should spawn git');
    assert.equal(first[0].projectId, 'workspace-root');
    assert.equal(first[0].git.branch, 'main');
    assert.equal(first.some((item) => item.relativePath === 'apps/desktop'), true);

    const second = readProjectIndex({ workspaceRoot: root });
    assert.equal(calls.length, firstCalls, 'second read within TTL must not spawn git again');
    assert.equal(second[0].git.branch, 'main');
    assert.notEqual(second[0], first[0], 'returned array items should be shallow-cloned');
  } finally {
    setProjectIndexGitExecutor(null);
    clearProjectIndexCaches();
    rmSync(root, { recursive: true, force: true });
  }
});

test('readProjectIndex avoids per-package branch/remote git spawns', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-project-index-once-'));
  const calls = [];
  try {
    mkdirSync(path.join(root, '.git'));
    mkdirSync(path.join(root, 'apps', 'desktop'), { recursive: true });
    mkdirSync(path.join(root, 'packages', 'protocol'), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'peer-root' }));
    writeFileSync(path.join(root, 'apps', 'desktop', 'package.json'), JSON.stringify({ name: '@peer-agent/desktop' }));
    writeFileSync(path.join(root, 'packages', 'protocol', 'package.json'), JSON.stringify({ name: '@peer-agent/protocol' }));

    clearProjectIndexCaches();
    setProjectIndexGitExecutor(makeGitExecutor(calls));
    const projects = readProjectIndex({ workspaceRoot: root });

    const branchCalls = calls.filter((call) => call.args[0] === 'branch');
    const remoteCalls = calls.filter((call) => call.args[0] === 'remote');
    const statusCalls = calls.filter((call) => call.args[0] === 'status');

    assert.equal(branchCalls.length, 1);
    assert.equal(remoteCalls.length, 1);
    // root + each package pathspec status
    assert.equal(statusCalls.length, 3);
    assert.equal(projects.length, 3);
  } finally {
    setProjectIndexGitExecutor(null);
    clearProjectIndexCaches();
    rmSync(root, { recursive: true, force: true });
  }
});

test('readProjectIndex can skip package git scans for workspace-info hot path', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-project-index-root-only-'));
  const calls = [];
  try {
    mkdirSync(path.join(root, '.git'));
    mkdirSync(path.join(root, 'apps', 'desktop'), { recursive: true });
    mkdirSync(path.join(root, 'packages', 'protocol'), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'peer-root' }));
    writeFileSync(path.join(root, 'apps', 'desktop', 'package.json'), JSON.stringify({ name: '@peer-agent/desktop' }));
    writeFileSync(path.join(root, 'packages', 'protocol', 'package.json'), JSON.stringify({ name: '@peer-agent/protocol' }));

    clearProjectIndexCaches();
    setProjectIndexGitExecutor(makeGitExecutor(calls));
    const projects = readProjectIndex({ workspaceRoot: root, includePackages: false });

    const statusCalls = calls.filter((call) => call.args[0] === 'status');
    assert.equal(projects.length, 1);
    assert.equal(projects[0].kind, 'workspace_root');
    assert.equal(statusCalls.length, 1);
    assert.equal(statusCalls[0].args.includes('--'), false);
  } finally {
    setProjectIndexGitExecutor(null);
    clearProjectIndexCaches();
    rmSync(root, { recursive: true, force: true });
  }
});
