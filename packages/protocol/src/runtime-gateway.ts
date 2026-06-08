import type {
  ClientSessionState,
  ClientToolCall,
  ClientToolResultReport,
  RuntimeProjection,
} from './index.ts';

export type RuntimeGatewayEventType =
  | 'client.hello'
  | 'runtime.resume'
  | 'runtime.heartbeat'
  | 'runtime.projection_published'
  | 'client_tool_call.request'
  | 'client_tool_call.ack'
  | 'client_tool_call.result'
  | 'runtime.error';

export interface RuntimeGatewayEventBase {
  readonly type: RuntimeGatewayEventType;
  readonly eventId: string;
  readonly sessionId: string;
  readonly seq?: number;
}

export interface RuntimeClientHello extends RuntimeGatewayEventBase {
  readonly type: 'client.hello';
  readonly session: ClientSessionState;
  readonly projection: RuntimeProjection;
  readonly client: {
    readonly name: 'zeus-atlas-desktop';
    readonly version: string;
    readonly platform: string;
    readonly locale: string;
  };
  readonly sentAt: string;
}

export interface RuntimeResume extends RuntimeGatewayEventBase {
  readonly type: 'runtime.resume';
  readonly projectionId?: string;
  readonly lastAckSeq?: number;
  readonly pendingResultCount: number;
  readonly sentAt: string;
}

export interface RuntimeHeartbeat extends RuntimeGatewayEventBase {
  readonly type: 'runtime.heartbeat';
  readonly projectionId?: string;
  readonly sentAt: string;
}

export interface RuntimeProjectionPublished extends RuntimeGatewayEventBase {
  readonly type: 'runtime.projection_published';
  readonly projectionId: string;
  readonly accepted: boolean;
  readonly expiresAt?: string;
  readonly publishedAt: string;
}

export interface RuntimeClientToolCallRequest extends RuntimeGatewayEventBase {
  readonly type: 'client_tool_call.request';
  readonly conversationId?: number;
  readonly projectionId: string;
  readonly call: ClientToolCall;
  readonly issuedAt: string;
}

export interface RuntimeClientToolCallAck extends RuntimeGatewayEventBase {
  readonly type: 'client_tool_call.ack';
  readonly projectionId: string;
  readonly toolCallId: string;
  readonly status: 'accepted' | 'rejected' | 'duplicate';
  readonly reason?: string;
  readonly ackedAt: string;
}

export interface RuntimeClientToolCallResult extends RuntimeGatewayEventBase {
  readonly type: 'client_tool_call.result';
  readonly projectionId: string;
  readonly report: ClientToolResultReport;
  readonly reportedAt: string;
}

export interface RuntimeError extends RuntimeGatewayEventBase {
  readonly type: 'runtime.error';
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly occurredAt: string;
}

export type RuntimeGatewayEvent =
  | RuntimeClientHello
  | RuntimeResume
  | RuntimeHeartbeat
  | RuntimeProjectionPublished
  | RuntimeClientToolCallRequest
  | RuntimeClientToolCallAck
  | RuntimeClientToolCallResult
  | RuntimeError;

export type RuntimeGatewayClientStatusValue =
  | 'idle'
  | 'disabled'
  | 'publishing_projection'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'degraded'
  | 'stopped';

export interface RuntimeGatewayClientStatus {
  readonly status: RuntimeGatewayClientStatusValue;
  readonly connected: boolean;
  readonly sessionId?: string;
  readonly projectionId?: string;
  readonly lastAckSeq?: number;
  readonly pendingResultCount: number;
  readonly lastError?: string | null;
}
