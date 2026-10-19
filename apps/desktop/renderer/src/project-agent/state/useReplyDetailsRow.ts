import { useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';
import { isActivityRunning, replyDetailsFromPage } from './botActivityState';
import { type ConversationDisplayRow } from './botConversationState';

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
      setSnapshot({ key, loading: false, row: replyDetailsFromPage(id, result) });
    }).catch(() => { if (current) setSnapshot({ key, loading: false }); });
    return () => { current = false; };
  }, [workspaceId, id, live, key]);
  return !id || live ? { row: fallback, loading: false }
    : snapshot?.key === key ? snapshot : { row: undefined, loading: true };
}
