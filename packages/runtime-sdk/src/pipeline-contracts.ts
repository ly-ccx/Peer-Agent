import type {
  RuntimeSdkEvent,
  RuntimeSdkEventInput,
  RuntimeSdkToolResult,
} from './contracts.ts';

export type RuntimePipelineStatus =
  | 'completed'
  | 'stopped'
  | 'cancelled'
  | 'exhausted'
  | 'failed';

export interface RuntimePipelineRunInput<TInput = unknown> {
  readonly sessionId: string;
  readonly streamId?: string;
  readonly conversationId?: string;
  readonly mode?: string;
  readonly providerId?: string;
  readonly model?: string;
  readonly input: TInput;
  readonly maxTurns?: number;
}

export interface RuntimePipelineToolCall<TPayload = unknown> {
  readonly toolCallId: string;
  readonly capabilityId?: string;
  readonly name?: string;
  readonly arguments?: unknown;
  readonly payload?: TPayload;
}

export interface RuntimePipelineToolExecution<
  TCall extends RuntimePipelineToolCall = RuntimePipelineToolCall,
  TResult = RuntimeSdkToolResult,
> {
  readonly call: TCall;
  readonly result: TResult;
  readonly terminal?: boolean;
  readonly terminalReason?: string;
}

export interface RuntimePipelineTurnContext<TInput = unknown> {
  readonly run: RuntimePipelineRunInput<TInput>;
  readonly turn: number;
  readonly signal?: AbortSignal;
  readonly emit: (event: RuntimeSdkEventInput) => RuntimeSdkEvent | null;
}

export interface RuntimePipelineContinueTurn<TState> {
  readonly kind: 'continue';
  readonly state: TState;
}

export interface RuntimePipelineCompletedTurn<TState, TOutput = unknown> {
  readonly kind: 'completed';
  readonly state: TState;
  readonly output?: TOutput;
  readonly reason?: string;
}

export interface RuntimePipelineToolCallsTurn<
  TState,
  TCall extends RuntimePipelineToolCall = RuntimePipelineToolCall,
> {
  readonly kind: 'tool_calls';
  readonly state: TState;
  readonly calls: readonly TCall[];
}

export type RuntimePipelineTurnResult<
  TState,
  TCall extends RuntimePipelineToolCall = RuntimePipelineToolCall,
  TOutput = unknown,
> =
  | RuntimePipelineContinueTurn<TState>
  | RuntimePipelineCompletedTurn<TState, TOutput>
  | RuntimePipelineToolCallsTurn<TState, TCall>;

export interface RuntimePipelineModelAdapter<
  TInput = unknown,
  TState = unknown,
  TCall extends RuntimePipelineToolCall = RuntimePipelineToolCall,
  TToolResult = RuntimeSdkToolResult,
  TOutput = unknown,
> {
  initialize(
    input: RuntimePipelineRunInput<TInput>,
    context: RuntimePipelineTurnContext<TInput>,
  ): TState | Promise<TState>;
  runTurn(
    state: TState,
    context: RuntimePipelineTurnContext<TInput>,
  ): RuntimePipelineTurnResult<TState, TCall, TOutput>
    | Promise<RuntimePipelineTurnResult<TState, TCall, TOutput>>;
  applyToolResults(
    state: TState,
    executions: readonly RuntimePipelineToolExecution<TCall, TToolResult>[],
    context: RuntimePipelineTurnContext<TInput>,
  ): TState | Promise<TState>;
  onCompleted?(
    state: TState,
    output: TOutput | undefined,
    context: RuntimePipelineTurnContext<TInput>,
  ): void | Promise<void>;
  onStopped?(
    state: TState,
    executions: readonly RuntimePipelineToolExecution<TCall, TToolResult>[],
    context: RuntimePipelineTurnContext<TInput>,
  ): void | Promise<void>;
  onCancelled?(
    state: TState | undefined,
    context: RuntimePipelineTurnContext<TInput>,
  ): void | Promise<void>;
  onExhausted?(
    state: TState,
    context: RuntimePipelineTurnContext<TInput>,
  ): void | Promise<void>;
}

export interface RuntimePipelineToolExecutor<
  TInput = unknown,
  TCall extends RuntimePipelineToolCall = RuntimePipelineToolCall,
  TToolResult = RuntimeSdkToolResult,
> {
  execute(
    call: TCall,
    context: RuntimePipelineTurnContext<TInput> & { readonly index: number },
  ): RuntimePipelineToolExecution<TCall, TToolResult>
    | Promise<RuntimePipelineToolExecution<TCall, TToolResult>>;
}

export interface RuntimePipelineEventSink {
  emit(event: RuntimeSdkEventInput): RuntimeSdkEvent | null;
}

/**
 * Observes stable Runtime Pipeline state transitions after the model adapter
 * has committed them. Hosts use this seam for projections and presentation;
 * observer failures never change pipeline execution.
 */
export interface RuntimePipelineLifecycleObserver<
  TInput = unknown,
  TState = unknown,
  TCall extends RuntimePipelineToolCall = RuntimePipelineToolCall,
  TToolResult = RuntimeSdkToolResult,
> {
  toolResultsApplied?(
    state: TState,
    executions: readonly RuntimePipelineToolExecution<TCall, TToolResult>[],
    context: RuntimePipelineTurnContext<TInput>,
  ): void | Promise<void>;
}

export interface RuntimePipelineOptions<
  TInput = unknown,
  TState = unknown,
  TCall extends RuntimePipelineToolCall = RuntimePipelineToolCall,
  TToolResult = RuntimeSdkToolResult,
  TOutput = unknown,
> {
  readonly model: RuntimePipelineModelAdapter<TInput, TState, TCall, TToolResult, TOutput>;
  readonly tools: RuntimePipelineToolExecutor<TInput, TCall, TToolResult>;
  readonly events?: RuntimePipelineEventSink;
  readonly lifecycle?: RuntimePipelineLifecycleObserver<TInput, TState, TCall, TToolResult>;
  readonly defaultMaxTurns?: number;
}

export interface RuntimePipelineRunResult<
  TState = unknown,
  TOutput = unknown,
> {
  readonly status: RuntimePipelineStatus;
  readonly state?: TState;
  readonly output?: TOutput;
  readonly turns: number;
  readonly toolCalls: number;
  readonly reason?: string;
}

export interface RuntimePipeline<
  TInput = unknown,
  TState = unknown,
  TOutput = unknown,
> {
  run(
    input: RuntimePipelineRunInput<TInput>,
    context?: { readonly signal?: AbortSignal },
  ): Promise<RuntimePipelineRunResult<TState, TOutput>>;
}
