import { applyTuiCommand, type TuiCommand, type TuiExperienceState } from './tui-experience.ts';

export interface TuiCommandExecutionHandlers {
  readonly clearChat: () => boolean;
  readonly controlGoal: (control: 'pause' | 'resume' | 'cancel') => string;
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
  } else if (action.type === 'goal-control') {
    handlers.setNotice(handlers.controlGoal(action.control));
  } else if (action.type === 'quit') {
    handlers.quit();
    return;
  } else {
    handlers.setNotice(null);
  }

  handlers.updateExperience((state) => applyTuiCommand(state, command));
}
