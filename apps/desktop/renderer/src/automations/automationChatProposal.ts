import type {
  AutomationChatProposal,
  AutomationCreateContext,
  AutomationProposalAction,
  AutomationProposalActionRequest,
  AutomationProposalActionResult,
} from '@peer-agent/protocol';

/**
 * Renderer projection of the canonical conversation-scoped Automation proposal.
 * This module does not own proposal truth or create Automation definitions; it only
 * derives view/action state from protocol objects persisted by the local host.
 */
export interface AutomationChatProposalViewState {
  readonly proposal: AutomationChatProposal;
  readonly canAct: boolean;
  readonly isCreating: boolean;
  readonly isTerminal: boolean;
  readonly hasCreationReceipt: boolean;
}

export function selectAutomationChatProposal(
  context: AutomationCreateContext | null | undefined,
): AutomationChatProposal | null {
  return context?.activeProposal ?? null;
}

export function projectAutomationChatProposal(
  proposal: AutomationChatProposal,
): AutomationChatProposalViewState {
  return {
    proposal,
    canAct: proposal.status === 'proposed' || proposal.status === 'failed',
    isCreating: proposal.status === 'creating',
    isTerminal: proposal.status === 'created' || proposal.status === 'cancelled',
    hasCreationReceipt: proposal.status === 'created' && Boolean(proposal.receipt),
  };
}

export function buildAutomationProposalActionRequest(
  conversationId: string,
  proposal: AutomationChatProposal,
  action: AutomationProposalAction,
): AutomationProposalActionRequest {
  if (!conversationId || proposal.conversationId !== conversationId) {
    throw new Error('Automation proposal does not belong to the active conversation.');
  }
  return {
    conversationId,
    proposalId: proposal.proposalId,
    fingerprint: proposal.fingerprint,
    action,
  };
}

export function applyAutomationProposalActionResult(
  context: AutomationCreateContext | null | undefined,
  result: AutomationProposalActionResult,
): AutomationCreateContext {
  const proposal = result.proposal;
  return {
    ...(context ?? {
      schemaVersion: 1,
      kind: 'automation_create',
      source: proposal.source,
      rejectedFingerprints: [],
      createdAt: proposal.createdAt,
    }),
    status: proposal.status,
    activeProposal: proposal,
    updatedAt: proposal.updatedAt,
  };
}
