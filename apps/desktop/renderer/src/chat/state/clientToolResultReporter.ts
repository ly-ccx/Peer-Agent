import type { ClientToolCall, ClientToolResult, PermissionGrant } from '@zeus-atlas/protocol';
import { chatClient } from '../api/chatClient';
import { markClientToolResultReturnedToCloud } from './clientToolEvidence.ts';

interface ReportClientToolResultToCloudParams {
  readonly call: ClientToolCall;
  readonly conversationId?: number;
  readonly grant: PermissionGrant;
  readonly reportedAt?: string;
  readonly result: ClientToolResult;
}

export async function reportClientToolResultToCloud({
  call,
  conversationId,
  grant,
  reportedAt,
  result,
}: ReportClientToolResultToCloudParams): Promise<ClientToolResult> {
  const cloudResult = markClientToolResultReturnedToCloud(result);
  console.log('[Step5 reportClientToolResultToCloud → 云端] toolCallId:', call.toolCallId, 'capabilityId:', call.capabilityId, 'status:', cloudResult.status);
  try {
    await chatClient.reportClientToolResult({
      conversationId,
      call,
      grant,
      result: cloudResult,
      reportedAt: reportedAt ?? new Date().toISOString(),
    });
    console.log('[Step5 reportClientToolResultToCloud ← 云端] 回传成功, toolCallId:', call.toolCallId);
  } catch (err) {
    console.error('[Step5 reportClientToolResultToCloud ✕] 回传失败, toolCallId:', call.toolCallId, err);
    throw err;
  }
  return cloudResult;
}
