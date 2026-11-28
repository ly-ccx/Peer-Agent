import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { WorkingPlanView } from '@peer-agent/protocol';

const plan: WorkingPlanView = {
  epoch: 0,
  revision: 1,
  updatedAt: '2026-11-27T00:00:00Z',
  completed: 1,
  total: 3,
  blocked: 1,
  invariants: ['Keep the workspace read-only'],
  steps: [
    { title: 'Read the brief', status: 'completed' },
    { title: 'Verify the output', status: 'in_progress', check: 'Compare results' },
    { title: 'Confirm deployment', status: 'blocked', note: 'Waiting for a maintainer' },
  ],
};

function component() {
  let expanded = false;
  const jsx = (type: unknown, props: unknown) => ({ type, props });
  const imports: Record<string, unknown> = {
    react: {
      useId: () => 'working-plan-details',
      useState: () => [expanded, (update: (open: boolean) => boolean) => { expanded = update(expanded); }],
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    '../../ui/icons': { PeerIcon: 'icon' },
    '../styles/task-working-plan-strip.css': {},
  };
  const exports = {} as { TaskWorkingPlanStrip: typeof import('./TaskWorkingPlanStrip').TaskWorkingPlanStrip };
  runInNewContext(ts.transpileModule(readFileSync(new URL('./TaskWorkingPlanStrip.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: (id: string) => imports[id] });
  return exports.TaskWorkingPlanStrip;
}

function nodes(tree: any, type: string): any[] {
  if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, type));
  if (!tree || typeof tree !== 'object') return [];
  return [...(tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
}

test('working plan strip starts collapsed and toggles the same accessible details region', () => {
  const strip = component();
  const render = () => strip({ workingPlan: plan, isZh: false });
  const collapsed = render();
  const [toggle] = nodes(collapsed, 'button');
  assert.equal(toggle.props.type, 'button');
  assert.equal(toggle.props['aria-label'], 'Expand working plan');
  assert.equal(toggle.props['aria-expanded'], false);
  assert.equal(JSON.stringify(collapsed).includes('Verify the output'), true);
  assert.equal(nodes(collapsed, 'ol').length, 0);
  assert.equal(nodes(collapsed, 'span')[0].props.children.join(''), '1/3');

  toggle.props.onClick();
  const expanded = render();
  const [expandedToggle] = nodes(expanded, 'button');
  assert.equal(expandedToggle.props['aria-expanded'], true);
  assert.equal(expandedToggle.props['aria-label'], 'Collapse working plan');
  assert.equal(nodes(expanded, 'div').find(node => node.props.id === toggle.props['aria-controls']).props.hidden, false);
  assert.equal(nodes(expanded, 'ol').length, 1);
  assert.equal(nodes(expanded, 'li').length, 4);
  assert.deepEqual(nodes(expanded, 'icon').map(node => node.props.name), ['chevronUp', 'check', 'loader', 'warning']);
  assert.match(JSON.stringify(expanded), /Compare results.*Waiting for a maintainer.*Keep the workspace read-only/);

  expandedToggle.props.onClick();
  assert.equal(nodes(render(), 'button')[0].props['aria-expanded'], false);
  assert.equal(nodes(render(), 'ol').length, 0);
});

test('working plan strip is absent for missing and empty plans', () => {
  const strip = component();
  assert.equal(strip({ isZh: false }), null);
  assert.equal(strip({ workingPlan: { ...plan, steps: [] }, isZh: false }), null);
});

test('working plan strip gives localized blocked, pending and finished summaries', () => {
  const strip = component();
  for (const [status, blocked, completed, expected] of [
    ['blocked', 1, 0, '1 项受阻'],
    ['pending', 0, 0, '1 项待处理'],
    ['completed', 0, 1, '全部步骤已收尾'],
  ] as const) {
    const tree = strip({ isZh: true, workingPlan: {
      ...plan, total: 1, blocked, completed, steps: [{ title: '计划步骤', status }],
    } });
    assert.equal(nodes(tree, 'span')[1].props.children, expected);
  }
});
