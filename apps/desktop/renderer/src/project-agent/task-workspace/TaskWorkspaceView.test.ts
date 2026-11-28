import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createI18n } from '@peer-agent/i18n';
import { WORK_SESSION_STATUSES } from '@peer-agent/protocol';
import * as drawerState from '../state/drawerState.ts';
import { mergeTaskDetail } from '../state/taskDetailState.ts';

test('task workspace places current plan above the conversation and hides earlier epochs', () => {
  const reports: unknown[][] = [];
  const jsx = (type: unknown, props: unknown) => ({ type, props });
  const imports: Record<string, unknown> = {
    react: {
      memo: (value: unknown) => value,
      useCallback: (value: unknown) => value,
      useEffect() {},
      useLayoutEffect() {},
      useMemo: (fn: () => unknown) => fn(),
      useRef: () => ({ current: null }),
      useState: (initial: unknown) => [initial, () => {}],
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '@peer-agent/protocol': { WORK_SESSION_STATUSES },
    '../../clientApi': { clientApi: {} },
    '../../ui/icons': { PeerIcon: 'icon' },
    '../../app/hooks/useCompositionGuard': {},
    '../BotAccessControl': { BotAccessControl: 'access' },
    '../state/drawerState': drawerState,
    '../state/taskDetailState': { mergeTaskDetail },
    '../state/useTaskReport': { useTaskReport: (...args: unknown[]) => {
      reports.push(args);
      return { detail: null, state: 'ready' };
    } },
    '../state/TaskCancellation': { useTaskCancellation: () => null },
    '../state/taskCancellationFocus': {},
    '../conversation/ComposerTouchBar': { ComposerTouchBar: 'composer' },
    '../drawer/ConversationScene': { ConversationSceneDrawer: 'conversation' },
    './TaskEvidenceInspector': { TaskEvidenceInspector: 'inspector' },
    './TaskWorkingPlanStrip': { TaskWorkingPlanStrip: 'working-plan' },
    './verdictStrip': {},
    '../styles/bot-task-workspace.css': {},
    '../styles/bot-touchbar.css': {},
  };
  const exports: Record<string, (props: unknown) => any> = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL('./TaskWorkspaceView.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require(id: string) { assert.ok(Object.hasOwn(imports, id), id); return imports[id]; } });
  const plan = {
    epoch: 1, revision: 2, updatedAt: '2026-11-27T00:00:00Z',
    total: 1, completed: 0, blocked: 0, steps: [{ title: 'Verify', status: 'pending' }],
  };
  const render = (epoch: number, status: string) => {
    const liveSession = drawerState.readDrawerSession({ sessionId: 'task', conversationId: 'worker', followUpEpoch: epoch, status, workingPlan: plan });
    const tree = exports.TaskWorkspaceView({
      workspaceId: 'project', sessionId: 'task', liveSession, sessionsAvailable: true,
      profile: { displayName: 'Bot' }, i18n: createI18n('en'), isZh: false,
    });
    const stage = tree.props.children[0];
    const children: any[] = stage.props.children.filter(Boolean);
    const stripIndex = children.findIndex(node => node.type === 'working-plan');
    assert.ok(stripIndex >= 0);
    const conversation = children[stripIndex + 1];
    assert.equal(conversation.props.className, 'bot-task-conversation-stage');
    assert.equal(conversation.props.children.type, 'conversation');
    return children[stripIndex].props.workingPlan;
  };

  assert.deepEqual(render(1, 'running'), plan);
  assert.equal(render(2, 'queued'), undefined);
  assert.equal(reports[0][6], 3_600);
  assert.equal(reports[1][6], undefined);
});
