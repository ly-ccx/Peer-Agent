import type { ResourceFeedback } from './resource-feedback.ts';
import type { ProjectInputAttachment, ProjectAgentSubmitInputResult, WorkSessionStatus } from './delegation.ts';

export type LocalInputSurface = 'desktop' | 'quick_chat' | 'tui';
export interface InputDraftQuote { readonly messageId: string; readonly text: string }
export interface InputDraftTaskRef {
  readonly sessionId: string;
  readonly title: string;
  readonly status: WorkSessionStatus | string;
  readonly anchorMessageId?: string;
}
export interface InputDraftValue {
  readonly text: string;
  readonly quote: InputDraftQuote | null;
  readonly attachments: readonly ProjectInputAttachment[];
  readonly taskRefs?: readonly InputDraftTaskRef[];
  readonly resourceFeedback?: readonly ResourceFeedback[];
}
/** User intent only. Presence here never means the input was received or executed. */
export interface UnconfirmedProjectInput {
  readonly inputId: string;
  readonly text: string;
  readonly quoteRefs: readonly string[];
  readonly taskRefs?: readonly InputDraftTaskRef[];
  readonly answerTo?: string;
  readonly attachments: readonly ProjectInputAttachment[];
  readonly resourceFeedback?: readonly ResourceFeedback[];
  readonly createdAt: string;
}
export interface ProjectInputDraftSnapshot {
  readonly revision: number;
  readonly draft: InputDraftValue;
  readonly pending: readonly UnconfirmedProjectInput[];
}
export interface ProjectInputDraftReadRequest { readonly workspaceId: string; readonly surface: LocalInputSurface }
export type ProjectInputDraftReadResult = { readonly ok: true; readonly snapshot: ProjectInputDraftSnapshot }
  | { readonly ok: false; readonly code: string };
export interface ProjectInputDraftWriteRequest extends ProjectInputDraftReadRequest {
  readonly revision: number;
  readonly draft: Omit<InputDraftValue, 'attachments'> & { readonly attachmentIds: readonly string[] };
  readonly pending: readonly (Omit<UnconfirmedProjectInput, 'attachments'> & { readonly attachmentIds: readonly string[] })[];
  /** Already-stored attachments are referred to by ID; large bytes are sent only once. */
  readonly uploads: readonly ProjectInputAttachment[];
}
export type ProjectInputDraftWriteResult = { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly code: string };
export interface ProjectInputRecoveryPort {
  read(request: ProjectInputDraftReadRequest): Promise<ProjectInputDraftReadResult>;
  write(request: ProjectInputDraftWriteRequest): Promise<ProjectInputDraftWriteResult>;
  submit(request: UnconfirmedProjectInput & ProjectInputDraftReadRequest): Promise<ProjectAgentSubmitInputResult>;
}
export type ProjectInputMutationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string };
export const DEFINITE_PROJECT_INPUT_REJECTION_CODES: ReadonlySet<string> = new Set([
  'QUESTION_CLOSED',
  'INVALID_INPUT',
  'INVALID_INPUT_ID',
  'INVALID_RESOURCE_FEEDBACK',
  'RESOURCE_FEEDBACK_RECIPIENT_CHANGED',
  'RESOURCE_FEEDBACK_ATTACHMENT_LIMIT',
  'INTERACTIVE_FEEDBACK_UNAVAILABLE',
  'NOT_FOUND',
  'WORKSPACE_NOT_FOUND',
]);
export function emptyInputDraft(): InputDraftValue { return { text: '', quote: null, attachments: [] }; }
/** A handoff failure may follow a durable receipt. Generic ok alone proves nothing. */
export function projectInputWasReceived(result: ProjectAgentSubmitInputResult | null | undefined, workspaceId: string, inputId: string): boolean {
  return result?.input?.workspaceId === workspaceId && result.input.inputId === inputId;
}
export function isDefiniteProjectInputRejectionCode(code: string | null | undefined): boolean {
  return typeof code === 'string' && DEFINITE_PROJECT_INPUT_REJECTION_CODES.has(code);
}
/** True only when the host rejected the input before enqueuing it (no durable receipt). */
export function isDefiniteProjectInputRejection(
  result: ProjectAgentSubmitInputResult | null | undefined,
  workspaceId: string,
  inputId: string,
): boolean {
  if (!result || result.ok || projectInputWasReceived(result, workspaceId, inputId)) return false;
  return isDefiniteProjectInputRejectionCode(result.code);
}
