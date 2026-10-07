import { isParallelSafeLocalToolBatch } from '@peer-agent/runtime-core';

import type {
  RuntimePipeline,
  RuntimePipelineOptions,
  RuntimePipelineRunInput,
  RuntimePipelineRunResult,
  RuntimePipelineToolCall,
  RuntimePipelineToolExecution,
  RuntimePipelineTurnContext,
} from './pipeline-contracts.ts';

const DEFAULT_MAX_TURNS = 64;

function normalizeMaxTurns(value: number | undefined, fallback: number): number {
  if (value === Number.POSITIVE_INFINITY) return value;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value as number));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error || 'runtime_pipeline_error');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('Aborted');
    error.name = 'AbortError';
    throw error;
  }
}

export function createRuntimePipeline<
  TInput = unknown,
  TState = unknown,
  TCall extends RuntimePipelineToolCall = RuntimePipelineToolCall,
  TToolResult = unknown,
  TOutput = unknown,
>(
  options: RuntimePipelineOptions<TInput, TState, TCall, TToolResult, TOutput>,
): RuntimePipeline<TInput, TState, TOutput> {
  if (!options?.model) throw new Error('RuntimePipeline requires a model adapter.');
  if (!options?.tools) throw new Error('RuntimePipeline requires a tool executor.');

  const defaultMaxTurns = normalizeMaxTurns(options.defaultMaxTurns, DEFAULT_MAX_TURNS);

  return {
    async run(
      input: RuntimePipelineRunInput<TInput>,
      context: { readonly signal?: AbortSignal } = {},
    ): Promise<RuntimePipelineRunResult<TState, TOutput>> {
      if (!input?.sessionId) throw new Error('RuntimePipeline run requires sessionId.');

      const signal = context.signal;
      const maxTurns = normalizeMaxTurns(input.maxTurns, defaultMaxTurns);
      const maxToolCalls = Number.isFinite(input.maxToolCalls)
        ? Math.max(0, Math.floor(input.maxToolCalls!)) : Number.POSITIVE_INFINITY;
      const sliceToolCalls = Number.isFinite(input.sliceToolCalls) ? Math.max(1, input.sliceToolCalls!) : Infinity;
      const maxBatch = Number.isFinite(input.maxToolBatchCalls) ? Math.max(1, input.maxToolBatchCalls!) : Infinity;
      let state: TState | undefined;
      let turns = 0;
      let toolCalls = 0;

      const emit = (event: Parameters<NonNullable<typeof options.events>['emit']>[0]) => {
        try {
          return options.events?.emit(event) ?? null;
        } catch {
          return null;
        }
      };

      const eventBase = {
        sessionId: input.sessionId,
        ...(input.streamId ? { streamId: input.streamId } : {}),
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      };
      const turnContext = (turn: number): RuntimePipelineTurnContext<TInput> => ({
        run: input,
        turn,
        signal,
        emit,
      });
      const exhaust = async (reason: 'max_turns_exceeded' | 'max_tool_calls_exceeded') => {
        await options.model.onExhausted?.(state as TState, turnContext(turns), reason);
        emit({ type: 'runtime.error', ...eventBase, code: reason, message: reason });
        return { status: 'exhausted' as const, state, turns, toolCalls, reason };
      };

      const yieldRun = async () => {
        await options.model.onYield?.(state as TState, turnContext(turns));
        return { status: 'yielded' as const, state, turns, toolCalls, reason: 'scheduling_slice' };
      };
      try {
        throwIfAborted(signal);
        emit({
          type: 'session.started',
          ...eventBase,
          ...(input.mode ? { mode: input.mode } : {}),
          ...(input.providerId ? { providerId: input.providerId } : {}),
          ...(input.model ? { model: input.model } : {}),
        });
        state = await options.model.initialize(input, turnContext(0));

        for (let turn = 0; turn < maxTurns; turn += 1) {
          throwIfAborted(signal);
          turns = turn + 1;
          const currentContext = turnContext(turn);
          const outcome = await options.model.runTurn(state, currentContext);
          state = outcome.state;

          if (outcome.kind === 'continue') continue;

          if (outcome.kind === 'completed') {
            await options.model.onCompleted?.(state, outcome.output, currentContext);
            if (input.streamId) {
              emit({
                type: 'message.completed',
                ...eventBase,
                streamId: input.streamId,
                ...(outcome.reason ? { finishReason: outcome.reason } : {}),
              });
            }
            return {
              status: 'completed',
              state,
              output: outcome.output,
              turns,
              toolCalls,
              ...(outcome.reason ? { reason: outcome.reason } : {}),
            };
          }

          // Reserve the whole batch before dispatch. Never execute a partial
          // write batch or exceed a caller's remaining budget inside one turn.
          if (outcome.calls.length > maxBatch) throw new Error('tool_batch_too_large');
          if (toolCalls + outcome.calls.length > maxToolCalls) {
            if (options.tools.notExecuted) {
              const denied = await Promise.all(outcome.calls.map(call => options.tools.notExecuted!(call, 'max_tool_calls_exceeded')));
              state = await options.model.applyToolResults(state, denied, currentContext);
            }
            return await exhaust('max_tool_calls_exceeded');
          }
          const executions: RuntimePipelineToolExecution<TCall, TToolResult>[] = [];
          if (isParallelSafeLocalToolBatch(outcome.calls)) {
            const batch = await Promise.all(outcome.calls.map(async (call, index) => {
              if (signal?.aborted && options.tools.notExecuted) return options.tools.notExecuted(call, 'cancelled');
              throwIfAborted(signal);
              try { return await options.tools.execute(call, { ...currentContext, index }); }
              catch (error) { if (!options.tools.notExecuted) throw error; return options.tools.notExecuted(call, isAbortError(error) ? 'cancelled_outcome_unknown' : 'execution_outcome_unknown'); }
            }));
            executions.push(...batch);
            toolCalls += batch.length;
          } else {
            for (const [index, call] of outcome.calls.entries()) {
              let execution;
              if (signal?.aborted && options.tools.notExecuted) execution = await options.tools.notExecuted(call, 'cancelled');
              else {
                throwIfAborted(signal);
                try { execution = await options.tools.execute(call, { ...currentContext, index }); }
                catch (error) { if (!options.tools.notExecuted) throw error; execution = await options.tools.notExecuted(call, isAbortError(error) ? 'cancelled_outcome_unknown' : 'execution_outcome_unknown'); }
              }
              executions.push(execution);
              toolCalls += 1;
              if (execution.terminal && options.tools.notExecuted) {
                for (const remaining of outcome.calls.slice(index + 1)) executions.push(await options.tools.notExecuted(remaining, 'batch_stopped'));
                break;
              }
            }
          }

          state = await options.model.applyToolResults(state, executions, currentContext);
          throwIfAborted(signal);
          try {
            await options.lifecycle?.toolResultsApplied?.(state, executions, currentContext);
          } catch {
            // Lifecycle observers publish projections/presentation only. Their
            // failure must not change model or tool execution semantics.
          }
          const terminalExecution = executions.find((execution) => execution.terminal);
          if (terminalExecution) {
            await options.model.onStopped?.(state, executions, currentContext);
            if (input.streamId) {
              emit({
                type: 'message.completed',
                ...eventBase,
                streamId: input.streamId,
                finishReason: terminalExecution.terminalReason || 'tool_requested_stop',
              });
            }
            return {
              status: 'stopped',
              state,
              turns,
              toolCalls,
              reason: terminalExecution.terminalReason || 'tool_requested_stop',
            };
          }
          if (toolCalls >= sliceToolCalls) return await yieldRun();
        }

        return input.yieldAtTurnLimit ? await yieldRun() : await exhaust('max_turns_exceeded');
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          const cancelledContext = turnContext(turns);
          await options.model.onCancelled?.(state, cancelledContext);
          return {
            status: 'cancelled',
            state,
            turns,
            toolCalls,
            reason: 'aborted',
          };
        }

        const detail = errorMessage(error);
        emit({
          type: 'runtime.error',
          ...eventBase,
          code: 'runtime_pipeline_error',
          message: detail,
        });
        // Preserve partial state (already-executed tools / model messages) so
        // hosts can recover instead of discarding progress on provider stream errors.
        return {
          status: 'failed',
          state,
          turns,
          toolCalls,
          reason: detail,
        };
      }
    },
  };
}
