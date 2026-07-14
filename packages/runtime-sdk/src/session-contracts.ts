export type RuntimeSessionStatus = 'idle' | 'running';
export type RuntimeTurnStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface RuntimeSessionTurnSnapshot {
  readonly turnId: string;
  readonly turnIndex: number;
  readonly streamId?: string;
  readonly status: RuntimeTurnStatus;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly reason?: string;
}

export interface RuntimeSessionSnapshot {
  readonly sessionId: string;
  readonly conversationId?: string;
  readonly status: RuntimeSessionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextTurnIndex: number;
  readonly activeTurn?: RuntimeSessionTurnSnapshot;
  readonly lastTurn?: RuntimeSessionTurnSnapshot;
}

export interface RuntimeSessionStartOptions {
  readonly sessionId: string;
  readonly conversationId?: string;
  readonly streamId?: string;
  readonly signal?: AbortSignal;
}

export interface RuntimeSessionResumeOptions {
  readonly sessionId: string;
  readonly streamId?: string;
  readonly signal?: AbortSignal;
}

export interface RuntimeSessionTurnHandle {
  readonly sessionId: string;
  readonly conversationId?: string;
  readonly turnId: string;
  readonly turnIndex: number;
  readonly streamId?: string;
  readonly signal: AbortSignal;
  complete(): RuntimeSessionSnapshot;
  fail(reason?: string): RuntimeSessionSnapshot;
  cancel(reason?: string): RuntimeSessionSnapshot;
  snapshot(): RuntimeSessionSnapshot;
}

export interface RuntimeSessionControllerOptions {
  readonly createTurnId?: (sessionId: string, turnIndex: number) => string;
  readonly now?: () => string;
  readonly onChange?: (snapshot: RuntimeSessionSnapshot) => void;
}

export interface RuntimeSessionController {
  start(options: RuntimeSessionStartOptions): RuntimeSessionTurnHandle;
  resume(options: RuntimeSessionResumeOptions): RuntimeSessionTurnHandle;
  cancel(sessionId: string, reason?: string): RuntimeSessionSnapshot | null;
  get(sessionId: string): RuntimeSessionSnapshot | null;
  list(): readonly RuntimeSessionSnapshot[];
  delete(sessionId: string): boolean;
}
