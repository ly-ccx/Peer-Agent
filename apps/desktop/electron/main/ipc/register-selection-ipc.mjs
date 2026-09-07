import { DESKTOP_IPC_CATALOG } from '../../ipc/channels.mjs';
import { createSelectionSideChatService } from '../selection-side-chat-service.mjs';

function owner(name, register) { return Object.freeze({ owner: name, register }); }

/** UI-only adapter. The session id is a local user's target, never a model caller.
 * Keep the Electron event in a host closure; re-authorize after every await.
 * Tool invocations must use their own runtime-bound caller and grant policy.
 */
export function createSelectionIpcRegistrations({ store, resolveRuntimeState, authorizeWindow }) {
  if (typeof authorizeWindow !== 'function') throw new TypeError('authorizeWindow required');
  function invoke(event, key, operation, payload) {
    const entry = DESKTOP_IPC_CATALOG[key];
    authorizeWindow({ event, entry });
    const conversationId = payload?.conversationId;
    if (typeof conversationId !== 'string' || !conversationId.trim()) throw new Error('SESSION_TARGET_REQUIRED');
    const caller = Object.freeze({ kind: 'desktop-user', conversationId });
    const service = createSelectionSideChatService({
      store, resolveRuntimeState,
      authorize: ({ caller: candidate, targetId }) => {
        authorizeWindow({ event, entry });
        return candidate === caller && !!store.getConversation(conversationId) && !!store.getConversation(targetId);
      },
    });
    return service[operation](caller, payload);
  }
  return Object.freeze([owner('selection-ipc', (ipc) => {
    ipc.handle('selection:quote', (event, payload) => invoke(event, 'selection:quote', 'quote', payload));
    ipc.handle('selection:create-child', (event, payload) => invoke(event, 'selection:create-child', 'create', payload));
    ipc.handle('selection:list-children', (event, payload) => invoke(event, 'selection:list-children', 'list', payload));
    ipc.handle('selection:read-child', (event, payload) => invoke(event, 'selection:read-child', 'read', payload));
    ipc.handle('selection:save-draft', (event, payload) => invoke(event, 'selection:save-draft', 'saveDraft', payload));
  })]);
}
