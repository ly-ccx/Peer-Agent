import { createI18n } from '@zeus-atlas/i18n';
import type {
  CapabilityManifest,
  CapabilitySelection,
  ClientToolCall,
  ClientToolResult,
  Evidence,
  PermissionGrant,
} from '@zeus-atlas/protocol';

export type ThreadEvent =
  | {
      readonly id: string;
      readonly type: 'user_message';
      readonly content: string;
      readonly createdAt: string;
    }
  | {
      readonly id: string;
      readonly type: 'assistant_summary';
      readonly content: string;
      readonly createdAt: string;
    }
  | {
      readonly id: string;
      readonly type: 'tool_call';
      readonly call: ClientToolCall;
      readonly result?: ClientToolResult;
      readonly grant?: PermissionGrant;
      readonly createdAt: string;
    }
  | {
      readonly id: string;
      readonly type: 'review_required';
      readonly calls: readonly ClientToolCall[];
      readonly createdAt: string;
    }
  | {
      readonly id: string;
      readonly type: 'evidence_summary';
      readonly evidence: Evidence;
      readonly createdAt: string;
    }
  | {
      readonly id: string;
      readonly type: 'artifact';
      readonly title: string;
      readonly description: string;
      readonly createdAt: string;
    };

export interface TaskThread {
  readonly threadId: string;
  readonly title: string;
  readonly events: readonly ThreadEvent[];
}

const now = () => new Date().toISOString();

export function createToolCallFromCapability(
  capability: CapabilityManifest,
  selection: CapabilitySelection,
  locale = 'zh-CN',
): ClientToolCall {
  const i18n = createI18n(locale);
  return {
    toolCallId: `tool_${capability.capabilityId.replace(/\W+/g, '_')}_${Date.now()}`,
    capabilityId: capability.capabilityId,
    displayName: i18n.capabilityName(capability),
    reason: selection.reason,
    argumentsPreview: selection.argumentsPreview,
    riskLevel: capability.riskLevel,
    dataLevel: capability.dataLevel,
    requestedAt: now(),
  };
}

export function applyToolResult(
  thread: TaskThread,
  result: ClientToolResult,
  grant: PermissionGrant,
): TaskThread {
  const updatedEvents = thread.events.map((event) => {
    if (event.type !== 'tool_call' || event.call.toolCallId !== result.toolCallId) {
      return event;
    }

    return {
      ...event,
      result,
      grant,
    };
  });

  return {
    ...thread,
    events: [
      ...updatedEvents,
      {
        id: `evt_evidence_${result.evidence.evidenceId}`,
        type: 'evidence_summary',
        evidence: result.evidence,
        createdAt: result.completedAt,
      },
      {
        id: `evt_artifact_${result.evidence.evidenceId}`,
        type: 'artifact',
        title: `${result.toolCallId} evidence`,
        description: createI18n(result.evidence.locale).t(
          result.evidence.returnedToCloud ? 'artifact.evidence.returned' : 'artifact.evidence.local',
        ),
        createdAt: result.completedAt,
      },
    ],
  };
}
