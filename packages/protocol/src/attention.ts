/** Read-only presentation facts. Actions remain subject to their original host gates. */
export interface AttentionCard {
  readonly cardId: string;
  readonly kind: string;
  readonly content: string;
  readonly resolvedState?: 'open' | 'resolved';
  readonly actions?: readonly { readonly id: string; readonly channel?: string; readonly seam?: string; readonly payload?: Readonly<Record<string, unknown>> }[];
  readonly refs?: Readonly<Record<string, string>>;
  readonly resolution?: { readonly state: string };
  readonly completionReview?: import('./delegation.ts').SessionCompletionReview;
}
export interface BotAttentionItem {
  readonly id: string;
  readonly workspaceId: string;
  readonly botName: string;
  readonly kind: 'question' | 'approval' | 'confirmation';
  readonly title: string;
  readonly createdAt?: string;
  readonly expiresAt?: string;
  readonly messageId?: string;
  readonly sessionId?: string;
  readonly card?: AttentionCard;
}
export interface BotAttentionRequest { readonly workspaceId?: string }
export type BotAttentionResult = { readonly ok: true; readonly items: readonly BotAttentionItem[] }
  | { readonly ok: false; readonly code: string };

/** Current conversational decision, including when its source lies outside the returned page. */
export interface BotDecisionSnapshot { readonly activeReplyQuestionId: string | null }
