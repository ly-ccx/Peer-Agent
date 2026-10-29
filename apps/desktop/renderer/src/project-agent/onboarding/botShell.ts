export type ProjectAgentShell = 'bots' | 'classic';

export type OnboardingStep = 'connect-model' | 'create-bot';

export const PROJECT_AGENT_SHELL_EVENT = 'peer-project-agent-shell';

function projectAgentRecord(settings: unknown): Record<string, unknown> {
  if (!settings || typeof settings !== 'object') return {};
  const agent = (settings as { projectAgent?: unknown }).projectAgent;
  return agent && typeof agent === 'object' && !Array.isArray(agent)
    ? agent as Record<string, unknown>
    : {};
}

export function projectAgentShellOf(settings: unknown): ProjectAgentShell {
  return projectAgentRecord(settings).shell === 'classic' ? 'classic' : 'bots';
}

export function upgradeBannerPending(settings: unknown): boolean {
  const agent = projectAgentRecord(settings);
  return agent.shellIntroPending === true && agent.shellIntroDismissed !== true;
}

export function botOnboardingStep(input: {
  readonly hasModel: boolean;
  readonly botCount: number;
  readonly ready: boolean;
}): OnboardingStep | null {
  if (!input.ready) return null;
  if (!input.hasModel) return 'connect-model';
  if (input.botCount === 0) return 'create-bot';
  return null;
}

export function shellPreferencePatch(shell: ProjectAgentShell): { projectAgent: { shell: ProjectAgentShell } } {
  return { projectAgent: { shell } };
}

export function publishProjectAgentShell(shell: ProjectAgentShell) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PROJECT_AGENT_SHELL_EVENT, { detail: shell }));
}
