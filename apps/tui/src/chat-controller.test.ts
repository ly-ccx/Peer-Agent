import { describe, expect, test } from 'bun:test';
import type { ContextAccountingSnapshot } from '@peer-agent/protocol';
import type { ModelMessage } from '@peer-agent/runtime-node';
import type { RuntimeSdkProviderExecution } from '@peer-agent/runtime-sdk';
import {
  createRuntimeUsageAccounting,
  estimateContextMessagesTokens as estimateTokensFromMessages,
} from '@peer-agent/runtime-core';

import {
  createChatController,
  formatCompactingStatusLabel,
  latestCompactProgressPercent,
  renderCompactProgressBar,
  type ChatModelPort,
  type ChatModelState,
  type ChatSystemContextBlock,
} from './chat-controller.ts';
import { GOAL_CAPABILITY_IDS } from './goal-bridge.ts';
import { createPlanCoordinator, type RuntimePlan } from './plan-mode.ts';
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

function accountingSnapshot(
  input: Partial<ContextAccountingSnapshot> = {},
): ContextAccountingSnapshot {
  return {
    version: 1,
    conversationId: 'tui-chat',
    contentRevision: 1,
    modelKey: 'model-a',
    revision: 1,
    phase: 'turn_complete',
    compactionEpoch: 0,
    contextWindow: 500_000,
    inputBudget: 500_000,
    compactionThresholdTokens: 400_000,
    authoritativeInputTokens: 40_000,
    percent: 8,
    pressureSource: 'provider_usage',
    pendingUncountedChanges: false,
    pendingContentChars: 0,
    countCapability: { kind: 'observed_usage_only' },
    counterStatus: 'active',
    updatedAt: 1,
    ...input,
  };
}

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

  test('collects only successful Explorer requests for one Goal turn and clears the collector', async () => {
    let initializedTurns = 0;
    const model: ChatModelPort = {
      initialize(input) {
        initializedTurns += 1;
        return initialState(input.input);
      },
      async runTurn(state) {
        if (initializedTurns === 1 && state.toolExecutions.length === 0) {
          return {
            kind: 'tool_calls',
            state,
            calls: [
              {
                toolCallId: 'explore-success',
                capabilityId: GOAL_CAPABILITY_IDS.explore,
                arguments: {
                  question: '  Where is the symbol used?  ',
                  reason: '  Ground the implementation  ',
                  scope: { include: ['  src  '], exclude: ['  dist  '] },
                },
              },
              {
                toolCallId: 'explore-failed',
                capabilityId: GOAL_CAPABILITY_IDS.explore,
                arguments: {
                  question: 'This request fails',
                  reason: 'Must not be dispatched',
                },
              },
            ],
          };
        }
        return { kind: 'completed', state, output: 'goal turn complete' };
      },
      applyToolResults(state, results) {
        return { ...state, toolExecutions: results.map((item) => item.result) };
      },
    };
    const controller = createChatController({
      model,
      host: host((_capabilityId, arguments_) => ({
        result: arguments_.question === 'This request fails'
          ? {
              status: 'failed',
              outputPreview: 'registration failed',
              evidence: { source: 'test' },
            }
          : {
              status: 'success',
              output: { registered: true },
              outputPreview: 'registered',
              evidence: { source: 'test' },
            },
      } as RuntimeSdkProviderExecution)),
    });

    const first = await controller.runGoalTurn('first goal tick');
    expect(controller.getSnapshot().messages.some((message) => (
      message.role === 'user' && message.content.includes('goal tick')
    ))).toBe(false);
    expect(first.toolCallCount).toBe(2);
    expect(first.explorers).toEqual([{
      question: 'Where is the symbol used?',
      reason: 'Ground the implementation',
      scope: { include: ['src'], exclude: ['dist'] },
    }]);

    const second = await controller.runGoalTurn('second goal tick');
    expect(second).toEqual({ continued: true, explorers: [], toolCallCount: 0 });
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

  test('marks streamed content pending without fabricating a larger token percentage', async () => {
    let releaseTurn!: () => void;
    let emittedDelta!: () => void;
    const turnPending = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const deltaEmitted = new Promise<void>((resolve) => {
      emittedDelta = resolve;
    });
    const streamedText = 'x'.repeat(40_000);
    const model: ChatModelPort = {
      initialize: (input) => ({
        ...initialState(input.input),
        usage: input.input.usage,
      }),
      async runTurn(state, context) {
        context.emit({ type: 'message.delta', streamId: 'preview-test', content: streamedText });
        emittedDelta();
        await turnPending;
        return {
          kind: 'completed',
          state: {
            ...state,
            modelMessages: [
              ...state.modelMessages,
              { role: 'assistant', content: streamedText },
            ],
          },
          output: streamedText,
        };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({
      host: host(),
      model,
      getContextWindow: () => 500_000,
    });
    expect(controller.restore({
      mode: 'chat',
      messages: [
        { id: 'old-user', role: 'user', content: 'existing context' },
        { id: 'old-assistant', role: 'assistant', content: 'existing answer' },
      ],
      modelMessages: [
        { role: 'user', content: 'existing context' },
        { role: 'assistant', content: 'existing answer' },
      ],
      usage: { inputTokens: 40_000, outputTokens: 100 },
      contextAccounting: accountingSnapshot(),
    })).toBe(true);

    const providerObservedBaseline = controller.getSnapshot().contextAccounting;
    const pending = controller.send('continue');
    try {
      await deltaEmitted;
      await new Promise((resolve) => setTimeout(resolve, 50));
      const running = controller.getSnapshot();
      expect(running.status).toBe('running');
      expect(running.contextAccounting?.authoritativeInputTokens).toBe(
        providerObservedBaseline?.authoritativeInputTokens,
      );
      expect(running.contextAccounting?.percent).toBe(providerObservedBaseline?.percent);
      expect(running.contextAccounting?.phase).toBe('stream_preview');
      expect(running.contextAccounting?.pendingUncountedChanges).toBe(true);
      expect(running.contextAccounting?.pendingContentChars).toBeGreaterThan(streamedText.length);
    } finally {
      releaseTurn();
      await pending;
    }
  });

  test('marks tool results pending while preserving provider-backed authority', async () => {
    let releaseSecondRound!: () => void;
    let secondRoundStarted!: () => void;
    const secondRoundPending = new Promise<void>((resolve) => {
      releaseSecondRound = resolve;
    });
    const didStartSecondRound = new Promise<void>((resolve) => {
      secondRoundStarted = resolve;
    });
    const toolResultText = 'tool-result-content '.repeat(1_000);
    const model: ChatModelPort = {
      initialize: (input) => ({
        ...initialState(input.input),
        usage: input.input.usage,
      }),
      async runTurn(state) {
        if (state.toolExecutions.length === 0) {
          return {
            kind: 'tool_calls',
            state: {
              ...state,
              modelMessages: [
                ...state.modelMessages,
                {
                  role: 'assistant',
                  content: null,
                  toolCalls: [{ id: 'projection-tool', name: 'read_file', arguments: '{}' }],
                },
              ],
              usage: { inputTokens: 1_100 },
            },
            calls: [{
              toolCallId: 'projection-tool',
              capabilityId: 'local.file.read',
              arguments: { path: 'large.txt' },
            }],
          };
        }
        secondRoundStarted();
        await secondRoundPending;
        return { kind: 'completed', state, output: 'done' };
      },
      applyToolResults(state, executions) {
        return {
          ...state,
          modelMessages: [
            ...state.modelMessages,
            ...executions.map((item) => ({
              role: 'tool' as const,
              toolCallId: item.call.toolCallId,
              content: toolResultText,
            })),
          ],
          toolExecutions: [
            ...state.toolExecutions,
            ...executions.map((item) => item.result),
          ],
        };
      },
    };
    const controller = createChatController({
      host: host(),
      model,
      getContextWindow: () => 100_000,
    });
    expect(controller.restore({
      mode: 'chat',
      messages: [{ id: 'old-user', role: 'user', content: 'existing context' }],
      modelMessages: [{ role: 'user', content: 'existing context' }],
      usage: { inputTokens: 1_000 },
      contextAccounting: accountingSnapshot({
        contextWindow: 100_000,
        inputBudget: 100_000,
        compactionThresholdTokens: 80_000,
        authoritativeInputTokens: 1_000,
        percent: 1,
      }),
    })).toBe(true);

    const providerObservedBaseline =
      controller.getSnapshot().contextAccounting?.authoritativeInputTokens;
    const pending = controller.send('read the large result');
    try {
      await didStartSecondRound;
      const afterToolResult = controller.getSnapshot();
      expect(afterToolResult.status).toBe('running');
      expect(afterToolResult.contextAccounting?.authoritativeInputTokens).toBe(
        providerObservedBaseline,
      );
      expect(afterToolResult.contextAccounting?.phase).toBe('tool_result');
      expect(afterToolResult.contextAccounting?.pendingUncountedChanges).toBe(true);
      expect(afterToolResult.contextAccounting?.pendingContentChars).toBeGreaterThan(0);
    } finally {
      releaseSecondRound();
      await pending;
    }
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

  test('honors send maxTurns and returns exhausted', async () => {
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      runTurn(state) {
        return {
          kind: 'tool_calls',
          state,
          calls: [{
            toolCallId: 't1',
            capabilityId: 'local.file.read',
            arguments: { path: '.' },
          }],
        };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({ host: host(), model });
    const result = await controller.send('loop', { maxTurns: 2 });
    expect(result.status).toBe('exhausted');
    expect(result.turns).toBe(2);
    expect(controller.getSnapshot().error).toContain('turn limit');
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
    expect(final?.segments).toEqual([
      { type: 'thinking', content: 'step 1 step 2' },
      { type: 'text', content: 'answer' },
    ]);
  });

  test('interleaves thinking and tool segments in event order', async () => {
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      runTurn(state, context) {
        if (state.toolExecutions.length === 0) {
          context.emit({ type: 'reasoning.delta', streamId: 'test', content: 'think1' });
          return {
            kind: 'tool_calls',
            state,
            calls: [{
              toolCallId: 'call-1',
              capabilityId: 'local.file.read',
              arguments: { path: 'a.txt' },
            }],
          };
        }
        if (state.toolExecutions.length === 1) {
          context.emit({ type: 'reasoning.delta', streamId: 'test', content: 'think2' });
          return {
            kind: 'tool_calls',
            state,
            calls: [{
              toolCallId: 'call-2',
              capabilityId: 'local.search.files',
              arguments: { query: 'foo' },
            }],
          };
        }
        context.emit({ type: 'message.delta', streamId: 'test', content: 'done' });
        return { kind: 'completed', state, output: 'done' };
      },
      applyToolResults(state, results) {
        return {
          ...state,
          toolExecutions: [
            ...state.toolExecutions,
            ...results.map((item) => item.result),
          ],
        };
      },
    };
    const controller = createChatController({
      model,
      host: host(() => execution('ok')),
    });

    await controller.send('interleave');
    // Stream deltas are buffered (~32ms); wait so the final text segment is flushed.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const assistant = controller.getSnapshot().messages.find((message) => (
      message.role === 'assistant' && (message.segments?.length ?? 0) > 0
    ));
    expect(assistant?.segments?.map((segment) => segment.type)).toEqual([
      'thinking',
      'tool-call',
      'thinking',
      'tool-call',
      'text',
    ]);
    expect(assistant?.segments).toMatchObject([
      { type: 'thinking', content: 'think1' },
      { type: 'tool-call', tool: { capabilityId: 'local.file.read', toolCallId: 'call-1' } },
      { type: 'thinking', content: 'think2' },
      { type: 'tool-call', tool: { capabilityId: 'local.search.files', toolCallId: 'call-2' } },
      { type: 'text', content: 'done' },
    ]);
    expect(assistant?.thinkingContent).toBe('think1think2');
    expect(assistant?.tools?.map((tool) => tool.toolCallId)).toEqual(['call-1', 'call-2']);
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
    const messages = controller.getSnapshot().messages;
    expect(messages.some((message) => message.role === 'tool')).toBe(false);
    const assistantWithTools = messages.find((message) => (
      message.role === 'assistant' && ((message.tools?.length ?? 0) > 0 || Boolean(message.tool))
    ));
    expect(assistantWithTools?.tools?.map((tool) => tool.capabilityId) ?? [assistantWithTools?.tool?.capabilityId]).toEqual([
      'local.file.read',
    ]);
    expect(messages.at(-1)?.content).toBe('finished');
  });

  test('attaches multiple tool calls to the same assistant message', async () => {
    const calls: string[] = [];
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      runTurn(state, context) {
        if (state.toolExecutions.length === 0) {
          return {
            kind: 'tool_calls',
            state,
            calls: [
              {
                toolCallId: 'call-1',
                capabilityId: 'local.file.read',
                arguments: { path: 'a.txt' },
              },
              {
                toolCallId: 'call-2',
                capabilityId: 'local.search.files',
                arguments: { query: 'foo' },
              },
            ],
          };
        }
        context.emit({ type: 'message.delta', streamId: 'test', content: 'done' });
        return { kind: 'completed', state, output: 'done' };
      },
      applyToolResults(state, results) {
        return { ...state, toolExecutions: results.map((item) => item.result) };
      },
    };
    const controller = createChatController({
      model,
      host: host((capabilityId) => {
        calls.push(capabilityId);
        return execution(`${capabilityId} ok`);
      }),
    });

    await controller.send('run tools');

    expect(calls).toEqual(['local.file.read', 'local.search.files']);
    const messages = controller.getSnapshot().messages;
    expect(messages.filter((message) => message.role === 'tool')).toHaveLength(0);
    const toolBearer = messages.find((message) => (
      message.role === 'assistant' && (message.tools?.length ?? 0) >= 2
    ));
    expect(toolBearer?.tools?.map((tool) => tool.capabilityId)).toEqual([
      'local.file.read',
      'local.search.files',
    ]);
    expect(toolBearer?.segments?.map((segment) => segment.type)).toEqual([
      'tool-call',
      'tool-call',
      'text',
    ]);
    expect(messages.at(-1)?.content).toBe('done');
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
    expect(controller.restore({
      mode: 'chat',
      messages: [
        { id: 'prior-user', role: 'user', content: 'earlier' },
        { id: 'prior-assistant', role: 'assistant', content: 'answer' },
      ],
      usage: { inputTokens: 99, outputTokens: 1, totalTokens: 100 },
    })).toBe(true);

    await controller.send('fail');

    expect(controller.getSnapshot().status).toBe('idle');
    expect(controller.getSnapshot().error).toBe('provider exploded');
    expect(controller.getSnapshot().session?.lastTurn?.status).toBe('failed');
    expect(controller.getSnapshot().session?.lastTurn?.reason).toBe('provider exploded');
    expect(controller.getSnapshot().usage).toBeUndefined();
  });

  test('pins the first user task into system context for the whole run', async () => {
    const observed: Array<unknown> = [];
    const model: ChatModelPort = {
      initialize(input) {
        observed.push(input.input.systemContextInput?.taskAcceptance);
        return initialState(input.input);
      },
      async runTurn(state) {
        return { kind: 'completed', state, output: 'done' };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({ host: host(), model });
    const brief = 'IMPORTANT: flatten_rename keys must stay field names.';
    await controller.send(brief);
    await controller.send('follow up without repeating the contract');
    expect(observed).toEqual([brief, brief]);
  });

  test('compacts modelMessages while preserving UI transcript and invalidating old authority', async () => {
    let observedModelMessageCount = 0;
    let observedInputHistoryTokens = 0;
    let observedContinuityTokens = 0;
    const model: ChatModelPort = {
      async summarizeCompaction({ messages, formattedHistory }) {
        expect(messages.length).toBeGreaterThan(0);
        expect(formattedHistory).toContain('message-0');
        return 'semantic summary from the active CLI provider';
      },
      initialize(input) {
        observedInputHistoryTokens = estimateTokensFromMessages(input.input.modelMessages);
        observedContinuityTokens = estimateTokensFromMessages(
          (input.input.systemContextBlocks ?? []).map((block) => ({
            role: 'system' as const,
            content: block.content,
          })),
        );
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
        const reply = `reply-${state.modelMessages.length}-${'y'.repeat(2_000)}`;
        const completedModelMessages = [
          ...state.modelMessages,
          { role: 'assistant' as const, content: reply },
        ];
        return {
          kind: 'completed',
          state: {
            ...state,
            modelMessages: completedModelMessages,
          },
          output: reply,
        };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({
      host: host(),
      model,
      getModelKey: () => 'model-a',
      getContextWindow: () => 500_000,
    });
    expect(controller.restore({
      mode: 'chat',
      messages: [],
      modelMessages: [],
      contextAccounting: accountingSnapshot(),
    })).toBe(true);

    for (let index = 0; index < 6; index += 1) {
      await controller.send(`message-${index}-${'x'.repeat(2_000)}`);
    }
    const beforeUiCount = controller.getSnapshot().messages.length;
    const beforeModelCount = observedModelMessageCount;
    const beforeAccounting = controller.getSnapshot().contextAccounting;
    expect(beforeModelCount).toBeGreaterThan(8);
    expect(beforeAccounting).toBeDefined();

    const result = await controller.compact();
    const compactedAccounting = controller.getSnapshot().contextAccounting;

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.afterCount).toBeLessThan(result.beforeCount);
    expect(compactedAccounting?.modelKey).toBe('model-a');
    expect(compactedAccounting?.contextWindow).toBe(500_000);
    expect(compactedAccounting?.phase).toBe('post_compaction');
    expect(compactedAccounting?.compactionEpoch).toBe(
      (beforeAccounting?.compactionEpoch ?? 0) + 1,
    );
    expect(compactedAccounting?.authoritativeInputTokens).toBeNull();
    expect(compactedAccounting?.pendingUncountedChanges).toBe(true);
    // UI transcript keeps prior turns and appends one durable compact separator.
    expect(controller.getSnapshot().messages).toHaveLength(beforeUiCount + 1);
    const compactBoundary = controller.getSnapshot().messages.find(
      (message) => message.role === 'system' && message.compact?.phase === 'done',
    );
    expect(compactBoundary?.compact?.method).toBe('llm');
    expect(compactBoundary?.compact?.summary).toBe('semantic summary from the active CLI provider');
    expect(compactBoundary?.compact?.handoffContent).toContain('semantic summary from the active CLI provider');

    await controller.send('after-compact');
    expect(observedModelMessageCount).toBeLessThan(beforeModelCount + 2);
    expect(observedContinuityTokens).toBeGreaterThan(0);
    expect(observedInputHistoryTokens).toBe(0);
    // UI transcript keeps prior turns and appends the new exchange.
    expect(controller.getSnapshot().messages.length).toBeGreaterThan(beforeUiCount);
    expect(
      controller.getSnapshot().messages.some((message) => message.content === 'after-compact'),
    ).toBe(true);
  });

  
  test('compact falls back to the shared structural summary when the CLI provider fails', async () => {
    const model: ChatModelPort = {
      async summarizeCompaction() {
        throw new Error('summary provider unavailable');
      },
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
    expect(finalSystem[0]?.compact?.method).toBe('structured');
    expect(finalSystem[0]?.compact?.summary).toContain('message-0');
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

  test('restores shared compacted provider history without re-sending hidden UI history', async () => {
    let observedModelMessages: readonly ModelMessage[] = [];
    let observedContextBlocks: readonly ChatSystemContextBlock[] = [];
    const model: ChatModelPort = {
      initialize(input) {
        observedModelMessages = input.input.modelMessages;
        observedContextBlocks = input.input.systemContextBlocks ?? [];
        return initialState(input.input);
      },
      async runTurn(state) {
        return { kind: 'completed', state, output: 'continued' };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({ host: host(), model });

    expect(controller.restore({
      mode: 'chat',
      messages: [
        { id: 'old-user', role: 'user', content: 'hidden old text' },
        {
          id: 'compact',
          role: 'system',
          content: 'Earlier conversation (compacted)',
          compact: { phase: 'done', summary: 'durable decision' },
        },
        { id: 'recent-user', role: 'user', content: 'recent request' },
        { id: 'recent-assistant', role: 'assistant', content: 'recent answer' },
      ],
      modelMessages: [
        { role: 'user', content: 'recent request' },
        { role: 'assistant', content: 'recent answer' },
      ],
      continuityContext: 'durable decision',
    })).toBe(true);

    await controller.send('continue');

    expect(observedModelMessages).toEqual([
      { role: 'user', content: 'recent request' },
      { role: 'assistant', content: 'recent answer' },
    ]);
    expect(JSON.stringify(observedModelMessages)).not.toContain('hidden old text');
    expect(observedContextBlocks).toEqual([{
      id: 'conversation.compaction',
      title: 'Conversation Continuity',
      content: 'durable decision',
      layer: 'conversation',
      trust: 'continuity',
    }]);
    expect(controller.getSnapshot().messages.map((message) => message.id)).toContain('old-user');
  });

  test('keeps restored goal history IDs unique after tool-heavy turns', async () => {
    const controller = createChatController({
      host: host(),
      model: {
        initialize: (input) => initialState(input.input),
        async runTurn(state) {
          if (state.toolExecutions.length === 0) {
            return {
              kind: 'tool_calls',
              state,
              calls: [{
                toolCallId: 'call-next',
                capabilityId: 'local.file.read',
                arguments: { path: 'next.txt' },
              }],
            };
          }
          return { kind: 'completed', state, output: 'next complete' };
        },
        applyToolResults: (state, executions) => ({
          ...state,
          toolExecutions: [...state.toolExecutions, ...executions.map((item) => item.result)],
        }),
      } satisfies ChatModelPort,
    });

    expect(controller.restore({
      mode: 'goal',
      messages: [
        { id: 'user-1', role: 'user', content: 'Goal Runner tick 1' },
        {
          id: 'assistant-5',
          role: 'assistant',
          content: 'first complete',
          tools: [{
            capabilityId: 'local.file.read',
            toolName: 'read_file',
            status: 'completed',
            argumentSummary: 'first.txt',
            detail: 'first.txt',
            detailLines: ['first.txt'],
            startedAt: 1_000,
            completedAt: 1_250,
            durationMs: 250,
          }],
        },
      ],
    })).toBe(true);

    await controller.send('Goal Runner tick 2');

    const messages = controller.getSnapshot().messages;
    expect(messages.map((message) => message.id)).toEqual([
      'user-1',
      'assistant-5',
      'user-6',
      'assistant-7',
    ]);
    expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
    expect(messages[1]?.tools?.[0]).toMatchObject({
      startedAt: 1_000,
      completedAt: 1_250,
      durationMs: 250,
    });
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

  test('rebinds the runtime session and tool context when the persisted conversation changes', async () => {
    let conversationId = 'conversation-one';
    const observedConversationIds: Array<string | undefined> = [];
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      async runTurn(state) {
        if (state.toolExecutions.length === 0) {
          return {
            kind: 'tool_calls',
            state,
            calls: [{
              toolCallId: `call-${observedConversationIds.length}`,
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
      sessionId: 'tui-chat',
      getConversationId: () => conversationId,
      host: host((_capabilityId, _arguments, context) => {
        observedConversationIds.push(context?.conversationId);
        return execution('file contents');
      }),
    });

    await controller.send('first conversation');
    const first = controller.getSnapshot().session;
    conversationId = 'conversation-two';
    await controller.send('resumed conversation');
    const second = controller.getSnapshot().session;

    expect(observedConversationIds).toEqual(['conversation-one', 'conversation-two']);
    expect(first?.conversationId).toBe('conversation-one');
    expect(first?.lastTurn?.turnIndex).toBe(0);
    expect(second?.conversationId).toBe('conversation-two');
    expect(second?.lastTurn?.turnIndex).toBe(0);
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
    expect(snap.messages.some((message) => message.role === 'tool')).toBe(false);
    const assistant = [...snap.messages].reverse().find((message) => message.role === 'assistant');
    expect(assistant?.tools?.[0]?.toolCallId ?? assistant?.tool?.toolCallId).toBe('call-1');
    expect(assistant?.tools?.[0]?.arguments ?? assistant?.tool?.arguments).toEqual({ path: 'package.json' });
    // partial assistant placeholder may remain interrupted for recovery
    expect(assistant?.interrupted).toBe(true);
  });

  test('clears historical interrupted markers when the conversation continues', async () => {
    let turns = 0;
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      runTurn(state) {
        turns += 1;
        if (turns === 1) {
          throw new Error('provider_stream_error: connection reset');
        }
        return {
          kind: 'completed',
          state: {
            ...state,
            messages: [...state.messages, { id: 'assistant-2', role: 'assistant', content: 'recovered' }],
            modelMessages: [...state.modelMessages, { role: 'assistant', content: 'recovered' }],
          },
          output: 'recovered',
        };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({
      model,
      host: host(),
    });

    await controller.send('first');
    const interrupted = [...controller.getSnapshot().messages]
      .reverse()
      .find((message) => message.role === 'assistant');
    expect(interrupted?.interrupted).toBe(true);

    await controller.send('continue please');
    const snap = controller.getSnapshot();
    const historical = snap.messages.find((message) => message.id === interrupted?.id);
    expect(historical?.interrupted).toBeUndefined();
    expect(snap.messages.filter((message) => message.interrupted === true)).toHaveLength(0);
    expect(snap.messages.some((message) => message.role === 'user' && message.content === 'continue please')).toBe(true);
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
        if (message.role !== 'assistant') continue;
        const tools = message.tools && message.tools.length > 0
          ? message.tools
          : (message.tool ? [message.tool] : []);
        for (const tool of tools) statuses.push(tool.status);
      }
    });

    const pending = controller.send('list files');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statuses).toContain('running');
    const runningMessage = controller.getSnapshot().messages.find((message) => (
      message.role === 'assistant'
      && ((message.tools?.some((tool) => tool.status === 'running')) || message.tool?.status === 'running')
    ));
    expect(runningMessage?.tools?.[0]?.status ?? runningMessage?.tool?.status).toBe('running');
    const runningId = runningMessage?.id;
    release?.();
    await pending;
    const completedMessage = controller.getSnapshot().messages.find((message) => message.id === runningId);
    expect(completedMessage?.tools?.[0]?.status ?? completedMessage?.tool?.status).toBe('completed');
    expect(statuses[0]).toBe('running');
  });

  test('publishes a draft plan after a completed Goal turn', async () => {
    const planJson: RuntimePlan = {
      planId: 'goal-plan-1',
      title: 'Ship goal mode',
      goal: 'Make Goal create a visible draft plan first.',
      tasks: [{ taskId: 'draft', title: 'Publish a draft plan' }],
      successCriteria: [{ description: 'Approval panel appears' }],
    };
    const created: RuntimePlan[] = [];
    const planCoordinator = createPlanCoordinator({
      sessionId: 'goal-session',
      goalExecution: {
        create(request) {
          created.push(request.plan);
        },
      },
    });
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      async runTurn(state) {
        return {
          kind: 'completed',
          state,
          output: `Here is the plan:\n\`\`\`json\n${JSON.stringify(planJson)}\n\`\`\``,
        };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({
      host: host(),
      initialMode: 'goal',
      model,
      planCoordinator,
    });

    await controller.send('enable goal mode');

    const planSnapshot = planCoordinator.getSnapshot();
    expect(planSnapshot?.status).toBe('awaiting_approval');
    expect(planSnapshot?.plan.planId).toBe('goal-plan-1');
    expect(controller.getSnapshot().plan?.status).toBe('awaiting_approval');

    expect(await planCoordinator.decide('goal-plan-1', 'approve')).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]?.planId).toBe('goal-plan-1');
    expect(planCoordinator.getSnapshot()?.status).toBe('goal_created');
  });

  test('still publishes a draft plan after a completed Plan turn', async () => {
    const planJson: RuntimePlan = {
      planId: 'plan-turn-1',
      title: 'Plan only',
      goal: 'Keep plan publish working.',
      tasks: [{ taskId: 'inspect', title: 'Inspect' }],
      successCriteria: [{ description: 'Draft appears' }],
    };
    const planCoordinator = createPlanCoordinator({
      sessionId: 'plan-session',
      goalExecution: { create: () => {} },
    });
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      async runTurn(state) {
        return { kind: 'completed', state, output: JSON.stringify(planJson) };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({
      host: host(),
      initialMode: 'plan',
      model,
      planCoordinator,
    });

    await controller.send('make a plan');
    expect(planCoordinator.getSnapshot()?.status).toBe('awaiting_approval');
    expect(planCoordinator.getSnapshot()?.plan.title).toBe('Plan only');
  });

  test('marks the current request pending while the provider turn is running', async () => {
    let releaseTurn!: () => void;
    const turnPending = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      async runTurn(state) {
        await turnPending;
        return {
          kind: 'completed',
          state: {
            ...state,
            usage: { inputTokens: 2_000 },
            contextAccounting: accountingSnapshot({
              modelKey: 'pending-test',
              contextWindow: 100_000,
              inputBudget: 100_000,
              compactionThresholdTokens: 80_000,
              authoritativeInputTokens: 2_000,
              percent: 2,
            }),
          },
          output: 'done',
        };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({
      host: host(),
      model,
      getContextWindow: () => 100_000,
    });
    expect(controller.restore({
      mode: 'chat',
      messages: [{ id: 'old-user', role: 'user', content: 'existing context' }],
      modelMessages: [{ role: 'user', content: 'existing context' }],
      usage: { inputTokens: 1_000 },
      contextAccounting: accountingSnapshot({
        modelKey: 'pending-test',
        contextWindow: 100_000,
        inputBudget: 100_000,
        compactionThresholdTokens: 80_000,
        authoritativeInputTokens: 1_000,
        percent: 1,
      }),
    })).toBe(true);

    const pending = controller.send('new message increases the projected request');
    const running = controller.getSnapshot();
    expect(running.status).toBe('running');
    expect(running.usage?.inputTokens).toBe(1_000);
    expect(running.contextAccounting?.authoritativeInputTokens).toBe(1_000);
    expect(running.contextAccounting?.modelKey).toBe('pending-test');
    expect(running.contextAccounting?.pendingUncountedChanges).toBe(true);
    expect(running.contextAccounting?.pendingContentChars).toBeGreaterThan(0);

    releaseTurn();
    await pending;
  });

  test('does not estimate restored System Context without provider authority', () => {
    const systemContent = 'shared-system-context '.repeat(400);
    const model: ChatModelPort = {
      projectSystemMessages: () => [{ role: 'system', content: systemContent }],
      initialize: (input) => initialState(input.input),
      async runTurn(state) {
        return { kind: 'completed', state, output: 'done' };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({
      host: host(),
      model,
      getContextWindow: () => 100_000,
    });

    expect(controller.restore({
      mode: 'chat',
      messages: [{ id: 'user-1', role: 'user', content: 'restored' }],
      modelMessages: [{ role: 'user', content: 'restored' }],
    })).toBe(true);

    expect(controller.getSnapshot().contextAccounting).toBeUndefined();
  });

  test('publishes provider-backed accounting as the authoritative context value', async () => {
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      async runTurn(state) {
        const usageAccounting = createRuntimeUsageAccounting();
        usageAccounting.observeProviderRequest({ inputTokens: 1_200, cacheReadTokens: 300 });
        return {
          kind: 'completed',
          state: {
            ...state,
            usage: { inputTokens: 1_200, cacheReadTokens: 300 },
            usageAccounting,
            contextAccounting: accountingSnapshot({
              contextWindow: 100_000,
              inputBudget: 100_000,
              compactionThresholdTokens: 80_000,
              authoritativeInputTokens: 1_500,
              percent: 2,
            }),
          },
          output: 'done',
        };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({
      host: host(),
      model,
      getContextWindow: () => 100_000,
    });

    await controller.send('hello pressure');
    const snapshot = controller.getSnapshot();
    expect(snapshot.usage?.inputTokens).toBe(1_200);
    expect(snapshot.lastRequestUsage).toMatchObject({
      usageScope: 'provider_request',
      inputTokens: 1_200,
      cacheReadTokens: 300,
    });
    expect(snapshot.contextAccounting?.authoritativeInputTokens).toBe(1_500);
    expect(snapshot.contextAccounting?.pressureSource).toBe('provider_usage');
  });

  test('does not run a renderer-local heuristic compaction from message size', async () => {
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
            usage: { inputTokens: 90_000 },
          },
          output: `reply-${state.modelMessages.length}`,
        };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({
      host: host(),
      model,
      getContextWindow: () => 100_000,
    });

    await controller.send(`pressure ${'y'.repeat(320_000)}`);
    expect(
      controller.getSnapshot().messages.some((message) =>
        message.role === 'system'
        && typeof message.content === 'string'
        && message.content.includes('compacted'),
      ),
    ).toBe(false);
  });

  test('manual compact publishes full progress frames and compacting footer status', async () => {
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
            usage: { inputTokens: 90_000 },
          },
          output: `reply-${state.modelMessages.length}`,
        };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({
      host: host(),
      model,
      getContextWindow: () => 100_000,
    });

    // Seed transcript so structural compact has content without crossing the threshold yet.
    for (let index = 0; index < 12; index += 1) {
      await controller.send(`seed-${index} ${'x'.repeat(200)}`);
    }

    const statuses: string[] = [];
    const progressPercents: number[] = [];
    const progressContents: string[] = [];
    const dockLabels: string[] = [];
    const unsubscribe = controller.subscribe((snapshot) => {
      statuses.push(snapshot.status);
      const latestPercent = latestCompactProgressPercent(snapshot.messages);
      if (snapshot.status === 'compacting' && typeof latestPercent === 'number') {
        dockLabels.push(formatCompactingStatusLabel({
          label: '压缩中…',
          percent: latestPercent,
        }));
      }
      for (const message of snapshot.messages) {
        if (message.compact?.phase === 'progress' && typeof message.compact.percent === 'number') {
          progressPercents.push(message.compact.percent);
          if (typeof message.content === 'string') progressContents.push(message.content);
        }
      }
    });

    const compactResult = await controller.compact();
    unsubscribe();

    expect(compactResult.compacted).toBe(true);
    expect(statuses).toContain('compacting');
    // Soft stage floors from COMPACTION_PROGRESS_CONFIG (no LLM stream in this structural path).
    expect(progressPercents).toContain(8);
    expect(progressPercents).toContain(15);
    expect(progressPercents).toContain(99);
    // Progress bar must appear only in the composer status dock, not in the
    // system transcript marker (avoids the double-bar compacting UI).
    expect(progressContents.every((content) => !content.includes('['))).toBe(true);
    expect(progressContents.every((content) => !content.includes('%'))).toBe(true);
    expect(progressContents.some((content) => /compacting context/i.test(content))).toBe(true);
    expect(dockLabels.some((label) => label.includes(renderCompactProgressBar(15)) && label.includes('15%'))).toBe(true);
    expect(controller.getSnapshot().status).toBe('idle');
    expect(
      controller.getSnapshot().messages.some((message) =>
        message.role === 'system'
        && typeof message.content === 'string'
        && message.content.includes('Compacted'),
      ),
    ).toBe(true);
  });
});


describe('compact progress presentation helpers', () => {
  test('renderCompactProgressBar clamps and fills by percent', () => {
    expect(renderCompactProgressBar(0, 10)).toBe('[░░░░░░░░░░]');
    expect(renderCompactProgressBar(50, 10)).toBe('[█████░░░░░]');
    expect(renderCompactProgressBar(100, 10)).toBe('[██████████]');
    expect(renderCompactProgressBar(150, 4)).toBe('[████]');
  });

  test('latestCompactProgressPercent reads the newest progress frame only', () => {
    expect(latestCompactProgressPercent([])).toBeUndefined();
    expect(
      latestCompactProgressPercent([
        {
          id: 'done',
          role: 'system',
          content: 'done',
          compact: { phase: 'done', percent: 100 },
        },
      ]),
    ).toBeUndefined();
    expect(
      latestCompactProgressPercent([
        {
          id: 'p1',
          role: 'system',
          content: 'a',
          compact: { phase: 'progress', percent: 12 },
        },
        {
          id: 'user',
          role: 'user',
          content: 'hi',
        },
        {
          id: 'p2',
          role: 'system',
          content: 'b',
          compact: { phase: 'progress', percent: 78 },
        },
      ]),
    ).toBe(78);
  });

  test('formatCompactingStatusLabel includes bar + percent when available', () => {
    expect(formatCompactingStatusLabel({ label: '压缩中…' })).toBe('压缩中…');
    expect(formatCompactingStatusLabel({ label: '压缩中…', percent: 48 })).toBe(
      `压缩中… ${renderCompactProgressBar(48)} 48%`,
    );
  });
});
