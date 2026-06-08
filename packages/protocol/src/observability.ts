export interface AiChatTraceData {
  readonly [key: string]: unknown;
}

export interface ToolCallRecord {
  readonly uuid?: string;
  readonly toolName?: string;
  readonly status?: string;
  readonly durationMs?: number;
  readonly messageId?: number;
  readonly conversationId?: number;
  readonly [key: string]: unknown;
}

export interface ToolCallListData {
  readonly list?: readonly ToolCallRecord[];
  readonly items?: readonly ToolCallRecord[];
  readonly total?: number;
  readonly [key: string]: unknown;
}

export interface ToolCallStatisticsData {
  readonly total?: number;
  readonly success?: number;
  readonly failed?: number;
  readonly averageDurationMs?: number;
  readonly [key: string]: unknown;
}

export interface AgentDailyBillingTrendData {
  readonly list?: readonly Record<string, unknown>[];
  readonly items?: readonly Record<string, unknown>[];
  readonly total?: number;
  readonly [key: string]: unknown;
}

export interface MessageContextData {
  readonly messages?: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
}

export interface ThinkingProcessListData {
  readonly list?: readonly Record<string, unknown>[];
  readonly total?: number;
  readonly [key: string]: unknown;
}
