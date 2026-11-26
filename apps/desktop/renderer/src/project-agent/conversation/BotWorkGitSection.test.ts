import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';
import { createI18n } from '@peer-agent/i18n';
import type { WorkPanelGitStatus } from '../gitStatusTypes';
import * as workPanelState from '../state/botWorkPanelState.ts';

function load<T>(file: string, imports: Record<string, unknown> = {}, globals: Record<string, unknown> = {}): T {
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { ...globals, exports, require(id: string) {
    if (id === 'react/jsx-runtime') return jsxRuntime;
    assert.ok(Object.hasOwn(imports, id), `Unexpected ${id} in ${file}`);
    return imports[id];
  } });
  return exports as T;
}

type Status = Extract<WorkPanelGitStatus, { kind: 'status' }>;
const i18n = createI18n('zh-CN');
const status: Status = { kind: 'status', isGitRepo: true, repoRoot: '/repo', branch: 'feature/docs',
  headShort: '1234abcd', unborn: false, detached: false, clean: false, filtersDisabled: false, changedCount: 4,
  stagedCount: 1, unstagedCount: 2, untrackedCount: 1, truncated: true, totalEntries: 4, observedAt: '2026-01-01T00:00:00Z',
  entries: [{ path: 'nested/new.txt', index: '?', worktree: '?', conflicted: false, openPath: 'new.txt' },
    { path: 'nested/gone.txt', index: '.', worktree: 'D', conflicted: false }] };
const icons = { PeerIcon: ({ name }: { name: string }) => jsxRuntime.jsx('svg', { 'data-icon': name }) };
const view = load<typeof import('./BotWorkGitSection')>('./BotWorkGitSection.tsx', { '../../ui/icons': icons });
const noop = () => {};

type Node = ReactElement<{ children?: ReactNode; [key: string]: unknown }>;
function elements(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (node === null || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as Node;
  return [element, ...elements(element.props.children)];
}

test('branch, detached and unborn summaries and porcelain labels are localized', () => {
  assert.equal(view.gitBranchLabel(status, i18n), 'feature/docs');
  assert.equal(view.gitBranchLabel({ ...status, detached: true, branch: null }, i18n), '分离 HEAD · 1234abcd');
  assert.equal(view.gitBranchLabel({ ...status, unborn: true }, i18n), 'feature/docs（尚无提交）');
  assert.equal(view.gitChangeLabel(status, i18n), '4 处改动');
  assert.equal(view.gitChangeLabel({ ...status, changedCount: 0, clean: true }, i18n), '干净');
  assert.equal(view.gitChangeLabel({ ...status, changedCount: 0, clean: null }, i18n), '状态未确认');
  assert.equal(view.gitEntryLabel(status.entries[0]!, i18n).label, '未跟踪');
  assert.equal(view.gitEntryLabel(status.entries[1]!, i18n).label, '索引 / 工作树：.D');
  assert.equal(view.gitEntryLabel({ ...status.entries[1]!, index: 'U', worktree: 'U', conflicted: true }, i18n).label, '冲突');
});

test('Git is collapsed by default; refresh is outside details and only live paths have open actions', () => {
  let refreshes = 0, stopped = 0;
  const opened: unknown[] = [];
  const props = { status, loading: false, error: false, i18n, reload: () => { refreshes++; }, onOpen: (...args: unknown[]) => { opened.push(args); } };
  const section = view.BotWorkGitSection(props);
  const html = renderToStaticMarkup(section);
  assert.match(html, /<details><summary>/);
  assert.match(html, /<summary><svg data-icon="chevronRight"/);
  assert.match(html, /feature\/docs/);
  assert.match(html, /已暂存 1 · 未暂存 2 · 未跟踪 1/);
  assert.match(html, /仅显示前 2 项（共 4 项）/);
  const all = elements(section);
  const disclosure = all.find(node => node.type === 'details')!;
  const refresh = all.find(node => node.props['aria-label'] === '刷新 Git 状态')!;
  assert.ok(!elements(disclosure).includes(refresh));
  assert.match(renderToStaticMarkup(refresh), /<svg data-icon="repeat"/);
  (refresh.props.onClick as (event: unknown) => void)({ stopPropagation: () => { stopped++; } });
  assert.deepEqual([refreshes, stopped], [1, 1]);
  const links = elements(disclosure).filter(node => node.type === 'button');
  for (const link of links) (link.props.onClick as () => void)();
  assert.deepEqual(opened, [['new.txt', 'file'], ['.', 'directory']]);
  assert.match(html, /nested\/gone\.txt/);
  assert.equal(view.BotWorkGitSection({ ...props, status: undefined }), null);
  assert.match(renderToStaticMarkup(view.BotWorkGitSection({ ...props, error: true, loading: true })), /disabled=""/);
});

test('BotWorkPanel puts the Git disclosure after the matter board and reference folds, with scoped resource navigation', () => {
  let current: Status | undefined = status;
  const opened: unknown[][] = [];
  const { BotWorkPanel } = load<typeof import('./BotWorkPanel')>('./BotWorkPanel.tsx', {
    react: { useId: () => 'board', useLayoutEffect: noop, useMemo: (read: () => unknown) => read(),
      useRef: (value: unknown) => ({ current: value }), useState: (value: unknown) => [typeof value === 'boolean' ? true : value, noop] },
    'react-dom': {}, '../../ui/icons': icons, '../../chat/state/compositionGuard': {}, '../../app/components/interactionLayers': {},
    '../../app/hooks/useInteractionLayer': { useInteractionLayer: noop },
    '../../workbench/ResourceWorkspaceContext': { useResourceWorkspace: () => ({ owner: { workspaceId: 'bot', path: '/repo/nested' }, ready: true, openReference: (...args: unknown[]) => opened.push(args) }) },
    '../state/botWorkPanelState': workPanelState, '../state/useBotWorkPanelData': { useBotWorkPanelData: () => ({ items: [] }) },
    '../state/useBotWorkPanelObjectives': { useBotWorkPanelObjectives: () => ({ items: [] }) },
    '../state/useBotWorkPanelGitStatus': { useBotWorkPanelGitStatus: () => ({ status: current, loading: false, error: false, reload: noop }) },
    './BotWorkGitSection': view, './BotWorkSessionRow': {}, './BotWorkMaterials': {}, '../styles/bot-work-panel.css': {},
  });
  const props = { workspaceId: 'bot', workIndex: { byId: new Map(), byAnchor: new Map(), available: true }, rows: [], messages: [], recovering: false,
    headerTarget: null, i18n, botName: 'Bot', avatar: null, onOpenSettings: noop, onOpenHistory: noop, onRefreshWork: async () => {},
    obligationGrants: [], children: null, onOpenTask: noop, onOpenBlocker: noop, onOpenCard: noop, onOpenGrant: noop, onOpenObjective: noop };
  const all = elements(BotWorkPanel(props));
  const disclosures = all.filter(node => node.type === 'details' || node.type === view.BotWorkGitSection);
  assert.deepEqual(disclosures.map(node => node.type), ['details', 'details', view.BotWorkGitSection]);
  const git = disclosures.at(-1)!;
  (git.props.onOpen as (path: string, kind: string) => void)('report.md#L7', 'file');
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [[{ workspaceId: 'bot', path: 'report.md#L7', kind: 'file' }, { literalPath: true }]]);
  current = undefined;
  assert.ok(!elements(BotWorkPanel(props)).some(node => node.type === view.BotWorkGitSection));
});

test('hook reads only while open and discards old responses on workspace, session, refresh and close transitions', async () => {
  const timers = new Map<number, () => Promise<void>>();
  let timerId = 0;
  let cursor = 0;
  const state: unknown[] = [];
  let previous: unknown[] | undefined;
  let cleanup: (() => void) | undefined;
  const requests: { owner: string; resolve: (result: WorkPanelGitStatus) => void }[] = [];
  const { useBotWorkPanelGitStatus } = load<typeof import('../state/useBotWorkPanelGitStatus')>('../state/useBotWorkPanelGitStatus.ts', {
    react: {
      useState(initial: unknown) {
        const index = cursor++;
        if (!(index in state)) state[index] = initial;
        return [state[index], (next: unknown) => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
      },
      useEffect(effect: () => (() => void) | undefined, deps: unknown[]) {
        if (previous && deps.every((value, index) => Object.is(value, previous?.[index]))) return;
        cleanup?.(); previous = deps; cleanup = effect();
      },
    },
    '../../clientApi': { clientApi: { projectAgentReadGitStatus: ({ workspaceId }: { workspaceId: string }) => new Promise<WorkPanelGitStatus>(resolve => requests.push({ owner: workspaceId, resolve })) } },
  }, { setTimeout: (callback: () => Promise<void>) => { timers.set(++timerId, callback); return timerId; }, clearTimeout: (id: number) => timers.delete(id) });
  const render = (owner: string, open: boolean, revision = 'running') => { cursor = 0; return useBotWorkPanelGitStatus(owner, `/${owner}`, open, revision); };
  const start = () => { const next = [...timers.values()]; assert.equal(next.length, 1); timers.clear(); return next[0]!(); };
  render('a', false); assert.equal(timers.size, 0);
  render('a', true); const a = start();
  const none = render('b', true); assert.equal(none.status, undefined);
  const b = start(); requests[1]!.resolve(status); await b;
  requests[0]!.resolve({ ...status, branch: 'wrong' }); await a;
  assert.equal(render('b', true).status?.branch, status.branch);
  assert.equal(timers.size, 0);
  render('b', true, 'done'); const completed = start();
  render('b', true, 'done').reload(); render('b', true, 'done'); const manual = start();
  requests[3]!.resolve({ ...status, branch: 'fresh' }); await manual;
  requests[2]!.resolve({ ...status, branch: 'stale' }); await completed;
  assert.equal(render('b', true, 'done').status?.branch, 'fresh');
  render('b', true, 'done').reload(); render('b', true, 'done'); const closing = start();
  assert.equal(render('b', false, 'done').status, undefined);
  requests[4]!.resolve(status); await closing;
  assert.equal(render('b', false, 'done').status, undefined);
  assert.deepEqual(requests.map(request => request.owner), ['a', 'b', 'b', 'b', 'b']);
  assert.equal(timers.size, 0);
});
