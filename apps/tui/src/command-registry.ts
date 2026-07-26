import { tuiCommandMessage, tuiMessage, type TuiLocale } from './tui-language.ts';

export type TuiUserMode = 'chat' | 'plan' | 'goal';

export type TuiCommandAction =
  | { readonly type: 'open-model-picker' }
  | { readonly type: 'open-mode-picker' }
  | { readonly type: 'open-permission-picker' }
  | { readonly type: 'open-language-picker' }
  | { readonly type: 'open-theme-picker' }
  | { readonly type: 'open-skill-picker' }
  | { readonly type: 'open-mcp-picker' }
  | { readonly type: 'show-help' }
  | { readonly type: 'clear-chat' }
  | { readonly type: 'new-session' }
  | { readonly type: 'compact-context' }
  | { readonly type: 'history-navigation'; readonly direction: 'earlier' | 'later' | 'latest' }
  | { readonly type: 'open-resume-picker' }
  | { readonly type: 'open-goal-picker' }
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
  {
    id: 'theme',
    label: 'Theme',
    description: 'Switch light / dark / system theme (Peer Frost)',
    keywords: ['appearance', 'light', 'dark', 'system', 'color', 'palette', 'frost', '白', '黑', '浅色', '深色'],
    action: { type: 'open-theme-picker' },
  },
  { id: 'skill', label: 'Skills', description: 'Browse, enable, disable, refresh, insert, or invoke Skills', keywords: ['capability', 'manage'], action: { type: 'open-skill-picker' } },
  { id: 'mcp', label: 'MCP Servers', description: 'Manage MCP Servers and inspect tool status', keywords: ['server', 'tools', 'capability'], action: { type: 'open-mcp-picker' } },
  { id: 'new', label: 'New session', description: 'Start a fresh empty session and return to the home screen', keywords: ['session', 'home', 'fresh', 'reset', 'create'], shortcut: 'Ctrl+X N', action: { type: 'new-session' } },
  { id: 'clear', label: 'Clear chat', description: 'Clear messages, model context, and errors', keywords: ['reset', 'conversation', 'error'], action: { type: 'clear-chat' } },
  { id: 'compact', label: 'Compact context', description: 'Compress model context with a structural summary; UI transcript stays', keywords: ['compress', 'summary', 'context', 'tokens'], action: { type: 'compact-context' } },
  { id: 'history', label: 'History', description: 'Browse compacted earlier pages; press again for older, Esc to return to latest', keywords: ['older', 'previous', 'earlier', 'transcript', 'archive'], action: { type: 'history-navigation', direction: 'earlier' } },
  // Hidden aliases — not shown in palette but resolvable via /history later|latest|earlier
  { id: 'history-earlier', label: 'Earlier history', description: 'Show the previous bounded page', keywords: ['older', 'previous', 'transcript'], action: { type: 'history-navigation', direction: 'earlier' }, visible: (): boolean => false },
  { id: 'history-later', label: 'Later history', description: 'Show the next bounded page', keywords: ['newer', 'next', 'transcript'], action: { type: 'history-navigation', direction: 'later' }, visible: (): boolean => false },
  { id: 'history-latest', label: 'Latest history', description: 'Return to the default latest window', keywords: ['newest', 'bottom', 'transcript'], action: { type: 'history-navigation', direction: 'latest' }, visible: (): boolean => false },
  { id: 'resume', label: 'Resume session', description: 'Restore and continue a saved conversation', keywords: ['session', 'conversation', 'history', 'restore'], shortcut: 'Ctrl+X L', action: { type: 'open-resume-picker' } },
  { id: 'goals', label: 'Goal history', description: 'Switch between formal goals in this conversation', keywords: ['goal', 'mission', 'history', 'switch'], action: { type: 'open-goal-picker' } },
  { id: 'goal-pause', label: 'Pause goal', description: 'Pause the active goal after the current safe boundary', keywords: ['hold'], action: { type: 'goal-control', control: 'pause' }, visible: GOAL_RUNNING },
  { id: 'goal-resume', label: 'Resume goal', description: 'Resume the paused goal', keywords: ['continue'], action: { type: 'goal-control', control: 'resume' }, visible: GOAL_PAUSED },
  { id: 'goal-cancel', label: 'Cancel goal', description: 'Cancel the active goal', keywords: ['stop', 'abort'], action: { type: 'goal-control', control: 'cancel' }, visible: GOAL_ACTIVE },
  { id: 'help', label: 'Help', description: 'Show keyboard shortcuts and command syntax', keywords: ['keys', 'shortcuts'], action: { type: 'show-help' } },
  { id: 'quit', label: 'Quit', description: 'Exit Peer Agent', keywords: ['exit'], action: { type: 'quit' } },
]);

export function localizeTuiCommand(
  command: TuiCommandDefinition,
  locale: TuiLocale = 'en-US',
): TuiCommandDefinition {
  const label = tuiCommandMessage(locale, command.id, 'label') ?? command.label;
  const description = tuiCommandMessage(locale, command.id, 'description') ?? command.description;
  if (label === command.label && description === command.description) return command;
  return {
    ...command,
    label,
    description,
  };
}

export function localizeTuiCommands(
  commands: readonly TuiCommandDefinition[],
  locale: TuiLocale = 'en-US',
): readonly TuiCommandDefinition[] {
  return commands.map((command) => localizeTuiCommand(command, locale));
}

export function visibleTuiCommands(
  context: TuiCommandContext,
  locale: TuiLocale = 'en-US',
): readonly TuiCommandDefinition[] {
  return localizeTuiCommands(
    TUI_COMMAND_REGISTRY.filter((command) => command.visible?.(context) ?? true),
    locale,
  );
}

export function filterTuiCommandRegistry(
  query: string,
  context: TuiCommandContext,
  locale: TuiLocale = 'en-US',
): readonly TuiCommandDefinition[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return visibleTuiCommands(context, locale).filter((command) => {
    if (terms.length === 0) return true;
    const haystack = [command.id, command.label, command.description, ...command.keywords].join(' ').toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/**
 * Resolve manually submitted slash input. The unified `/history` command
 * defaults to `earlier`; `/history later` and `/history latest` are still
 * resolvable as hidden aliases for power users.
 */
export function resolveTuiCommandInput(
  input: string,
  context: TuiCommandContext,
  locale: TuiLocale = 'en-US',
): TuiCommandDefinition | null {
  const match = /^\/([a-z0-9-]+)(?:\s+([a-z0-9-]+))?\s*$/i.exec(input.trim());
  if (!match) return null;
  const commandName = match[1]?.toLowerCase() ?? '';
  const argument = match[2]?.toLowerCase();
  const commandId = commandName === 'history' && argument
    ? `history-${argument}`
    : argument
      ? ''
      : commandName;
  if (!commandId) return null;
  // Search the full registry (including hidden aliases) for resolution,
  // not just visibleTuiCommands — /history later must still work.
  const localized = localizeTuiCommands(
    TUI_COMMAND_REGISTRY.filter((command) => command.visible?.(context) ?? true),
    locale,
  );
  const visibleMatch = localized.find((command) => command.id === commandId);
  if (visibleMatch) return visibleMatch;
  // Hidden aliases (history-earlier, history-later, history-latest)
  return localizeTuiCommands(
    TUI_COMMAND_REGISTRY.filter((command) => !(command.visible?.(context) ?? true)),
    locale,
  ).find((command) => command.id === commandId) ?? null;
}

export interface TuiHelpSection {
  readonly title: string;
  readonly lines: readonly string[];
}

/** Content for the `/help` panel; keep titles locale-aware. */
export function buildTuiHelpSections(
  context: TuiCommandContext = { goalStatus: 'none' },
  locale: TuiLocale = 'en-US',
): readonly TuiHelpSection[] {
  const commands = visibleTuiCommands(context, locale);
  return [
    {
      title: tuiMessage(locale, 'help.keyboard'),
      lines: [
        'Enter  send',
        'Shift+Enter  newline',
        'Ctrl+C  cancel stream / clear draft / quit',
        'Ctrl+X then M/O/P  model / mode / permissions',
        'Ctrl+X then N  new session',
        'Ctrl+X then L  resume session',
        'Ctrl+X then 1/2/3  Agent / Plan / Goal',
        'Drag to select chat text to auto-copy (Ctrl/Cmd+C still works)',
      ],
    },
    {
      title: tuiMessage(locale, 'help.commands'),
      lines: commands.map((command) => {
        const shortcut = command.shortcut ? `  (${command.shortcut})` : '';
        return `/${command.id}  ${command.description}${shortcut}`;
      }),
    },
    {
      title: tuiMessage(locale, 'help.modes'),
      lines: [
        'Agent  general conversation with projected read/write tools',
        'Plan  clarify intent and produce an executable plan',
        'Goal  execute an approved plan with evidence checkpoints',
      ],
    },
    {
      title: tuiMessage(locale, 'help.tips'),
      lines: [
        'Type / to search commands',
        'Click a tool result to expand full output',
        'Select chat text with the mouse to auto-copy; Ctrl/Cmd+C also copies',
        'ctx shows context usage for the current model',
      ],
    },
  ];
}
