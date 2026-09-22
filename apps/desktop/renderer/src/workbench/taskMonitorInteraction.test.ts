import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import * as rail from './taskMonitorRail.ts';
import * as artifacts from '../app/pages/taskOverviewArtifacts.ts';
import * as capabilities from './taskMonitorCapabilities.ts';
import * as runtime from './backgroundRuntimeState.ts';

// Execute the real TSX with a minimal hook/element host. External subscriptions are
// fixtures; rendering, slicing, button handlers and projections are production code.
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('./views/TaskMonitorRailView.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
type Element = { type: unknown; props: Record<string, any> };
function harness(count: number) {
  let slots: any[] = [], cursor = 0;
  let tasks = Array.from({ length: count }, (_, i) => ({ taskId: `run-${i}`, command: `echo command-${i}`,
    cwd: '/work', status: 'running', conversationId: 'current', runInBackground: true }));
  const item = { taskId: 'current', conversationId: 'current', planSteps: [{ artifacts:
    Array.from({ length: count }, (_, i) => ({ kind: 'file', ref: `file-${i}`, label: `file-${i}`, openPath: `/work/file-${i}` })) }] };
  const messages = Array.from({ length: count }, (_, i) => ({ role: 'assistant', segments: [
    { type: 'tool-call', tool: `skill__used-${i}`, toolCallId: `call-${i}` },
  ] }));
  let navigation = 0;
  const jsx = (type: unknown, props: Record<string, any>): Element => ({ type, props });
  const modules: Record<string, any> = {
    react: { useMemo: (fn: () => unknown) => fn(), useEffect: () => {},
      useState: (initial: unknown) => { const index = cursor++; if (!(index in slots)) slots[index] = initial;
        return [slots[index], (value: any) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; } },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '../taskMonitorRail.ts': rail,
    '../../app/pages/taskOverviewArtifacts.ts': artifacts,
    '../taskMonitorCapabilities.ts': capabilities,
    '../backgroundRuntimeState.ts': runtime,
    '../../app/hooks/useTaskOverview': { useTaskOverview: () => [item] },
    '../GlobalBackgroundTasksButton': { useBackgroundRunsContext: () => ({ snapshot: tasks }) },
    '../BackgroundRunDetails': { BackgroundRunDetails: () => null },
    '../WorkbenchContext': { useWorkbenchOptional: () => ({ browserSession: { tabs: Array.from({ length: count }, (_, i) => ({ id: `web-${i}`, url: `https://example.com/${i}` })) },
      setActiveTab: () => navigation++, setOpen: () => navigation++ }) },
    '../../clientApi': { clientApi: {} },
    '../../app/components/Dropdown': { Dropdown: () => null },
  };
  const exports: Record<string, any> = {};
  vm.runInNewContext(compiled, { exports, require: (name: string) => modules[name] ?? require(name), URL });
  const render = () => { cursor = 0; return exports.TaskMonitorRailView({ messages, conversationId: 'current', isZh: true, active: true,
    workspacePath: null, currentHead: null, sourceBranch: null, workspaceIsGit: false }); };
  return { render, end: () => { tasks = tasks.map((task) => ({ ...task, status: 'success' })); }, navigation: () => navigation };
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
for (const [title, limit] of [['技能与 MCP', 6], ['后台任务', 2], ['产出', 2], ['网页查阅', 4]] as const) {
  for (const hidden of [false, true]) {
    test(`component expansion: ${title}/${hidden ? 'overflow' : 'within-limit'}/collapsed-expanded-collapsed`, () => {
      const count = hidden ? limit + 2 : limit;
      const host = harness(count);
      let tree = host.render();
      let current = section(tree, title);
      assert.ok(current, title);
      assert.equal(rows(current).length, limit);
      if (!hidden) { assert.equal(more(current), undefined); return; }
      const otherCounts = ['技能与 MCP', '后台任务', '产出', '网页查阅'].filter((name) => name !== title)
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
test('component shows command/status; ended runs and unused release skill disappear', () => {
  const host = harness(1);
  let tree = host.render();
  assert.equal(rows(section(tree, '后台任务'))[0].props.label, '运行中');
  assert.match(rows(section(tree, '后台任务'))[0].props.value, /echo command-0/);
  assert.ok(!rows(tree).some((row) => row.props.value.includes('release-process')));
  host.end(); tree = host.render();
  assert.equal(section(tree, '后台任务'), undefined);
});
