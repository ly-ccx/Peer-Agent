import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import * as rail from './taskMonitorRail.ts';
import * as artifacts from '../app/pages/taskOverviewArtifacts.ts';
import * as sources from './taskMonitorSources.ts';
import * as runtime from './backgroundRuntimeState.ts';

// Execute the real TSX with a minimal hook/element host. External subscriptions are
// fixtures; rendering, slicing, button handlers and projections are production code.
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('./views/TaskMonitorRailView.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
type Element = { type: unknown; props: Record<string, any> };
function harness(count: number, browserScope = 'other', props: Record<string, any> = {}) {
  let slots: any[] = [], cursor = 0;
  let tasks = Array.from({ length: count }, (_, i) => ({ taskId: `run-${i}`, command: `echo command-${i}`,
    cwd: '/work', status: 'running', conversationId: 'current', runInBackground: true }));
  const item = { taskId: 'current', conversationId: 'current', planSteps: [{ artifacts:
    Array.from({ length: count }, (_, i) => ({ kind: 'file', ref: `file-${i}`, label: `file-${i}`, openPath: `/work/file-${i}` })) }] };
  const messages = Array.from({ length: count }, (_, i) => ({ id: `message-${i}`, role: 'assistant', segments: [
    { type: 'tool-call', tool: `skill__used-${i}`, toolCallId: `call-${i}` },
  ] }));
  let navigation = 0;
  let activeTabId = '';
  const openedFiles: string[] = [];
  const jsx = (type: unknown, props: Record<string, any>): Element => ({ type, props });
  const modules: Record<string, any> = {
    react: { useMemo: (fn: () => unknown) => fn(), useEffect: () => {},
      useState: (initial: unknown) => { const index = cursor++; if (!(index in slots)) slots[index] = initial;
        return [slots[index], (value: any) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; } },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '../taskMonitorRail.ts': rail,
    '../../app/pages/taskOverviewArtifacts.ts': artifacts,
    '../taskMonitorSources.ts': sources,
    '../backgroundRuntimeState.ts': runtime,
    '../../app/hooks/useTaskOverview': { useTaskOverview: () => [item] },
    '../GlobalBackgroundTasksButton': { useBackgroundRunsContext: () => ({ snapshot: tasks }) },
    '../BackgroundRunDetails': { BackgroundRunDetails: () => null },
    '../WorkbenchContext': { useWorkbenchOptional: () => ({ conversationId: browserScope,
      browserSession: { tabs: Array.from({ length: count }, (_, i) => ({ id: `web-${i}`, url: `https://example.com/${i}` })) },
      setBrowserSession: (update: any) => { activeTabId = update({ tabs: [], activeTabId }).activeTabId; },
      openFile: (path: string) => openedFiles.push(path),
      setActiveTab: () => navigation++, setOpen: () => navigation++ }) },
    '../../clientApi': { clientApi: {} },
    '../../app/components/Dropdown': { Dropdown: () => null },
  };
  const exports: Record<string, any> = {};
  vm.runInNewContext(compiled, { exports, require: (name: string) => modules[name] ?? require(name), URL });
  const render = () => { cursor = 0; return exports.TaskMonitorRailView({ messages, conversationId: 'current', isZh: true, active: true,
    workspacePath: null, currentHead: null, sourceBranch: null, workspaceIsGit: false, ...props }); };
  return { render, end: () => { tasks = tasks.map((task) => ({ ...task, status: 'success' })); }, navigation: () => navigation, activeTab: () => activeTabId, openedFiles };
}
function nodes(root: any): Element[] {
  if (!root || typeof root !== 'object') return [];
  if (Array.isArray(root)) return root.flatMap(nodes);
  return [root, ...nodes(root.props?.children)];
}
function section(root: Element, title: string) {
  return nodes(root).find((node) => node.props?.title === title)!;
}
function rows(root: Element) { return nodes(root).filter((node) => typeof node.props?.value === 'string'); }
function more(root: Element) { return nodes(root).find((node) => node.props?.className === 'task-monitor-more'); }
for (const [title, limit] of [['来源与工具', 4], ['后台任务', 2], ['产出', 2]] as const) {
  for (const hidden of [false, true]) {
    test(`component expansion: ${title}/${hidden ? 'overflow' : 'within-limit'}/collapsed-expanded-collapsed`, () => {
      const count = hidden ? limit + 2 : limit;
      const host = harness(count);
      let tree = host.render();
      let current = section(tree, title);
      assert.ok(current, title);
      assert.equal(rows(current).length, limit);
      if (!hidden) { assert.equal(more(current), undefined); return; }
      const otherCounts = ['来源与工具', '后台任务', '产出'].filter((name) => name !== title)
        .map((name) => [name, rows(section(tree, name)).length] as const);
      assert.equal(more(current)!.props.children, '查看更多 (2)');
      more(current)!.props.onClick();
      tree = host.render(); current = section(tree, title);
      assert.equal(rows(current).length, count);
      assert.equal(more(current)!.props['aria-expanded'], true);
      for (const [name, before] of otherCounts) assert.equal(rows(section(tree, name)).length, before);
      more(current)!.props.onClick();
      current = section(host.render(), title);
      assert.equal(rows(current).length, limit);
      assert.equal(more(current)!.props['aria-expanded'], false);
      assert.equal(host.navigation(), 0);
    });
  }
}
for (const currentIsolation of [null, false, true]) {
  test(`current isolation ${currentIsolation} is independent of next-task preference`, () => {
    const host = harness(0, 'other', { workspaceIsGit: true, currentIsolation, isolationValue: 'next-worktree' });
    let tree = host.render();
    nodes(tree).find((node) => node.props?.className === 'task-monitor-environment-summary')!.props.onClick();
    tree = host.render();
    const row = rows(section(tree, '环境')).find((node) => node.props.label === '当前任务隔离');
    assert.equal(row?.props.value, currentIsolation === null ? '尚未确认' : currentIsolation ? 'Worktree' : '当前目录');
  });
}

for (const isZh of [true, false]) {
  for (const workspaceIsGit of [true, false]) {
    for (const enabled of [true, false]) {
      test(`environment ${isZh ? 'zh' : 'en'}/${workspaceIsGit ? 'git' : 'non-git'}/${enabled ? 'idle' : 'running'}`, () => {
        const selected: string[] = [];
        let created = 0;
        const host = harness(1, 'other', { isZh, workspaceIsGit, workspacePath: '/work/项目',
          currentHead: 'dev/current', sourceBranch: 'main', canSelectSource: enabled, canChangeIsolation: enabled,
          isolationValue: 'isolated', isolationOptions: [{ value: 'isolated', label: 'Worktree' }],
          sourceOptions: [{ value: 'main', label: 'main' }], onSelectEnv: (value: string) => selected.push(value),
          onCreateBranch: () => created++ });
        let tree = host.render();
        const titles = nodes(tree).filter((node) => typeof node.props?.title === 'string' && node.props?.children).map((node) => node.props.title);
        assert.deepEqual(titles, isZh ? ['产出', '来源与工具', '后台任务', '环境'] : ['Outputs', 'Sources & tools', 'Background tasks', 'Environment']);
        assert.ok(!nodes(tree).some((node) => node.props?.className === 'task-monitor-env-dropdown'));
        nodes(tree).find((node) => node.props?.className === 'task-monitor-environment-summary')!.props.onClick();
        tree = host.render();
        const settings = nodes(tree).find((node) => node.props?.children === (isZh ? '环境设置' : 'Environment settings'));
        assert.equal(!!settings, workspaceIsGit);
        if (!settings) return;
        settings.props.onClick();
        tree = host.render();
        const controls = nodes(tree).filter((node) => node.props?.className === 'task-monitor-env-dropdown');
        assert.equal(controls.length, 2);
        for (const control of controls) assert.equal(control.props.disabled, !enabled);
        if (enabled) {
          controls[0].props.onChange('main'); controls[1].props.onChange('isolated');
          controls[0].props.footerAction.onSelect();
          assert.deepEqual(selected, ['main', 'isolated']); assert.equal(created, 1);
        } else assert.equal(controls[0].props.footerAction, undefined);
        assert.equal(host.navigation(), 0);
      });
    }
  }
}

test('source clicks target the precise browser tab and artifact; tool details stay in card', () => {
  const host = harness(1, 'current');
  let tree = host.render();
  const sourceRows = rows(section(tree, '来源与工具'));
  assert.equal(sourceRows.length, 2);
  sourceRows[1].props.onClick();
  assert.equal(host.activeTab(), 'web-0');
  rows(section(tree, '产出'))[0].props.onClick();
  assert.deepEqual(host.openedFiles, ['/work/file-0']);
  const before = host.navigation();
  sourceRows[0].props.onClick();
  tree = host.render();
  assert.ok(nodes(tree).some((node) => node.props?.className === 'task-monitor-source-detail'));
  assert.equal(host.navigation(), before);
  const other = harness(1, 'other');
  assert.equal(rows(section(other.render(), '来源与工具')).length, 1);
});

test('component shows command/status; ended runs and unused release skill disappear', () => {
  const host = harness(1);
  let tree = host.render();
  assert.equal(rows(section(tree, '后台任务'))[0].props.label, '运行中');
  assert.match(rows(section(tree, '后台任务'))[0].props.value, /echo command-0/);
  assert.ok(!rows(tree).some((row) => row.props.value.includes('release-process')));
  host.end(); tree = host.render();
  assert.equal(section(tree, '后台任务'), undefined);
});
