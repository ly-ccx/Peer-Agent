export interface SidebarMessageState {
  readonly role?: unknown;
  readonly interrupted?: unknown;
}

/** Only the latest response can describe the conversation's current state. */
export function hasSidebarInterruption(messages: readonly SidebarMessageState[]): boolean {
  const last = messages.at(-1);
  return last?.role === 'assistant' && last.interrupted === true;
}

/** Live state supersedes disk history, including an empty but loaded conversation. */
export function sidebarInterruptedState(
  state: { readonly loadStatus: string; readonly messages: readonly SidebarMessageState[]; readonly isStreaming: boolean },
  persisted: boolean,
  isRunning: boolean,
): boolean {
  if (isRunning || state.isStreaming) return false;
  return state.loadStatus === 'ready' || state.messages.length > 0
    ? hasSidebarInterruption(state.messages)
    : persisted;
}
