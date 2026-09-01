import { applyTuiCommand, type TuiCommand, type TuiExperienceState } from './tui-experience.ts';

export interface TuiCommandExecutionHandlers {
  readonly clearChat: () => boolean;
  readonly startNewSession: () => boolean;
  readonly compactContext: () => string | Promise<string>;
  readonly navigateHistory: (direction: 'earlier' | 'later' | 'latest') => string;
  readonly controlGoal: (control: 'pause' | 'resume' | 'cancel') => string;
  readonly toggleFastMode?: () => string;
  readonly showVersion: () => string;
  readonly quit: () => void;
  readonly setNotice: (notice: string | null) => void;
  readonly updateExperience: (update: (state: TuiExperienceState) => TuiExperienceState) => void;
}

/** Executes every command entry point through the same side-effect and state transition path. */
export function executeTuiCommand(
  command: TuiCommand,
  handlers: TuiCommandExecutionHandlers,
): void {
  const action = command.action;
  if (action.type === 'clear-chat') {
    const cleared = handlers.clearChat();
    handlers.setNotice(cleared ? 'Chat cleared' : 'Finish or interrupt the active turn before clearing');
  } else if (action.type === 'new-session') {
    const started = handlers.startNewSession();
    handlers.setNotice(started ? 'New task' : 'Finish or interrupt the active turn before starting a new task');
  } else if (action.type === 'compact-context') {
    const noticeOrPromise = handlers.compactContext();
    if (typeof noticeOrPromise === 'string') {
      handlers.setNotice(noticeOrPromise);
    } else {
      handlers.setNotice('Compacting context…');
      void noticeOrPromise.then((notice) => handlers.setNotice(notice));
    }
  } else if (action.type === 'history-navigation') {
    handlers.setNotice(handlers.navigateHistory(action.direction));
  } else if (action.type === 'goal-control') {
    handlers.setNotice(handlers.controlGoal(action.control));
  } else if (action.type === 'toggle-fast-mode') {
    handlers.setNotice(handlers.toggleFastMode?.() ?? 'Fast mode is unavailable for this model');
  } else if (action.type === 'show-version') {
    handlers.setNotice(handlers.showVersion());
  } else if (action.type === 'quit') {
    handlers.quit();
    return;
  } else {
    handlers.setNotice(null);
  }

  handlers.updateExperience((state) => applyTuiCommand(state, command));
}
