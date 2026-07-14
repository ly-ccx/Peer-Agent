import { describe, expect, test } from 'bun:test';
import type { RuntimeSdkProviderExecution } from '@peer-agent/runtime-sdk';

import {
  createChatController,
  type ChatModelPort,
  type ChatModelState,
} from './chat-controller.ts';
import type { TuiExecutionContext, TuiHost } from './tui-host.ts';

const goalContext = (goalId: string, sourcePlanId: string, sessionId: string) => ({
  goalId,
  sourcePlanId,
  sessionId,
  taskIndex: 0,
  signal: new AbortController().signal,
});

function execution(outputPreview: string, evidenceId?: string): RuntimeSdkProviderExecution {
  return {
    result: {
      status: 'completed',
      outputPreview,
      evidence: evidenceId ? { source: 'test', evidenceId } : { source: 'test' },
    },
  } as RuntimeSdkProviderExecution;
}

function host(run: (
  capabilityId: string,
  arguments_: Record<string, unknown>,
  context?: TuiExecutionContext,
) => RuntimeSdkProviderExecution = (capabilityId) => execution(capabilityId)): TuiHost {
  return {
    workspaceRoot: '/tmp/test',
    capabilities: ['local.file.read'],
    toolDefinitions: [{ name: 'read_file', capabilityId: 'local.file.read' }],
    execute: async (capabilityId, arguments_, context) => run(capabilityId, arguments_, context),
    executeRead: async () => execution('read'),
    executeShell: async () => execution('shell'),
    subscribe: () => () => {},
    subscribeApproval: (listener) => {
      listener(null);
      return () => {};
    },
  };
}

const initialState = (input: { content: string }): ChatModelState => ({
  messages: [{ id: 'input', role: 'user', content: input.content }],
  modelMessages: [{ role: 'user', content: input.content }],
  toolExecutions: [],
});

describe('chat controller', () => {
  test('switches among four modes while idle and keeps the mode fixed during a turn', async () => {
    let release!: () => void;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const canFinish = new Promise<void>((resolve) => { release = resolve; });
    const observedModes: Array<string | undefined> = [];
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      async runTurn(state, context) {
        observedModes.push(context.run.mode);
        started();
        await canFinish;
        return { kind: 'completed', state, output: 'done' };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({ host: host(), model });

    expect(controller.getSnapshot().mode).toBe('chat');
    expect(controller.setMode('plan')).toBe(true);
    expect(controller.getSnapshot().mode).toBe('plan');

    const pending = controller.send('make a plan');
    await didStart;
    expect(controller.setMode('goal')).toBe(false);
    expect(controller.getSnapshot().mode).toBe('plan');
    release();
    await pending;

    expect(observedModes).toEqual(['plan']);
    expect(controller.getSnapshot().mode).toBe('plan');
    expect(controller.setMode('explorer')).toBe(true);
    expect(controller.getSnapshot().mode).toBe('explorer');
  });

  test('passes the turn mode to governed tool execution', async () => {
    let observedContext: TuiExecutionContext | undefined;
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      async runTurn(state) {
        if (state.toolExecutions.length === 0) {
          return {
            kind: 'tool_calls',
            state,
            calls: [{
              toolCallId: 'mode-call',
              capabilityId: 'local.file.read',
              arguments: { path: 'note.txt' },
            }],
          };
        }
        return { kind: 'completed', state };
      },
      applyToolResults(state, results) {
        return { ...state, toolExecutions: results.map((item) => item.result) };
      },
    };
    const controller = createChatController({
      host: host((_capabilityId, _arguments, context) => {
        observedContext = context;
        return execution('contents');
      }),
      model,
      initialMode: 'explorer',
    });

    await controller.send('inspect');

    expect(observedContext?.mode).toBe('explorer');
  });

  test('streams assistant deltas into one message', async () => {
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      async runTurn(state, context) {
        context.emit({ type: 'message.delta', streamId: 'test', content: 'hello ' });
        context.emit({ type: 'message.delta', streamId: 'test', content: 'world' });
        return { kind: 'completed', state, output: 'hello world' };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({ host: host(), model });

    await controller.send('hi');

    expect(controller.getSnapshot().status).toBe('idle');
    expect(controller.getSnapshot().messages.map(({ role, content }) => [role, content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'hello world'],
    ]);
  });

  test('executes model tool calls through the TUI host and resumes the model', async () => {
    const calls: string[] = [];
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      runTurn(state, context) {
        if (state.toolExecutions.length === 0) {
          return {
            kind: 'tool_calls',
            state,
            calls: [{
              toolCallId: 'call-1',
              capabilityId: 'local.file.read',
              arguments: { path: 'package.json' },
            }],
          };
        }
        context.emit({ type: 'message.delta', streamId: 'test', content: 'finished' });
        return { kind: 'completed', state, output: 'finished' };
      },
      applyToolResults(state, results) {
        return { ...state, toolExecutions: results.map((item) => item.result) };
      },
    };
    const controller = createChatController({
      model,
      host: host((capabilityId) => {
        calls.push(capabilityId);
        return execution('file contents');
      }),
    });

    await controller.send('read it');

    expect(calls).toEqual(['local.file.read']);
    expect(controller.getSnapshot().messages.some((message) => message.role === 'tool')).toBe(true);
    expect(controller.getSnapshot().messages.at(-1)?.content).toBe('finished');
  });

  test('cancels an active model turn', async () => {
    let started!: () => void;
    const isStarted = new Promise<void>((resolve) => { started = resolve; });
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      async runTurn(state, context) {
        started();
        await new Promise<void>((resolve, reject) => {
          context.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
        return { kind: 'completed', state };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({ host: host(), model });

    const running = controller.send('wait');
    await isStarted;
    controller.cancel();
    expect(controller.getSnapshot().status).toBe('cancelling');
    await running;

    expect(controller.getSnapshot().status).toBe('idle');
    expect(controller.getSnapshot().error).toBeUndefined();
    expect(controller.getSnapshot().session?.lastTurn?.status).toBe('cancelled');
    expect(controller.getSnapshot().session?.lastTurn?.reason).toBe('cancelled_in_tui');
  });

  test('keeps cancellation terminal when a model completes late', async () => {
    let started!: () => void;
    let release!: () => void;
    const isStarted = new Promise<void>((resolve) => { started = resolve; });
    const canComplete = new Promise<void>((resolve) => { release = resolve; });
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      async runTurn(state) {
        started();
        await canComplete;
        return { kind: 'completed', state };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({ host: host(), model });

    const running = controller.send('wait for late completion');
    await isStarted;
    controller.cancel();
    release();
    await running;

    expect(controller.getSnapshot().status).toBe('idle');
    expect(controller.getSnapshot().session?.lastTurn?.status).toBe('cancelled');
    expect(controller.getSnapshot().session?.lastTurn?.reason).toBe('cancelled_in_tui');
  });

  test('records a failed turn without losing the provider error', async () => {
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      async runTurn() {
        throw new Error('provider exploded');
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({ host: host(), model });

    await controller.send('fail');

    expect(controller.getSnapshot().status).toBe('idle');
    expect(controller.getSnapshot().error).toBe('provider exploded');
    expect(controller.getSnapshot().session?.lastTurn?.status).toBe('failed');
    expect(controller.getSnapshot().session?.lastTurn?.reason).toBe('provider exploded');
  });

  test('starts the first turn and resumes the same session on later sends', async () => {
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      async runTurn(state) {
        return { kind: 'completed', state };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({
      host: host(),
      model,
      sessionId: 'stable-session',
      conversationId: 'stable-conversation',
    });

    await controller.send('first');
    const first = controller.getSnapshot().session;
    await controller.send('second');
    const second = controller.getSnapshot().session;

    expect(first?.sessionId).toBe('stable-session');
    expect(first?.conversationId).toBe('stable-conversation');
    expect(first?.lastTurn?.turnId).toBe('stable-session:turn:0');
    expect(first?.lastTurn?.turnIndex).toBe(0);
    expect(first?.lastTurn?.status).toBe('completed');
    expect(second?.sessionId).toBe(first?.sessionId);
    expect(second?.createdAt).toBe(first?.createdAt);
    expect(second?.lastTurn?.turnId).toBe('stable-session:turn:1');
    expect(second?.lastTurn?.turnIndex).toBe(1);
    expect(second?.lastTurn?.status).toBe('completed');
    expect(second?.nextTurnIndex).toBe(2);
  });

  test('passes stable session and turn context to tool execution', async () => {
    let observedContext: TuiExecutionContext | undefined;
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      async runTurn(state) {
        if (state.toolExecutions.length === 0) {
          return {
            kind: 'tool_calls',
            state,
            calls: [{
              toolCallId: 'call-1',
              capabilityId: 'local.file.read',
              arguments: { path: 'note.txt' },
            }],
          };
        }
        return { kind: 'completed', state };
      },
      applyToolResults(state, results) {
        return { ...state, toolExecutions: results.map((item) => item.result) };
      },
    };
    const controller = createChatController({
      model,
      sessionId: 'tool-session',
      host: host((_capabilityId, _arguments, context) => {
        observedContext = context;
        return execution('file contents');
      }),
    });

    await controller.send('read it');

    expect(observedContext?.sessionId).toBe('tool-session');
    expect(observedContext?.conversationId).toBe('tool-session');
    expect(observedContext?.turnId).toBe('tool-session:turn:0');
    expect(observedContext?.turnIndex).toBe(0);
    expect(observedContext?.streamId).toBe('tool-session:stream:0');
    expect(observedContext?.signal).toBeInstanceOf(AbortSignal);
    expect(controller.getSnapshot().session?.lastTurn?.status).toBe('completed');
  });

  test('executes a goal task in its own session through the host and requires new Evidence', async () => {
    const observedContexts: TuiExecutionContext[] = [];
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      async runTurn(state) {
        if (state.toolExecutions.length === 0) {
          return {
            kind: 'tool_calls',
            state,
            calls: [{
              toolCallId: 'goal-call',
              capabilityId: 'local.file.read',
              arguments: { path: 'goal.txt' },
            }],
          };
        }
        return { kind: 'completed', state, output: 'task complete' };
      },
      applyToolResults(state, results) {
        return { ...state, toolExecutions: results.map((item) => item.result) };
      },
    };
    const controller = createChatController({
      model,
      sessionId: 'goal-session-a',
      host: host((_capabilityId, _arguments, context) => {
        if (context) observedContexts.push(context);
        return execution('goal contents', 'goal-a');
      }),
    });

    const result = await controller.executeGoalTask(
      { taskId: 'inspect', title: 'Inspect the goal file' },
      goalContext('goal-a', 'plan-a', 'goal-session-a'),
    );

    expect(result).toEqual({ status: 'completed', evidenceRefs: ['evidence://goal-a'] });
    expect(observedContexts).toHaveLength(1);
    expect(observedContexts[0]?.sessionId).toBe('goal-session-a');
    expect(observedContexts[0]?.mode).toBe('goal');
  });

  test('blocks goal completion when a model response produces no Runtime Evidence', async () => {
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      async runTurn(state) {
        return { kind: 'completed', state, output: 'I finished without using a capability.' };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({
      model,
      sessionId: 'goal-session-no-evidence',
      host: host(),
    });

    const result = await controller.executeGoalTask(
      { taskId: 'claim', title: 'Claim completion' },
      goalContext('goal-no-evidence', 'plan-no-evidence', 'goal-session-no-evidence'),
    );

    expect(result).toEqual({ status: 'blocked', reason: 'goal_task_completed_without_evidence' });
  });

  test('keeps goal task execution isolated between controller sessions', async () => {
    const contexts: TuiExecutionContext[] = [];
    const createModel = (): ChatModelPort => ({
      initialize: (input) => initialState(input.input),
      async runTurn(state) {
        if (state.toolExecutions.length === 0) {
          return {
            kind: 'tool_calls',
            state,
            calls: [{ toolCallId: 'call', capabilityId: 'local.file.read', arguments: {} }],
          };
        }
        return { kind: 'completed', state };
      },
      applyToolResults(state, results) {
        return { ...state, toolExecutions: results.map((item) => item.result) };
      },
    });
    const sharedHost = host((_capabilityId, _arguments, context) => {
      if (context) contexts.push(context);
      return execution('contents', context?.sessionId);
    });
    const first = createChatController({ host: sharedHost, model: createModel(), sessionId: 'session-a' });
    const second = createChatController({ host: sharedHost, model: createModel(), sessionId: 'session-b' });

    const [firstResult, secondResult] = await Promise.all([
      first.executeGoalTask(
        { taskId: 'a', title: 'Task A' },
        goalContext('goal-a', 'plan-a', 'session-a'),
      ),
      second.executeGoalTask(
        { taskId: 'b', title: 'Task B' },
        goalContext('goal-b', 'plan-b', 'session-b'),
      ),
    ]);

    expect(firstResult.evidenceRefs).toEqual(['evidence://session-a']);
    expect(secondResult.evidenceRefs).toEqual(['evidence://session-b']);
    expect(contexts.map((context) => context.sessionId).sort()).toEqual(['session-a', 'session-b']);
  });
});
