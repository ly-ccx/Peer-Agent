import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FAMILIARIZE_READ_CAPABILITIES,
  RESPONSIBILITY_QUESTION,
  buildFamiliarizePlan,
  buildReadmeTask,
  familiarizeAllowsCapability,
  isBlankProject,
} from './familiarize-template.mjs';

test('空目录和只有点文件时不问任务，直接问职责', () => {
  assert.equal(isBlankProject([]), true);
  assert.equal(isBlankProject(['.gitkeep', '.gitignore']), true);
  assert.equal(isBlankProject(['src']), false);
  const blank = buildFamiliarizePlan({ displayName: '笔记', entries: ['.gitkeep'] });
  assert.equal(blank.kind, 'blank');
  assert.equal(blank.task, null);
  assert.equal(blank.question, RESPONSIBILITY_QUESTION);
  assert.equal(blank.question, '这个机器人主要负责什么');
});

test('非空项目的熟悉任务只有读取能力，git 信息来自调用方', () => {
  const plan = buildFamiliarizePlan({
    displayName: '演示',
    entries: ['src', 'AGENTS.md'],
    git: { branch: 'main', commit: 'abc123' },
  });
  assert.equal(plan.kind, 'research');
  assert.equal(plan.task.readOnly, true);
  assert.equal(plan.task.kind, 'research');
  assert.deepEqual(plan.task.allowedCapabilities, [...FAMILIARIZE_READ_CAPABILITIES]);
  for (const capabilityId of plan.task.allowedCapabilities) {
    assert.equal(familiarizeAllowsCapability(capabilityId), true);
    assert.equal(/write|edit|shell/.test(capabilityId), false);
  }
  assert.equal(familiarizeAllowsCapability('local.file.write'), false);
  assert.equal(familiarizeAllowsCapability('local.shell.exec'), false);
  assert.match(plan.task.brief, /当前分支：main/);
  assert.match(plan.task.brief, /当前提交：abc123/);
  const missing = buildFamiliarizePlan({ displayName: '演示', entries: ['README.md'] });
  assert.match(missing.task.brief, /没有可读的 git 分支/);
  assert.equal(missing.task.brief.includes('main'), false);
});

test('同意之后的 README 任务写明职责，熟悉阶段本身不包含它', () => {
  const task = buildReadmeTask({ displayName: '笔记', responsibility: '整理资料' });
  assert.equal(task.kind, 'docs');
  assert.equal(task.readOnly, false);
  assert.match(task.brief, /整理资料/);
  assert.equal(task.allowedCapabilities.includes('local.file.write'), true);
});
