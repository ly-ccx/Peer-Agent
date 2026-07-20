export type TuiUserMode = 'chat' | 'plan' | 'goal';

export type TuiCommandAction =
  | { readonly type: 'open-model-picker' }
  | { readonly type: 'open-mode-picker' }
  | { readonly type: 'open-permission-picker' }
  | { readonly type: 'open-language-picker' }
  | { readonly type: 'show-help' }
  | { readonly type: 'clear-chat' }
  | { readonly type: 'compact-context' }
  | { readonly type: 'open-resume-picker' }
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
  { id: 'mode', label: 'Mode', description: 'Choose Agent, Plan, or Goal', keywords: ['agent', 'chat', 'plan', 'goal'], shortcut: 'Ctrl+X O', action: { type: 'open-mode-picker' } },
  { id: 'permissions', label: 'Permissions', description: 'Choose the session permission policy', keywords: ['access', 'approval', 'ask'], shortcut: 'Ctrl+X P', action: { type: 'open-permission-picker' } },
  {
    id: 'language',
    label: 'Language',
    description: 'Switch UI and model reply language (Chinese/English)',
    keywords: ['locale', '中文', 'english', 'zh', 'en', 'i18n', 'lang'],
    action: { type: 'open-language-picker' },
  },
  { id: 'clear', label: 'Clear chat', description: 'Clear messages, model context, and errors', keywords: ['reset', 'conversation', 'error'], action: { type: 'clear-chat' } },
  { id: 'compact', label: 'Compact context', description: 'Compress model context with a structural summary; UI transcript stays', keywords: ['compress', 'summary', 'context', 'tokens'], action: { type: 'compact-context' } },
  { id: 'resume', label: 'Resume session', description: 'Restore and continue a saved conversation', keywords: ['session', 'conversation', 'history', 'restore'], action: { type: 'open-resume-picker' } },
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

export interface TuiHelpSection {
  readonly title: string;
  readonly lines: readonly string[];
}

/** Content for the `/help` panel: shortcuts, slash commands, and modes. */
export function buildTuiHelpSections(
  context: TuiCommandContext = { goalStatus: 'none' },
): readonly TuiHelpSection[] {
  const commands = visibleTuiCommands(context);
  return [
    {
      title: 'Keyboard',
      lines: [
        'Ctrl+X then M  model picker',
        'Ctrl+X then O  mode picker',
        'Ctrl+X then P  permissions',
        'Ctrl+1 / 2 / 3  Agent / Plan / Goal',
        'Esc  close panel or cancel',
        'Ctrl/Cmd+C  copy selection, else interrupt / quit',
        'Drag to select chat text, then Ctrl/Cmd+C to copy',
      ],
    },
    {
      title: 'Slash commands',
      lines: commands.map((command) => {
        const shortcut = command.shortcut ? `  (${command.shortcut})` : '';
        return `/${command.id}  ${command.description}${shortcut}`;
      }),
    },
    {
      title: 'Modes',
      lines: [
        'Agent  general conversation with projected read/write tools',
        'Plan   read-only planning until a plan is approved',
        'Goal   autonomous execution with projected tools',
      ],
    },
    {
      title: 'Language',
      lines: [
        '/language  switch UI + model reply language (Chinese / English)',
        'Persisted in ~/.peer-agent/settings.json as locale + replyLanguage',
      ],
    },
    {
      title: 'Tips',
      lines: [
        'Type / to search commands',
        'Click a tool result to expand full output',
        'Select chat text with the mouse, then Ctrl/Cmd+C to copy',
        'ctx shows context usage for the current model',
      ],
    },
  ];
}
