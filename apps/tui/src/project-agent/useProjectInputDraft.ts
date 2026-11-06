import { useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import type { TextareaRenderable } from '@opentui/core';
import type { createTuiProjectClient } from './tui-project-client.ts';
/** Native textarea adapter; restoring a draft does not dispatch or move a user's caret. */
export function useProjectInputDraft(client: ReturnType<typeof createTuiProjectClient>, workspaceId: string,
  editor: RefObject<TextareaRenderable | null>, view: string) {
  const session = client.recovery(workspaceId), restoring = useRef(false);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => {
    if (workspaceId && !session.getSnapshot().ready) void session.load();
    return () => { void session.flush(); };
  }, [session, workspaceId]);
  useEffect(() => {
    if (state.ready) session.observeReceived(client.current().messages.filter((row: any) => row.kind === 'user_input').flatMap((row: any) => row.inputId ? [row.inputId] : row.id?.startsWith('input-') ? [row.id.slice(6)] : []));
    const node = editor.current;
    if (!node || !state.ready || node.plainText === state.draft.text) return;
    restoring.current = true;
    try { node.setText(state.draft.text); } finally { restoring.current = false; }
  }, [editor, session, state.ready, state.draft.text, view]);
  return { session, state, changed() {
    if (!restoring.current && editor.current && editor.current.plainText !== session.getSnapshot().draft.text) session.edit({ text: editor.current.plainText });
  } };
}
