import type { TuiMode } from './tui-mode.ts';

export type TuiFooterView =
  | { readonly type: 'composer' }
  | { readonly type: 'command'; readonly query: string; readonly selectedIndex: number }
  | { readonly type: 'permission'; readonly selectedIndex: number }
  | { readonly type: 'plan-approval'; readonly selectedIndex: number };

export type TuiCommandAction =
  | { readonly type: 'set-mode'; readonly mode: TuiMode }
  | { readonly type: 'select-model' }
  | { readonly type: 'new-session' }
  | { readonly type: 'show-help' }
  | { readonly type: 'goal-control'; readonly control: 'pause' | 'resume' | 'cancel' }
  | { readonly type: 'quit' };

export interface TuiCommand {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly action: TuiCommandAction;
}

export interface TuiExperienceState {
  readonly footer: TuiFooterView;
  readonly mode: TuiMode;
}

export const TUI_COMMANDS: readonly TuiCommand[] = Object.freeze([
  {
    id: 'model',
    label: 'Switch model',
    description: 'Choose a configured model',
    keywords: ['provider', 'llm'],
    action: { type: 'select-model' },
  },
  {
    id: 'mode-chat',
    label: 'Chat mode',
    description: 'Talk and use governed tools',
    keywords: ['mode', 'agent'],
    action: { type: 'set-mode', mode: 'chat' },
  },
  {
    id: 'mode-plan',
    label: 'Plan mode',
    description: 'Investigate and propose a plan before acting',
    keywords: ['mode', 'read only'],
    action: { type: 'set-mode', mode: 'plan' },
  },
  {
    id: 'mode-goal',
    label: 'Goal mode',
    description: 'Run a tracked goal autonomously',
    keywords: ['mode', 'task'],
    action: { type: 'set-mode', mode: 'goal' },
  },
  {
    id: 'mode-explorer',
    label: 'Explorer mode',
    description: 'Inspect the workspace without writes',
    keywords: ['mode', 'read only', 'search'],
    action: { type: 'set-mode', mode: 'explorer' },
  },
  {
    id: 'new',
    label: 'New session',
    description: 'Start a clean conversation',
    keywords: ['clear', 'reset'],
    action: { type: 'new-session' },
  },
  {
    id: 'goal-pause',
    label: 'Pause active goal',
    description: 'Pause after the current governed step',
    keywords: ['task', 'stop', 'hold'],
    action: { type: 'goal-control', control: 'pause' },
  },
  {
    id: 'goal-resume',
    label: 'Resume paused goal',
    description: 'Continue a paused goal',
    keywords: ['task', 'continue'],
    action: { type: 'goal-control', control: 'resume' },
  },
  {
    id: 'goal-cancel',
    label: 'Cancel active goal',
    description: 'Stop the active goal and its current turn',
    keywords: ['task', 'abort', 'stop'],
    action: { type: 'goal-control', control: 'cancel' },
  },
  {
    id: 'help',
    label: 'Keyboard help',
    description: 'Show available actions and shortcuts',
    keywords: ['keys', 'shortcuts'],
    action: { type: 'show-help' },
  },
  {
    id: 'quit',
    label: 'Quit Peer',
    description: 'Close the terminal client',
    keywords: ['exit'],
    action: { type: 'quit' },
  },
]);

export function createTuiExperienceState(mode: TuiMode = 'chat'): TuiExperienceState {
  return { mode, footer: { type: 'composer' } };
}

export function composerRows(text: string, terminalColumns: number): number {
  const usableColumns = Math.max(12, terminalColumns - 6);
  const rows = text.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(line.length / usableColumns)), 0);
  return Math.max(1, Math.min(6, rows));
}

export function shouldOpenCommandPanel(input: string, incoming = ''): boolean {
  if (incoming) return incoming === '/' && (input === '' || input === '/');
  return input === '/';
}

export function filterTuiCommands(query: string): readonly TuiCommand[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return TUI_COMMANDS;
  return TUI_COMMANDS.filter((command) => {
    const haystack = [command.label, command.description, ...command.keywords].join(' ').toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function openCommandPanel(state: TuiExperienceState, query = ''): TuiExperienceState {
  if (state.footer.type === 'permission' || state.footer.type === 'plan-approval') return state;
  return { ...state, footer: { type: 'command', query, selectedIndex: 0 } };
}

export function showPermission(state: TuiExperienceState): TuiExperienceState {
  return { ...state, footer: { type: 'permission', selectedIndex: 0 } };
}

export function showPlanApproval(state: TuiExperienceState): TuiExperienceState {
  if (state.footer.type === 'permission') return state;
  return { ...state, footer: { type: 'plan-approval', selectedIndex: 0 } };
}

export function escapeFooter(state: TuiExperienceState): TuiExperienceState {
  if (state.footer.type === 'composer') return state;
  return { ...state, footer: { type: 'composer' } };
}

export function applyTuiCommand(state: TuiExperienceState, command: TuiCommand): TuiExperienceState {
  if (command.action.type !== 'set-mode') return escapeFooter(state);
  return { mode: command.action.mode, footer: { type: 'composer' } };
}
