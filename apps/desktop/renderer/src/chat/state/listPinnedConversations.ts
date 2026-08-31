import { clientApi } from '../../clientApi';
import { normalizeConversationListPage } from './conversationListPagination';
import {
  selectPinnedConversations,
  toPinnedConversationMeta,
  type PinnedConversationMeta,
} from './pinnedConversationList';

export async function listPinnedConversations(): Promise<PinnedConversationMeta[]> {
  const response = await clientApi.conversationsList({
    status: 'active',
    includeMessageCount: false,
  });
  const page = normalizeConversationListPage(response);
  return selectPinnedConversations(page.items).map(toPinnedConversationMeta);
}
