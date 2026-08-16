import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskOverviewItem } from '@peer-agent/protocol';
import {
  MAX_VISIBLE_ARTIFACTS_PER_KIND,
  projectTaskOverviewArtifacts,
} from './taskOverviewArtifacts.ts';

function itemWithArtifacts(artifacts: unknown[]): TaskOverviewItem {
  return {
    taskId: 'task-1',
    kind: 'goal_plan',
    title: '验收任务',
    status: 'result_ready',
    actionRight: 'user',
    planSteps: [
      { taskId: 'one', title: '内部任务一', status: 'completed', artifacts },
      { taskId: 'two', title: '内部任务二', status: 'completed', artifacts },
    ],
  } as unknown as TaskOverviewItem;
}

test('卡片级聚合只保留可打开的 code/file/image，并过滤旧执行证据', () => {
  const item = itemWithArtifacts([
    {
      ref: 'file:///work/src/app.ts',
      kind: 'code',
      label: 'src/app.ts',
      actionLabel: '查看变更',
      openPath: '/work/src/app.ts',
      preview: {
        kind: 'code',
        additions: 1,
        deletions: 1,
        diffLines: ['--- a/app.ts', '+++ b/app.ts', '-old', '+new'],
      },
    },
    {
      ref: 'file:///work/report.md',
      kind: 'file',
      label: 'report.md',
      actionLabel: '打开文件',
      openPath: '/work/report.md',
    },
    {
      ref: 'local-browser-artifact://shot/screenshot',
      kind: 'image',
      label: '界面截图',
      actionLabel: '预览截图',
      openPath: '/tmp/shot/screenshot.png',
    },
    { ref: 'tool-result://call-1', kind: 'evidence', label: '执行证据' },
    { ref: 'local-shell-artifact://shell-1/stdout', kind: 'result', label: '命令执行结果', openPath: '/tmp/stdout.txt' },
    { ref: 'file:///work/missing.txt', kind: 'file', label: 'missing.txt' },
  ]);

  const projection = projectTaskOverviewArtifacts(item);
  assert.equal(projection.total, 3);
  assert.equal(projection.summary, '1 处代码变更 · 1 个文件 · 1 张截图');
  assert.deepEqual(projection.groups.map((group) => group.kind), ['code', 'file', 'image']);
  assert.equal(projection.groups.every((group) => group.artifacts.length === 1), true);
  assert.deepEqual(projection.groups[0]?.artifacts[0]?.preview, {
    kind: 'code',
    additions: 1,
    deletions: 1,
    diffLines: ['--- a/app.ts', '+++ b/app.ts', '-old', '+new'],
  });
  assert.doesNotMatch(JSON.stringify(projection), /执行证据|命令执行结果|tool-result|local-shell-artifact/);
});

test('跨任务去重并限制每类可见产物数量', () => {
  const files = Array.from({ length: MAX_VISIBLE_ARTIFACTS_PER_KIND + 3 }, (_, index) => ({
    ref: `file:///work/file-${index}.md`,
    kind: 'file',
    label: `file-${index}.md`,
    actionLabel: '打开文件',
    openPath: `/work/file-${index}.md`,
  }));
  const projection = projectTaskOverviewArtifacts(itemWithArtifacts(files));
  assert.equal(projection.total, files.length);
  assert.equal(projection.groups[0]?.artifacts.length, MAX_VISIBLE_ARTIFACTS_PER_KIND);
  assert.equal(projection.visibleTotal, MAX_VISIBLE_ARTIFACTS_PER_KIND);
  assert.equal(projection.hiddenTotal, 3);
  assert.deepEqual(projection.groups[0]?.artifacts.map(({ label }) => label), ['file-0.md', 'file-1.md']);
  assert.equal(projection.summary, `${files.length} 个文件`);
});

test('没有真实可操作产物时返回空投影', () => {
  const projection = projectTaskOverviewArtifacts(itemWithArtifacts([
    { ref: 'goal-plan://plan-1', kind: 'evidence', label: '执行证据' },
    { ref: 'local-shell-artifact://shell-1/stdout', kind: 'result', label: '命令执行结果', openPath: '/tmp/stdout.txt' },
  ]));
  assert.equal(projection.total, 0);
  assert.equal(projection.summary, '');
  assert.deepEqual(projection.groups, []);
});
