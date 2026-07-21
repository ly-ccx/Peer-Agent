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
) => RuntimeSdkProviderExecution | Promise<RuntimeSdkProviderExecution> = (capabilityId) => execution(capabilityId)): TuiHost {
  return {
    workspaceRoot: '/tmp/test',
    capabilities: ['local.file.read'],
    toolDefinitions: [{ name: 'read_file', capabilityId: 'local.file.read' }],
    getAccessLevel: () => 'ask_before_local',
    setAccessLevel: () => 'ask_before_local',
    execute: async (capabilityId, arguments_, context) => await run(capabilityId, arguments_, context),
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
  test('queues the next user-facing mode while keeping the active turn mode fixed', async () => {
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
    expect(controller.setMode('goal')).toBe(true);
    expect(controller.getSnapshot().mode).toBe('goal');
    release();
    await pending;

    expect(observedModes).toEqual(['plan']);
    expect(controller.getSnapshot().mode).toBe('goal');
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

  test('inserts a pending assistant placeholder as soon as send() starts', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      async runTurn(state) {
        await gate;
        return { kind: 'completed', state, output: 'done' };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({ host: host(), model });
    const snapshots: Array<{ status: string; pending: boolean; content: string }> = [];
    controller.subscribe((snapshot) => {
      const last = snapshot.messages.at(-1);
      if (last?.role === 'assistant') {
        snapshots.push({
          status: snapshot.status,
          pending: Boolean(last.pending),
          content: last.content,
        });
      }
    });

    const pending = controller.send('hi');
    // Immediately after send(), before first model token:
    const running = controller.getSnapshot();
    expect(running.status).toBe('running');
    const placeholder = running.messages.at(-1);
    expect(placeholder).toMatchObject({
      role: 'assistant',
      content: '',
      pending: true,
    });

    release();
    await pending;

    expect(controller.getSnapshot().status).toBe('idle');
    // Empty placeholder with no content should be cleaned up after finish.
    expect(controller.getSnapshot().messages.map((m) => m.role)).toEqual(['user']);
    expect(snapshots.some((item) => item.status === 'running' && item.pending && item.content === '')).toBe(true);
  });

  test('streams reasoning.delta into thinkingContent on the pending assistant', async () => {
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      async runTurn(state, context) {
        context.emit({ type: 'reasoning.delta', streamId: 'test', content: 'step 1 ' });
        context.emit({ type: 'reasoning.delta', streamId: 'test', content: 'step 2' });
        context.emit({ type: 'message.delta', streamId: 'test', content: 'answer' });
        return { kind: 'completed', state, output: 'answer' };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({ host: host(), model });
    const thinkingSnapshots: string[] = [];
    controller.subscribe((snapshot) => {
      const last = snapshot.messages.at(-1);
      if (last?.role === 'assistant' && last.thinkingContent) {
        thinkingSnapshots.push(last.thinkingContent);
      }
    });

    await controller.send('think');

    expect(thinkingSnapshots.at(-1)).toBe('step 1 step 2');
    const final = controller.getSnapshot().messages.at(-1);
    expect(final).toMatchObject({
      role: 'assistant',
      content: 'answer',
      pending: false,
      thinkingContent: 'step 1 step 2',
    });
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

  test('clears messages, provider errors, and model context while preserving mode', async () => {
    const observedInputs: string[][] = [];
    let shouldFail = true;
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      async runTurn(state) {
        observedInputs.push(state.modelMessages.map((message) => String(message.content)));
        if (shouldFail) throw new Error('provider exploded');
        return { kind: 'completed', state, output: 'recovered' };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({ host: host(), model, initialMode: 'plan' });

    await controller.send('fail');
    expect(controller.clear()).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ status: 'idle', mode: 'plan', messages: [] });
    expect(controller.getSnapshot().error).toBeUndefined();

    shouldFail = false;
    await controller.send('fresh');
    expect(observedInputs).toEqual([['fail'], ['fresh']]);
  });

  test('refuses to clear while a turn is active', async () => {
    let release!: () => void;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const canFinish = new Promise<void>((resolve) => { release = resolve; });
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      async runTurn(state) {
        started();
        await canFinish;
        return { kind: 'completed', state, output: 'done' };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({ host: host(), model });
    const sending = controller.send('active');
    await didStart;

    expect(controller.clear()).toBe(false);
    expect(controller.getSnapshot().messages).not.toEqual([]);
    release();
    await sending;
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

  test('compacts modelMessages while preserving UI transcript', async () => {
    let observedModelMessageCount = 0;
    const model: ChatModelPort = {
      initialize(input) {
        return {
          messages: [
            ...input.input.history,
            { id: 'input', role: 'user', content: input.input.content },
          ],
          modelMessages: [
            ...input.input.modelMessages,
            { role: 'user', content: input.input.content },
          ],
          toolExecutions: [],
        };
      },
      async runTurn(state) {
        observedModelMessageCount = state.modelMessages.length;
        return {
          kind: 'completed',
          state: {
            ...state,
            modelMessages: [
              ...state.modelMessages,
              { role: 'assistant', content: `reply-${state.modelMessages.length}` },
            ],
          },
          output: `reply-${state.modelMessages.length}`,
        };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({ host: host(), model });

    for (let index = 0; index < 6; index += 1) {
      await controller.send(`message-${index}`);
    }
    const beforeUiCount = controller.getSnapshot().messages.length;
    const beforeModelCount = observedModelMessageCount;
    expect(beforeModelCount).toBeGreaterThan(8);

    const result = await controller.compact();

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.afterCount).toBeLessThan(result.beforeCount);
    // UI transcript keeps prior turns and appends one durable compact separator.
    expect(controller.getSnapshot().messages).toHaveLength(beforeUiCount + 1);
    expect(
      controller.getSnapshot().messages.some(
        (message) => message.role === 'system' && message.compact?.phase === 'done',
      ),
    ).toBe(true);

    await controller.send('after-compact');
    expect(observedModelMessageCount).toBeLessThan(beforeModelCount + 2);
    // UI transcript keeps prior turns and appends the new exchange.
    expect(controller.getSnapshot().messages.length).toBeGreaterThan(beforeUiCount);
    expect(
      controller.getSnapshot().messages.some((message) => message.content === 'after-compact'),
    ).toBe(true);
  });

  
  test('compact publishes progress then durable separator in UI transcript', async () => {
    const model: ChatModelPort = {
      initialize(input) {
        return {
          messages: [
            ...input.input.history,
            { id: 'input', role: 'user', content: input.input.content },
          ],
          modelMessages: [
            ...input.input.modelMessages,
            { role: 'user', content: input.input.content },
          ],
          toolExecutions: [],
        };
      },
      async runTurn(state) {
        return {
          kind: 'completed',
          state: {
            ...state,
            modelMessages: [
              ...state.modelMessages,
              { role: 'assistant', content: `reply-${state.modelMessages.length}` },
            ],
          },
          output: `reply-${state.modelMessages.length}`,
        };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({ host: host(), model });
    const seen: string[] = [];
    controller.subscribe((snapshot) => {
      const system = snapshot.messages.filter((message) => message.role === 'system');
      for (const message of system) {
        seen.push(`${message.compact?.phase ?? 'none'}:${message.content}`);
      }
    });

    for (let index = 0; index < 6; index += 1) {
      await controller.send(`message-${index}`);
    }

    const result = await controller.compact();
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);

    const finalSystem = controller.getSnapshot().messages.filter((message) => message.role === 'system');
    expect(finalSystem).toHaveLength(1);
    expect(finalSystem[0]?.compact?.phase).toBe('done');
    expect(finalSystem[0]?.content).toContain('Compacted');
    expect(seen.some((entry) => entry.startsWith('progress:'))).toBe(true);
    expect(seen.some((entry) => entry.startsWith('done:'))).toBe(true);
  });

  test('compact is blocked while a turn is active', async () => {
    let release!: () => void;
    const canFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      async runTurn(state) {
        started();
        await canFinish;
        return { kind: 'completed', state, output: 'done' };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({ host: host(), model });
    const sending = controller.send('active');
    await didStart;

    const result = await controller.compact();
    expect(result.ok).toBe(false);
    expect(result.notice).toContain('idle');

    release();
    await sending;
  });

  test('restores stable history and exposes it as model context on the next turn', async () => {
    const observedHistory: Array<readonly { role: string; content: string }[]> = [];
    const model: ChatModelPort = {
      initialize(input) {
        observedHistory.push(input.input.history);
        return initialState(input.input);
      },
      async runTurn(state) {
        return { kind: 'completed', state, output: 'continued' };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({ host: host(), model });

    expect(controller.restore({
      mode: 'plan',
      messages: [
        { id: 'old-user', role: 'user', content: 'original request' },
        { id: 'old-tool', role: 'tool', content: 'tool evidence' },
        { id: 'old-assistant', role: 'assistant', content: 'original answer' },
        { id: 'pending', role: 'assistant', content: 'partial', pending: true },
      ],
    })).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      status: 'idle',
      mode: 'plan',
    });
    expect(controller.getSnapshot().error).toBeUndefined();
    expect(controller.getSnapshot().messages.map((message) => message.id)).toEqual([
      'old-user', 'old-tool', 'old-assistant',
    ]);

    await controller.send('continue please');

    expect(observedHistory.map((history) => history.map(({ role, content }) => ({ role, content })))).toEqual([[
      { role: 'user', content: 'original request' },
      { role: 'tool', content: 'tool evidence' },
      { role: 'assistant', content: 'original answer' },
    ]]);
  });

  test('refuses to restore while a turn is running', async () => {
    let release!: () => void;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const canFinish = new Promise<void>((resolve) => { release = resolve; });
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      async runTurn(state) {
        started();
        await canFinish;
        return { kind: 'completed', state, output: 'done' };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({ host: host(), model });
    const pending = controller.send('active message');
    await didStart;

    expect(controller.restore({
      mode: 'goal',
      messages: [{ id: 'restored', role: 'user', content: 'must not replace active turn' }],
    })).toBe(false);
    expect(controller.getSnapshot().messages.some((message) => message.id === 'restored')).toBe(false);

    release();
    await pending;
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
  test('keeps tool results and marks assistant interrupted on stream failure', async () => {
    let turns = 0;
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      runTurn(state) {
        turns += 1;
        if (turns === 1) {
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
        throw new Error('provider_stream_error: connection reset');
      },
      applyToolResults(state, results) {
        return { ...state, toolExecutions: results.map((item) => item.result) };
      },
    };
    const controller = createChatController({
      model,
      host: host(() => execution('file contents')),
    });

    await controller.send('read it');

    const snap = controller.getSnapshot();
    expect(snap.status).toBe('idle');
    expect(snap.error).toContain('provider_stream_error');
    expect(snap.messages.some((message) => message.role === 'tool')).toBe(true);
    const tool = snap.messages.find((message) => message.role === 'tool');
    expect(tool?.tool?.toolCallId).toBe('call-1');
    expect(tool?.tool?.arguments).toEqual({ path: 'package.json' });
    // partial assistant placeholder may remain interrupted for recovery
    const assistant = [...snap.messages].reverse().find((message) => message.role === 'assistant');
    expect(assistant?.interrupted).toBe(true);
  });

  test('publishes running intermediate tool state before completion', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const statuses: string[] = [];
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      async runTurn(state) {
        if (state.toolExecutions.length === 0) {
          return {
            kind: 'tool_calls',
            state,
            calls: [{
              toolCallId: 'call-running-1',
              capabilityId: 'local.file.list',
              arguments: { path: '.' },
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
      host: host(async () => {
        await gate;
        return execution('listed');
      }),
    });

    controller.subscribe((snapshot) => {
      for (const message of snapshot.messages) {
        if (message.role === 'tool' && message.tool) {
          statuses.push(message.tool.status);
        }
      }
    });

    const pending = controller.send('list files');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statuses).toContain('running');
    const runningMessage = controller.getSnapshot().messages.find((message) => message.role === 'tool');
    expect(runningMessage?.tool?.status).toBe('running');
    const runningId = runningMessage?.id;
    release?.();
    await pending;
    const completedMessage = controller.getSnapshot().messages.find((message) => message.id === runningId);
    expect(completedMessage?.tool?.status).toBe('completed');
    expect(statuses[0]).toBe('running');
  });
});
