import type {
  ChatStreamDoneEnvelope,
  ChatStreamErrorEnvelope,
  ChatStreamEventEnvelope,
  ClientToolCallPollRequest,
  ClientToolCallPollResult,
  ClientToolResultReport,
} from '@zeus-atlas/protocol';
import type { PreloadResult } from './apiResponse';

export interface LocalCapabilityPreloadApi {
  readonly reportClientToolResult: (params: ClientToolResultReport) => PreloadResult<unknown>;
  readonly pollClientToolCalls: (params: ClientToolCallPollRequest) => PreloadResult<ClientToolCallPollResult>;
  readonly onStreamEvent: (listener: (payload: ChatStreamEventEnvelope) => void) => () => void;
  readonly onStreamDone: (listener: (payload: ChatStreamDoneEnvelope) => void) => () => void;
  readonly onStreamError: (listener: (payload: ChatStreamErrorEnvelope) => void) => () => void;
}
