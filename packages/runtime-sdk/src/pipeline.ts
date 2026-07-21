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

          const executions: RuntimePipelineToolExecution<TCall, TToolResult>[] = [];
          for (const [index, call] of outcome.calls.entries()) {
            throwIfAborted(signal);
            const execution = await options.tools.execute(call, {
              ...currentContext,
              index,
            });
            executions.push(execution);
            toolCalls += 1;
          }

          state = await options.model.applyToolResults(state, executions, currentContext);
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
        }

        const exhaustedContext = turnContext(turns);
        await options.model.onExhausted?.(state as TState, exhaustedContext);
        const exhaustedReason = 'max_turns_exceeded';
        emit({
          type: 'runtime.error',
          ...eventBase,
          code: exhaustedReason,
          message: exhaustedReason,
        });
        return {
          status: 'exhausted',
          state,
          turns,
          toolCalls,
          reason: exhaustedReason,
        };
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
