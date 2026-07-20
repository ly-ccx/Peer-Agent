import {
  filterTuiCommandRegistry,
  TUI_COMMAND_REGISTRY,
  type TuiCommandContext,
  type TuiCommandDefinition,
} from './command-registry.ts';
import {
  createComposerSurface,
  dismissTuiSurface,
  requestTuiSurface,
  type TuiSurface,
} from './surface-state.ts';
import type { TuiMode } from './tui-mode.ts';

export type TuiCommand = TuiCommandDefinition;

export interface TuiExperienceState {
  readonly surface: TuiSurface;
  readonly mode: TuiMode;
}

export const TUI_COMMANDS = TUI_COMMAND_REGISTRY;

export function createTuiExperienceState(mode: TuiMode = 'chat'): TuiExperienceState {
  return { mode, surface: createComposerSurface() };
}

export function composerRows(text: string, terminalColumns: number): number {
  const usableColumns = Math.max(12, terminalColumns - 6);
  const rows = text.split('\n').reduce(
    (total, line) => total + Math.max(1, Math.ceil(line.length / usableColumns)),
    0,
  );
  return Math.max(1, Math.min(6, rows));
}

export function filterTuiCommands(
  query: string,
  context: TuiCommandContext = { goalStatus: 'none' },
): readonly TuiCommand[] {
  return filterTuiCommandRegistry(query, context);
}

export function selectionWindow<T>(
  items: readonly T[],
  selectedIndex: number,
  maxVisible: number,
): ReadonlyArray<{ readonly item: T; readonly index: number }> {
  const windowSize = Math.max(1, Math.min(maxVisible, items.length));
  const centeredStart = selectedIndex - Math.floor(windowSize / 2);
  const maxStart = Math.max(0, items.length - windowSize);
  const start = Math.max(0, Math.min(centeredStart, maxStart));
  return items.slice(start, start + windowSize).map((item, offset) => ({
    item,
    index: start + offset,
  }));
}

export function slashCommandWindow(
  commands: readonly TuiCommand[],
  selectedIndex: number,
  maxVisible: number,
): ReadonlyArray<{ readonly command: TuiCommand; readonly index: number }> {
  return selectionWindow(commands, selectedIndex, maxVisible).map(({ item, index }) => ({
    command: item,
    index,
  }));
}

export function openCommandPanel(state: TuiExperienceState, query = ''): TuiExperienceState {
  return {
    ...state,
    surface: requestTuiSurface(state.surface, {
      type: 'picker',
      picker: 'command',
      query,
      selectedIndex: 0,
    }),
  };
}

export function syncSlashSuggestions(state: TuiExperienceState, value: string): TuiExperienceState {
  const match = /^\/([^\s]*)$/.exec(value);
  if (!match) {
    return state.surface.type === 'slash-suggestions'
      ? { ...state, surface: createComposerSurface() }
      : state;
  }
  const query = match[1] ?? '';
  return {
    ...state,
    surface: requestTuiSurface(state.surface, {
      type: 'slash-suggestions',
      query,
      selectedIndex: state.surface.type === 'slash-suggestions' && state.surface.query === query
        ? state.surface.selectedIndex
        : 0,
    }),
  };
}

export function updateCommandPanelQuery(state: TuiExperienceState, query: string): TuiExperienceState {
  if (state.surface.type !== 'picker' || state.surface.picker !== 'command') return state;
  return { ...state, surface: { ...state.surface, query, selectedIndex: 0 } };
}

export function openPicker(
  state: TuiExperienceState,
  picker: 'mode' | 'model' | 'permission' | 'resume' | 'help',
): TuiExperienceState {
  return {
    ...state,
    surface: requestTuiSurface(state.surface, {
      type: 'picker',
      picker,
      query: '',
      selectedIndex: 0,
    }),
  };
}

export function showPermission(state: TuiExperienceState): TuiExperienceState {
  return {
    ...state,
    surface: requestTuiSurface(state.surface, {
      type: 'tool-approval',
      selectedIndex: 0,
    }),
  };
}

export function showPlanApproval(state: TuiExperienceState): TuiExperienceState {
  return {
    ...state,
    surface: requestTuiSurface(state.surface, {
      type: 'plan-approval',
      selectedIndex: 0,
    }),
  };
}

export function escapeFooter(state: TuiExperienceState): TuiExperienceState {
  return { ...state, surface: dismissTuiSurface(state.surface) };
}

export function applyTuiCommand(state: TuiExperienceState, command: TuiCommand): TuiExperienceState {
  const action = command.action;
  if (action.type === 'open-model-picker') return openPicker(state, 'model');
  if (action.type === 'open-mode-picker') return openPicker(state, 'mode');
  if (action.type === 'open-permission-picker') return openPicker(state, 'permission');
  if (action.type === 'open-language-picker') return openPicker(state, 'language');
  if (action.type === 'open-resume-picker') return openPicker(state, 'resume');
  if (action.type === 'show-help') return openPicker(state, 'help');
  return escapeFooter(state);
}
