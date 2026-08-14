// Compatibility seam for Desktop-local imports.
// Goal intake and recovery decisions are owned by @peer-agent/runtime-node.
export {
  decideIntakeConvergence,
  isIntakeContract,
  isStalledAcceptedGoalRunner,
  serializeAcceptedGoalRunnerHandoff,
  shouldAutoStartAcceptedGoalRunner,
  shouldAutoStartAcceptedGoalRunnerFromChange,
  shouldResumeGoalRunnerAfterUserDecision,
  shouldRecoverAcceptedGoalRunnerOnConversationOpen,
} from '@peer-agent/runtime-node';
