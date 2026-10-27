/** UI destinations only. These IDs never execute tasks or establish Evidence/permissions. */
export type ResourceDetailRef = { readonly workspaceId: string } & (
  | { readonly kind: 'bot' }
  | { readonly kind: 'task'; readonly sessionId: string }
  | { readonly kind: 'reply'; readonly replyId: string }
  | { readonly kind: 'evidence'; readonly evidenceRef: string; readonly replyId?: string }
  | { readonly kind: 'process'; readonly replyId?: string }
);
export interface ResourceDetailDescriptor { readonly target: ResourceDetailRef; readonly title: string }
export function resourceDetailKey(ref: ResourceDetailRef): string {
  return JSON.stringify([ref.workspaceId, ref.kind, ref.kind === 'task' ? ref.sessionId
    : ref.kind === 'reply' ? ref.replyId : ref.kind === 'evidence' ? ref.evidenceRef : ref.kind === 'process' ? ref.replyId ?? '' : '', ref.kind === 'evidence' ? ref.replyId ?? '' : '']);
}
export function sameResourceDetail(left: ResourceDetailRef | null | undefined, right: ResourceDetailRef | null | undefined): boolean {
  return !!left && !!right && resourceDetailKey(left) === resourceDetailKey(right);
}
export function resourceDetailReturnLabel(target: ResourceDetailRef, isZh: boolean): string {
  const labels = { bot: ['返回机器人信息', 'Return to Bot information'], task: ['返回任务', 'Return to task'],
    reply: ['返回回复依据', 'Return to reply details'], evidence: ['返回证据', 'Return to evidence'], process: ['返回过程', 'Return to process'] } as const;
  return labels[target.kind][isZh ? 0 : 1];
}
