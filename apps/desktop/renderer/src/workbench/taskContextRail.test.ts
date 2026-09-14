import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManagedShellTask, TaskOverviewItem } from '@peer-agent/protocol';
import {
  pathTailLabel,
  projectTaskContextArtifacts,
  projectTaskContextEnvironment,
  projectTaskContextRuns,
  selectConversationTaskOverviewItem,
} from './taskContextRail.ts';

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

// 轴 1：分支值三态必须可区分 —— 有分支 / 非仓库 / 未读取，互不冒充。
test('环境信息：git 仓库展示分支值，非仓库不展示分支名，未读取不编造', () => {
  const withBranch = projectTaskContextEnvironment({
    workspacePath: '/Users/liangyin/proj',
    workspaceIsGit: true,
    currentBranch: 'PeerAgent/nexus-upload-media-pre',
  }, true);
  assert.equal(withBranch.find((row) => row.id === 'branch')?.value,
    'PeerAgent/nexus-upload-media-pre');
  assert.equal(withBranch.find((row) => row.id === 'branch')?.openTarget, 'branch');

  const notRepo = projectTaskContextEnvironment({
    workspacePath: '/Users/liangyin/plain',
    workspaceIsGit: false,
    currentBranch: null,
  }, true);
  const notRepoBranch = notRepo.find((row) => row.id === 'branch');
  assert.equal(notRepoBranch?.value, '非 git 仓库');
  assert.equal(notRepoBranch?.openTarget, null);

  // 读取中（workspaceIsGit=null）：不得出现分支行，避免把「未知」画成「无」。
  const loading = projectTaskContextEnvironment({
    workspacePath: '/Users/liangyin/proj',
    workspaceIsGit: null,
    currentBranch: null,
  }, true);
  assert.equal(loading.some((row) => row.id === 'branch'), false);
});

test('环境信息：无工作区时整区为空（不写占位文案）', () => {
  assert.deepEqual(projectTaskContextEnvironment({
    workspacePath: null,
    workspaceIsGit: null,
    currentBranch: null,
  }, true), []);
});

test('环境信息：工作区行带完整路径作为 detail，值为末段', () => {
  const rows = projectTaskContextEnvironment({
    workspacePath: '/Users/liangyin/Documents/DEV/github/peer_agent',
    workspaceIsGit: true,
    currentBranch: 'main',
  }, true);
  const workspace = rows.find((row) => row.id === 'workspace');
  assert.equal(workspace?.value, 'peer_agent');
  assert.equal(workspace?.detail, '/Users/liangyin/Documents/DEV/github/peer_agent');
  assert.equal(rows.find((row) => row.id === 'location')?.value, '本地');
});

// 轴 2：会话作用域过滤 —— 栏内只出现本会话的后台运行（与 ChatHeader 全局面不重叠）。
test('后台进程：只投影本会话的 run，其他会话与前台命令都不进', () => {
  const tasks = [
    run({ taskId: 'a', conversationId: 'conv-1', cwd: '/Users/liangyin/proj-a' }),
    run({ taskId: 'b', conversationId: 'conv-2', cwd: '/Users/liangyin/proj-b' }),
    run({ taskId: 'c', conversationId: 'conv-1', runInBackground: false }),
    run({ taskId: 'd', conversationId: null, cwd: '/Users/liangyin/proj-d' }),
  ];
  const scoped = projectTaskContextRuns(tasks, 'conv-1', true);
  assert.deepEqual(scoped.map((row) => row.taskId), ['a']);
  assert.equal(scoped[0]?.cwdLabel, 'proj-a');
});

test('后台进程：无会话时不投影（避免跨会话泄漏）', () => {
  const tasks = [run({ taskId: 'a', conversationId: 'conv-1' })];
  assert.deepEqual(projectTaskContextRuns(tasks, null, true), []);
  assert.deepEqual(projectTaskContextRuns(null, 'conv-1', true), []);
});

test('后台进程：命令行优先用 description，状态文案随语言并且活跃态可判', () => {
  const tasks = [
    run({ taskId: 'a', conversationId: 'conv-1', description: '启动开发服务器', status: 'running' }),
    run({ taskId: 'b', conversationId: 'conv-1', command: 'pnpm test', status: 'failed' }),
  ];
  const zh = projectTaskContextRuns(tasks, 'conv-1', true);
  assert.equal(zh.find((row) => row.taskId === 'a')?.command, '启动开发服务器');
  assert.equal(zh.find((row) => row.taskId === 'a')?.active, true);
  assert.equal(zh.find((row) => row.taskId === 'a')?.statusLabel, '运行中');
  assert.equal(zh.find((row) => row.taskId === 'b')?.command, 'pnpm test');
  assert.equal(zh.find((row) => row.taskId === 'b')?.statusLabel, '失败');
  assert.equal(zh.find((row) => row.taskId === 'b')?.active, false);

  const en = projectTaskContextRuns(tasks, 'conv-1', false);
  assert.equal(en.find((row) => row.taskId === 'a')?.statusLabel, 'Running');
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

  const projection = projectTaskContextArtifacts(item);
  assert.equal(projection.total, 1);
  const refs = projection.groups.flatMap((group) => group.artifacts.map((artifact) => artifact.ref));
  assert.deepEqual(refs, ['file:///p/real.ts']);
  assert.equal(projection.groups[0]?.kind, 'file');
});

test('产出：无 item 或投影抛错时降级为空投影，不抛异常', () => {
  assert.deepEqual(projectTaskContextArtifacts(null), {
    groups: [], summary: '', total: 0, visibleTotal: 0, hiddenTotal: 0,
  });
  const broken = { get planSteps(): never { throw new Error('boom'); } } as unknown as TaskOverviewItem;
  assert.equal(projectTaskContextArtifacts(broken).total, 0);
});

// 轴 4：本会话那一条的选取 —— taskId 并不总等于 conversationId。
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

test('选条：planSteps 存在但全无产物时退化为第一条匹配', () => {
  const first = {
    taskId: 'plan-a',
    conversationId: 'conv-1',
    planSteps: [{ taskId: 's1', title: '步骤', status: 'completed' }],
  } as unknown as TaskOverviewItem;
  const second = {
    taskId: 'plan-b',
    conversationId: 'conv-1',
    planSteps: [{ taskId: 's2', title: '步骤', status: 'completed', artifacts: [] }],
  } as unknown as TaskOverviewItem;
  assert.equal(selectConversationTaskOverviewItem([first, second], 'conv-1'), first);
});

test('选条：无会话、空列表、无匹配都返回 null', () => {
  const item = { taskId: 'plan-abc', conversationId: 'conv-1' } as unknown as TaskOverviewItem;
  assert.equal(selectConversationTaskOverviewItem([item], null), null);
  assert.equal(selectConversationTaskOverviewItem([], 'conv-1'), null);
  assert.equal(selectConversationTaskOverviewItem(null, 'conv-1'), null);
  assert.equal(selectConversationTaskOverviewItem(undefined, 'conv-1'), null);
});
