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
  /** Terminal proposals should default to a compact strip, not the full decision card. */
  readonly prefersCompact: boolean;
  readonly hasCreationReceipt: boolean;
}

export function selectAutomationChatProposal(
  context: AutomationCreateContext | null | undefined,
): AutomationChatProposal | null {
  const proposal = context?.activeProposal ?? null;
  if (!proposal) return null;
  // Terminal proposals are receipts, not open decisions — do not pin a footer card.
  if (proposal.status === 'created' || proposal.status === 'cancelled') return null;
  return proposal;
}

export function projectAutomationChatProposal(
  proposal: AutomationChatProposal,
): AutomationChatProposalViewState {
  const isTerminal = proposal.status === 'created' || proposal.status === 'cancelled';
  return {
    proposal,
    canAct: proposal.status === 'proposed' || proposal.status === 'failed',
    isCreating: proposal.status === 'creating',
    isTerminal,
    // Created / cancelled are receipts, not open decisions — collapse by default.
    prefersCompact: isTerminal,
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
  const terminal = proposal.status === 'created' || proposal.status === 'cancelled';
  return {
    ...(context ?? {
      schemaVersion: 1,
      kind: 'automation_create',
      source: proposal.source,
      rejectedFingerprints: [],
      createdAt: proposal.createdAt,
    }),
    status: proposal.status,
    // Clear the footer card after confirm/cancel; receipt remains on the action result.
    activeProposal: terminal ? null : proposal,
    updatedAt: proposal.updatedAt,
  };
}
