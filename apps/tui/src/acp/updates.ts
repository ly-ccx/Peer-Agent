import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { ChatSnapshot } from '../chat-controller.ts';
import type { ToolPresentation } from '../tool-result-summary.ts';

type Update = SessionNotification['update'];

/** One projector per conversation. Consumes structured snapshots, never assistant prose as tool evidence. */
export function createAcpUpdateProjector() {
  const textLengths = new Map<string, number>();
  const tools = new Map<string, string>();
  function toolUpdate(tool: ToolPresentation): Update[] {
    // Missing runtime identity is not permission to invent an execution event.
    if (!tool.toolCallId) return [];
    const status = tool.status === 'completed' ? 'completed'
      : tool.status === 'running' ? 'in_progress'
      : tool.status === 'unknown' ? 'pending' : 'failed';
    const fields = {
      toolCallId: tool.toolCallId,
      title: tool.toolName,
      status,
      rawInput: tool.arguments ?? undefined,
      content: tool.detail ? [{ type: 'content' as const, content: { type: 'text' as const, text: tool.detail } }] : [],
    } as const;
    const fingerprint = JSON.stringify(fields);
    const previous = tools.get(tool.toolCallId);
    if (previous === fingerprint) return [];
    tools.set(tool.toolCallId, fingerprint);
    return [{ sessionUpdate: previous === undefined ? 'tool_call' : 'tool_call_update', ...fields }];
  }
  return (snapshot: ChatSnapshot): Update[] => {
    const updates: Update[] = [];
    for (const message of snapshot.messages) {
      if (message.role !== 'assistant') continue;
      const segments = message.segments ?? [
        ...(message.tools ?? (message.tool ? [message.tool] : [])).map((tool) => ({ type: 'tool-call' as const, tool })),
        { type: 'text' as const, content: message.content },
      ];
      segments.forEach((segment, index) => {
        if (segment.type === 'tool-call') { updates.push(...toolUpdate(segment.tool)); return; }
        if (segment.type !== 'text') return;
        const key = `${message.id}:${index}`;
        const previous = textLengths.get(key) ?? 0;
        // ACP chunks are append-only: do not re-emit text on finalization snapshots.
        if (segment.content.length > previous) {
          updates.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: segment.content.slice(previous) } });
          textLengths.set(key, segment.content.length);
        }
      });
    }
    return updates;
  };
}
