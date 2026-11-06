/** Local identity provenance, never permission, Evidence identity or task completion. */
export interface UserAnchorResolution {
  readonly field: 'anchorMessageIds' | 'task.anchorMessageIds' | 'replyTo';
  readonly suppliedId: string;
  readonly messageId: string;
  readonly source: 'message_id' | 'input_id';
}

export interface UserAnchorCandidate {
  readonly messageId: string;
  /** At most 120 characters; no attachment payloads. */
  readonly text: string;
}

export interface UserAnchorDiagnostic {
  readonly anchorResolutions?: readonly UserAnchorResolution[];
  readonly availableAnchors?: readonly UserAnchorCandidate[];
  readonly availableReplyAnchors?: readonly UserAnchorCandidate[];
}
