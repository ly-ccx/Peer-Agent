import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { RuntimeSdkProviderExecution } from '@peer-agent/runtime-sdk';

import type { ChatModelPort, ChatModelState } from './chat-controller.ts';
import { createTuiGoalWorkerAdapter } from './goal-worker-adapter.ts';
import { createTuiHost, type TuiExecutionContext, type TuiHost } from './tui-host.ts';

function stateFromInput(input: { input: any }): ChatModelState {
  return {
    messages: [{ id: 'input', role: 'user', content: input.input.content }],
    modelMessages: [{ role: 'user', content: input.input.content }],
    toolExecutions: [],
  };
}

function execution(toolCallId: string, capabilityId: string): RuntimeSdkProviderExecution {
  return {
    result: {
      toolCallId,
      capabilityId,
      status: 'completed',
      output: { matches: [{ path: 'src/example.ts', line: 1 }] },
      outputPreview: { matches: [{ path: 'src/example.ts', line: 1 }] },
    },
  };
}

function fakeHost(observed: TuiExecutionContext[]): TuiHost {
  return {
    workspaceRoot: '/tmp/peer-goal-worker-test',
    capabilities: ['local.file.search'],
    toolDefinitions: [{ name: 'search_files', capabilityId: 'local.file.search' }],
    getAccessLevel: () => 'ask_before_local',
    setAccessLevel: () => 'ask_before_local',
    capabilitiesForMode: () => ['local.file.search'],
    toolDefinitionsForMode: () => [{ name: 'search_files', capabilityId: 'local.file.search' }],
    execute: async (capabilityId, _arguments, context) => {
      if (context) observed.push(context);
      return execution(context?.turnId ?? 'tool-call', capabilityId);
    },
    executeRead: async () => execution('read', 'local.file.read'),
    executeShell: async () => execution('shell', 'local.shell.exec'),
    subscribe: () => () => {},
    subscribeApproval: (listener) => {
      listener(null);
      return () => {};
    },
    dispose: async () => {},
  };
}

function explorerModel(observedInputs: Record<string, unknown>[]): ChatModelPort {
  return {
    initialize(input) {
      observedInputs.push(input.input.systemContextInput ?? {});
      return stateFromInput(input);
    },
    runTurn(state, context) {
      if (state.toolExecutions.length === 0) {
        return {
          kind: 'tool_calls',
          state,
          calls: [{
            toolCallId: 'search-call',
            capabilityId: 'local.file.search',
            arguments: { query: 'capability', path: 'src' },
          }],
        };
      }
      const evidenceRef = `tool-result://${state.toolExecutions[0]!.result.toolCallId}`;
      return {
        kind: 'completed',
        state,
        output: JSON.stringify({
          summary: 'Found the projection.',
          findings: [{ summary: 'Defined in src/example.ts', evidenceRefs: [evidenceRef] }],
          evidenceRefs: [evidenceRef],
          confidence: 'high',
        }),
      };
    },
    applyToolResults(state, executions) {
      return {
        ...state,
        toolExecutions: [...state.toolExecutions, ...executions.map((item) => item.result)],
      };
    },
  };
}

describe('TUI Goal worker adapter', () => {
  test('runs Explorer in an isolated explorer-mode pipeline with shared context sources and real Evidence', async () => {
    const observedContexts: TuiExecutionContext[] = [];
    const observedInputs: Record<string, unknown>[] = [];
    const worker = createTuiGoalWorkerAdapter({
      model: explorerModel(observedInputs),
      host: fakeHost(observedContexts),
      idFactory: () => 'worker-id',
    });

    const report = await worker.runExplorer({
      planId: 'plan-1',
      plan: { planId: 'plan-1', title: 'Parity', tasks: [] },
      explorer: {
        explorerId: 'explorer-1',
        request: {
          question: 'Where is the capability projected?',
          reason: 'Need evidence',
          scope: { include: ['src'], exclude: ['dist'] },
        },
      },
    });

    expect(observedContexts).toHaveLength(1);
    expect(observedContexts[0]?.mode).toBe('explorer');
    expect(observedContexts[0]?.sessionId).toBe('tui-worker:explorer-1');
    expect(observedInputs).toHaveLength(1);
    expect(observedInputs[0]?.explorerContext).toMatchObject({
      explorerId: 'explorer-1',
      planId: 'plan-1',
    });
    expect(observedInputs[0]?.continuityContext).toBeUndefined();
    expect(report).toMatchObject({
      status: 'completed',
      summary: 'Found the projection.',
      evidenceRefs: ['tool-result://explorer-1'],
      toolEvidenceRefs: ['tool-result://explorer-1'],
      confidence: 'high',
      toolCallCount: 1,
    });
  });

  test('does not accept model-invented Evidence when no governed tool ran', async () => {
    const model: ChatModelPort = {
      initialize: stateFromInput,
      runTurn(state) {
        return {
          kind: 'completed',
          state,
          output: JSON.stringify({
            summary: 'Claimed success',
            evidenceRefs: ['tool-result://invented'],
          }),
        };
      },
      applyToolResults(state) { return state; },
    };
    const worker = createTuiGoalWorkerAdapter({ model, host: fakeHost([]) });
    await expect(worker.runExplorer({
      planId: 'plan-2',
      plan: { planId: 'plan-2' },
      explorer: { explorerId: 'explorer-2', request: { question: 'Check' } },
    })).rejects.toThrow('explorer_completed_without_tool_evidence');
  });

  test('reuses explorer projection so shell calls are denied by the real TUI host', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-goal-worker-projection-'));
    try {
      const host = createTuiHost({ workspaceRoot, accessLevel: 'full_local' });
      let deniedStatus = '';
      const model: ChatModelPort = {
        initialize: stateFromInput,
        runTurn(state) {
          if (state.toolExecutions.length === 0) {
            return {
              kind: 'tool_calls',
              state,
              calls: [{
                toolCallId: 'shell-call',
                capabilityId: 'local.shell.exec',
                arguments: { command: 'touch should-not-exist' },
              }],
            };
          }
          deniedStatus = state.toolExecutions[0]!.result.status ?? '';
          return {
            kind: 'completed',
            state,
            output: JSON.stringify({
              summary: 'Shell was blocked.',
              findings: [],
              evidenceRefs: ['tool-result://shell-call'],
              confidence: 'high',
            }),
          };
        },
        applyToolResults(state, executions) {
          return {
            ...state,
            toolExecutions: [...state.toolExecutions, ...executions.map((item) => item.result)],
          };
        },
      };
      const worker = createTuiGoalWorkerAdapter({ model, host });
      const report = await worker.runExplorer({
        planId: 'plan-3',
        plan: { planId: 'plan-3' },
        explorer: { explorerId: 'explorer-3', request: { question: 'Try shell' } },
      });
      expect(deniedStatus).toBe('denied');
      expect(report.evidenceRefs).toHaveLength(1);
      expect(report.evidenceRefs[0]).toMatch(/^tool-result:\/\/tui-tool-/);
      expect(await Bun.file(path.join(workspaceRoot, 'should-not-exist')).exists()).toBe(false);
      await host.dispose();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('requires real Evidence before a Verifier can pass', async () => {
    const observedInputs: Record<string, unknown>[] = [];
    const model = explorerModel(observedInputs);
    const worker = createTuiGoalWorkerAdapter({ model, host: fakeHost([]) });
    const report = await worker.runVerifier({
      planId: 'plan-4',
      verifierRunId: 'verifier-4',
      plan: {
        planId: 'plan-4',
        title: 'Verify parity',
        tasks: [{ taskId: 'task-1', title: 'Done', status: 'completed', evidenceRefs: ['tool-result://prior'] }],
        successCriteria: [],
      },
    });
    expect(report.evidenceRefs).toContain('tool-result://verifier-4');
    expect(report.passed).toBe(false);
    expect(report.toolCallCount).toBe(1);
    expect(observedInputs[0]?.verifierContext).toMatchObject({
      verifierRunId: 'verifier-4',
      planId: 'plan-4',
    });
    expect(observedInputs[0]?.continuityContext).toBeUndefined();
  });
});
