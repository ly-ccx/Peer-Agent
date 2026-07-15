export type TuiUserMode = 'chat' | 'plan' | 'goal';

export type TuiCommandAction =
  | { readonly type: 'open-model-picker' }
  | { readonly type: 'open-mode-picker' }
  | { readonly type: 'open-permission-picker' }
  | { readonly type: 'show-help' }
  | { readonly type: 'goal-control'; readonly control: 'pause' | 'resume' | 'cancel' }
  | { readonly type: 'quit' };

export interface TuiCommandContext {
  readonly goalStatus: 'none' | 'running' | 'paused';
}

export interface TuiCommandDefinition {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly shortcut?: string;
  readonly action: TuiCommandAction;
  readonly visible?: (context: TuiCommandContext) => boolean;
}

const GOAL_ACTIVE = (context: TuiCommandContext): boolean => context.goalStatus !== 'none';
const GOAL_RUNNING = (context: TuiCommandContext): boolean => context.goalStatus === 'running';
const GOAL_PAUSED = (context: TuiCommandContext): boolean => context.goalStatus === 'paused';

export const TUI_COMMAND_REGISTRY: readonly TuiCommandDefinition[] = Object.freeze([
  { id: 'model', label: 'Model', description: 'Choose model and reasoning effort', keywords: ['provider', 'llm', 'effort'], shortcut: 'Ctrl+X M', action: { type: 'open-model-picker' } },
  { id: 'mode', label: 'Mode', description: 'Choose Chat, Plan, or Goal', keywords: ['chat', 'plan', 'goal'], shortcut: 'Ctrl+X O', action: { type: 'open-mode-picker' } },
  { id: 'permissions', label: 'Permissions', description: 'Choose the session permission policy', keywords: ['access', 'approval', 'ask'], shortcut: 'Ctrl+X P', action: { type: 'open-permission-picker' } },
  { id: 'goal-pause', label: 'Pause goal', description: 'Pause the active goal after the current safe boundary', keywords: ['hold'], action: { type: 'goal-control', control: 'pause' }, visible: GOAL_RUNNING },
  { id: 'goal-resume', label: 'Resume goal', description: 'Resume the paused goal', keywords: ['continue'], action: { type: 'goal-control', control: 'resume' }, visible: GOAL_PAUSED },
  { id: 'goal-cancel', label: 'Cancel goal', description: 'Cancel the active goal', keywords: ['stop', 'abort'], action: { type: 'goal-control', control: 'cancel' }, visible: GOAL_ACTIVE },
  { id: 'help', label: 'Help', description: 'Show keyboard shortcuts and command syntax', keywords: ['keys', 'shortcuts'], action: { type: 'show-help' } },
  { id: 'quit', label: 'Quit', description: 'Exit Peer Agent', keywords: ['exit'], action: { type: 'quit' } },
]);

export function visibleTuiCommands(context: TuiCommandContext): readonly TuiCommandDefinition[] {
  return TUI_COMMAND_REGISTRY.filter((command) => command.visible?.(context) ?? true);
}

export function filterTuiCommandRegistry(
  query: string,
  context: TuiCommandContext,
): readonly TuiCommandDefinition[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return visibleTuiCommands(context).filter((command) => {
    if (terms.length === 0) return true;
    const haystack = [command.id, command.label, command.description, ...command.keywords].join(' ').toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
