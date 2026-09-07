import type { SelectionRange, SelectionReference, SelectionDraft, SelectionChildSession, SelectionChildrenPage, SelectionChildRead } from '@peer-agent/protocol';

export interface ChatPreloadApi {
  readonly selectionQuote: (params: { conversationId: string; selection: SelectionRange }) => Promise<SelectionReference>;
  readonly selectionCreateChild: (params: { conversationId: string; selection: SelectionRange; requestId: string; confirmMissing?: boolean }) => Promise<SelectionChildSession>;
  readonly selectionListChildren: (params: { conversationId: string; offset?: number; limit?: number; includeArchived?: boolean }) => Promise<SelectionChildrenPage>;
  readonly selectionReadChild: (params: { conversationId: string; childId: string; limit?: number; maxCharacters?: number }) => Promise<SelectionChildRead>;
  readonly selectionSaveDraft: (params: { conversationId: string; text: string; referenceIds: readonly string[] }) => Promise<SelectionDraft>;
}
