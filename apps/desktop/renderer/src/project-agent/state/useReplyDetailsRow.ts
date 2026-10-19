import { useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';
import { attachBotProcesses, isActivityRunning, replyDetailsRow } from './botActivityState';
import { conversationRows, normalizeBotMessage, type BotChatMessage, type ConversationDisplayRow } from './botConversationState';

/** Full process data belongs to the selected detail, never the refreshing chat page. */
export function useReplyDetailsRow(workspaceId: string, id: string | null, fallback: ConversationDisplayRow | undefined) {
  const live = fallback?.type === 'activity' || fallback?.type === 'message' && isActivityRunning(fallback.activity ?? null);
  const key = `${workspaceId}:${id}`;
  const [snapshot, setSnapshot] = useState<{ key: string; row?: ConversationDisplayRow; loading: boolean } | null>(null);
  useEffect(() => {
    if (!id || live) return;
    let current = true;
    setSnapshot({ key, loading: true });
    void clientApi.projectAgentReadConversation({ workspaceId, processFor: id }).then(result => {
      if (!current) return;
      const messages = (result?.ok ? result.messages ?? [] : []).map(normalizeBotMessage)
        .filter((message): message is BotChatMessage => message !== null);
      const rows = attachBotProcesses(conversationRows(messages), messages, null);
      setSnapshot({ key, loading: false, row: replyDetailsRow(result.processMessageId || id, rows, messages) });
    }).catch(() => { if (current) setSnapshot({ key, loading: false }); });
    return () => { current = false; };
  }, [workspaceId, id, live, key]);
  return !id || live ? { row: fallback, loading: false }
    : snapshot?.key === key ? snapshot : { row: undefined, loading: true };
}
