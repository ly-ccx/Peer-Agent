import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManagedShellTask, TaskOverviewItem } from '@peer-agent/protocol';
import {
  pathTailLabel,
  projectTaskMonitorArtifacts,
  projectTaskMonitorEnvironment,
  projectTaskMonitorRuns,
  selectConversationTaskOverviewItem,
  taskMonitorProgressHeadline,
} from './taskMonitorRail.ts';

function run(overrides: Partial<ManagedShellTask> & { taskId: string }): ManagedShellTask {
  return {
    command: 'pnpm dev',
    status: 'running',
    runInBackground: true,
    ...overrides,
  } as ManagedShellTask;
}

test('pathTailLabel 只取最后一段路径，空值返回空串', () => {
  assert.equal(pathTailLabel('/Users/liangyin/Documents/DEV/peer_agent'), 'peer_agent');
  assert.equal(pathTailLabel('C:\\Users\\liangyin\\proj'), 'proj');
  assert.equal(pathTailLabel('/trailing/slash/'), 'slash');
  assert.equal(pathTailLabel(''), '');
  assert.equal(pathTailLabel(null), '');
  assert.equal(pathTailLabel(undefined), '');
});

// 轴 1：会话作用域合并 —— 栏内只出现本会话的后台运行（与 ChatHeader 全局面不重叠）。
test('后台任务：只合并本会话的 run，其他会话与前台命令都不进', () => {
  const tasks = [
    run({ taskId: 'a', conversationId: 'conv-1', cwd: '/Users/liangyin/proj-a' }),
    run({ taskId: 'b', conversationId: 'conv-2', cwd: '/Users/liangyin/proj-b' }),
    run({ taskId: 'c', conversationId: 'conv-1', runInBackground: false }),
    run({ taskId: 'd', conversationId: null, cwd: '/Users/liangyin/proj-d' }),
  ];
  const scoped = projectTaskMonitorRuns(tasks, 'conv-1', true);
  assert.deepEqual(scoped.map((row) => row.taskId), ['a']);
  assert.equal(scoped[0]?.cwdLabel, 'proj-a');
});

test('后台任务：无会话时不投影（避免跨会话泄漏）', () => {
  const tasks = [run({ taskId: 'a', conversationId: 'conv-1' })];
  assert.deepEqual(projectTaskMonitorRuns(tasks, null, true), []);
  assert.deepEqual(projectTaskMonitorRuns(null, 'conv-1', true), []);
});

test('后台任务：命令行优先用 description，状态文案随语言，失败态可判', () => {
  const tasks = [
    run({ taskId: 'a', conversationId: 'conv-1', description: '启动开发服务器', status: 'running' }),
    run({ taskId: 'b', conversationId: 'conv-1', command: 'pnpm test', status: 'failed' }),
    run({ taskId: 'c', conversationId: 'conv-1', status: 'success', timedOut: true }),
  ];
  const zh = projectTaskMonitorRuns(tasks, 'conv-1', true);
  assert.equal(zh.find((row) => row.taskId === 'a')?.command, '启动开发服务器');
  assert.equal(zh.find((row) => row.taskId === 'a')?.active, true);
  assert.equal(zh.find((row) => row.taskId === 'a')?.failed, false);
  assert.equal(zh.find((row) => row.taskId === 'a')?.statusLabel, '运行中');
  assert.equal(zh.find((row) => row.taskId === 'b')?.command, 'pnpm test');
  assert.equal(zh.find((row) => row.taskId === 'b')?.statusLabel, '失败');
  assert.equal(zh.find((row) => row.taskId === 'b')?.failed, true);
  assert.equal(zh.find((row) => row.taskId === 'c')?.failed, true, 'timedOut 也算失败（监控语义：异常优先）');

  const en = projectTaskMonitorRuns(tasks, 'conv-1', false);
  assert.equal(en.find((row) => row.taskId === 'a')?.statusLabel, 'Running');
});

// 轴 2：环境信息属于当前会话监控栏；当前工作区 HEAD 与任务源头必须拆行。
test('环境信息：Git 工作区投影当前 HEAD、任务源头、工作区和本地运行位置', () => {
  assert.deepEqual(projectTaskMonitorEnvironment({
    workspacePath: '/workspace/peer_agent',
    currentHead: 'dev/0.0.14',
    sourceBranch: '0.0.15',
    isGit: true,
    isZh: true,
  }), [
    { id: 'current-head', icon: 'branch', label: '当前工作区', value: 'dev/0.0.14' },
    { id: 'source', icon: 'branch', label: '任务源头', value: '0.0.15' },
    { id: 'workspace', icon: 'folder', label: '工作区', value: 'peer_agent', detail: '/workspace/peer_agent' },
    { id: 'location', icon: 'device', label: '运行位置', value: '本地' },
  ]);
});

test('环境信息：非 Git 或空工作区不伪造分支与位置', () => {
  assert.deepEqual(projectTaskMonitorEnvironment({
    workspacePath: '/workspace/plain',
    currentHead: 'ignored',
    sourceBranch: 'also-ignored',
    isGit: false,
    isZh: false,
  }), [
    { id: 'workspace', icon: 'folder', label: 'Workspace', value: 'plain', detail: '/workspace/plain' },
    { id: 'location', icon: 'device', label: 'Runs on', value: 'Local' },
  ]);
  assert.deepEqual(projectTaskMonitorEnvironment({
    workspacePath: null,
    currentHead: null,
    sourceBranch: null,
    isGit: null,
    isZh: true,
  }), []);
  const rows = projectTaskMonitorEnvironment({
    workspacePath: '/workspace/peer',
    currentHead: 'dev/0.0.14',
    sourceBranch: '0.0.15',
    isGit: true,
    isZh: true,
  });
  assert.equal(rows.find((row) => row.id === 'current-head')?.value, 'dev/0.0.14');
  assert.equal(rows.find((row) => row.id === 'source')?.value, '0.0.15');
  assert.equal(rows.some((row) => row.id === 'branch'), false);
});

// 轴 3：产出治理过滤 —— 治理 ref 与通用文案标签永不进入展示。
test('产出：复用过滤规则，治理 ref 不出现在投影结果里', () => {
  const item = {
    taskId: 'conv-1',
    artifacts: [],
    planSteps: [{
      artifacts: [
        { kind: 'code', ref: 'tool-result://call_1', label: '代码变更', actionLabel: '查看变更', openPath: '/p/a.ts' },
        { kind: 'file', ref: 'local-shell-artifact://s/1', label: '新建文件', openPath: '/p/b.ts' },
        { kind: 'file', ref: 'goal-plan://plan-1', label: '结果文件', openPath: '/p/c.ts' },
        { kind: 'file', ref: 'file:///p/real.ts', label: 'real.ts', openPath: '/p/real.ts' },
      ],
    }],
  } as unknown as TaskOverviewItem;

  const projection = projectTaskMonitorArtifacts(item);
  assert.equal(projection.total, 1);
  const refs = projection.groups.flatMap((group) => group.artifacts.map((artifact) => artifact.ref));
  assert.deepEqual(refs, ['file:///p/real.ts']);
  assert.equal(projection.groups[0]?.kind, 'file');
});

test('产出：无 item 或投影抛错时降级为空投影，不抛异常', () => {
  assert.deepEqual(projectTaskMonitorArtifacts(null), {
    groups: [], summary: '', total: 0, visibleTotal: 0, hiddenTotal: 0,
  });
  const broken = { get planSteps(): never { throw new Error('boom'); } } as unknown as TaskOverviewItem;
  assert.equal(projectTaskMonitorArtifacts(broken).total, 0);
});

// 轴 4：本会话那一条的选取 —— taskId 并不总等于 conversationId。
test('进度文案：有计划名和当前步骤时与底部浮条一样具体', () => {
  const headline = taskMonitorProgressHeadline({
    title: '启动应用并截图验收',
    currentGoalTitle: '启动应用并截图验收',
    statusLabel: 'Peer 正在推进',
  });
  assert.equal(headline, '启动应用并截图验收');
  assert.equal(
    taskMonitorProgressHeadline({
      title: '启动应用并截图验收',
      currentGoalTitle: '核对窗口标题',
      statusLabel: 'Peer 正在推进',
    }),
    '启动应用并截图验收 · 核对窗口标题',
  );
});

test('进度文案：没有计划名时不编造，回落到状态标签', () => {
  assert.equal(
    taskMonitorProgressHeadline({
      title: '未命名任务',
      currentGoalTitle: '  ',
      statusLabel: 'Peer 正在推进',
    }),
    'Peer 正在推进',
  );
  assert.equal(
    taskMonitorProgressHeadline({
      title: '',
      currentGoalTitle: '核对窗口标题',
      statusLabel: 'Peer 正在推进',
    }),
    '核对窗口标题',
  );
});

test('选条：taskId 为 planId 的 goal_plan 投影靠 conversationId 命中', () => {
  const planItem = {
    taskId: 'plan-abc',
    conversationId: 'conv-1',
    artifacts: [],
  } as unknown as TaskOverviewItem;
  assert.equal(selectConversationTaskOverviewItem([planItem], 'conv-1'), planItem);
  // 其他会话的 plan 投影不得被选中。
  assert.equal(selectConversationTaskOverviewItem([planItem], 'conv-2'), null);
});

test('选条：纯会话投影（taskId === conversationId）仍可命中', () => {
  const conversationItem = { taskId: 'conv-1', artifacts: [] } as unknown as TaskOverviewItem;
  assert.equal(selectConversationTaskOverviewItem([conversationItem], 'conv-1'), conversationItem);
});

test('选条：多条命中时优先有产物的一条，避免产出区空转', () => {
  const bare = { taskId: 'plan-bare', conversationId: 'conv-1', planSteps: [] } as unknown as TaskOverviewItem;
  const withArtifacts = {
    taskId: 'plan-rich',
    conversationId: 'conv-1',
    planSteps: [{
      taskId: 'step-1',
      title: '步骤',
      status: 'completed',
      artifacts: [{ kind: 'file', ref: 'file:///a.ts', label: 'a.ts', actionLabel: '打开文件', openPath: '/a.ts' }],
    }],
  } as unknown as TaskOverviewItem;
  assert.equal(selectConversationTaskOverviewItem([bare, withArtifacts], 'conv-1'), withArtifacts);
  // 顺序反转也应稳定选到同一条。
  assert.equal(selectConversationTaskOverviewItem([withArtifacts, bare], 'conv-1'), withArtifacts);
});

test('选条：无会话、空列表、无匹配都返回 null', () => {
  const item = { taskId: 'plan-abc', conversationId: 'conv-1' } as unknown as TaskOverviewItem;
  assert.equal(selectConversationTaskOverviewItem([item], null), null);
  assert.equal(selectConversationTaskOverviewItem([], 'conv-1'), null);
  assert.equal(selectConversationTaskOverviewItem(null, 'conv-1'), null);
  assert.equal(selectConversationTaskOverviewItem(undefined, 'conv-1'), null);
});
