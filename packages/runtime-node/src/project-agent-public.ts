/** Stable project-agent entry; implementations do not re-export the aggregate root. */
export {
  PROJECT_AGENT_ALLOWED_CAPABILITIES,
  evaluateProjectAgentTurn,
  isProjectAgentCapabilityAllowed,
  isProjectAgentDeniedPermissionKind,
  isProjectAgentTurn,
} from './project-agent/mode-policy.mjs';
export { createDelegationProvider } from './project-agent/delegation-provider.mjs';
export {
  createSessionSupervisor,
  evaluateWorkSessionWrite,
} from './project-agent/session-supervisor.mjs';
export {
  PROGRESS_THROTTLE_MS,
  delegationEventId,
  mapDelegationEvents,
} from './project-agent/event-mapper.mjs';
export {
  STALL_WINDOW_MS,
  assessSameCause,
  assessStall,
  delegationFactsForWorkspace,
  describeFailure,
  watchFactsFromPlan,
} from './project-agent/watchdog.mjs';
export { createWatchPublisher } from './project-agent/watch-publisher.mjs';
export { createProjectInbox } from './project-agent/project-inbox.mjs';
export { createInputQueue, inputMessageId } from './project-agent/input-queue.mjs';
export { createBotDirectory } from './project-agent/bot-directory.mjs';
export { createBotSummaryHistory, projectBotSummaryHistory } from './project-agent/bot-summary-history.mjs';
export { createBotSearchHistory, projectBotSearchHistory } from './project-agent/bot-search-history.mjs';
export { createBotConversationHistory, projectBotConversationHistory } from './project-agent/bot-conversation-history.mjs';
export {
  collectConversationSearchDocuments,
  createConversationSearchIndex,
} from './project-agent/conversation-search-index.mjs';
export {
  classicNeedsYouCount,
  projectClassicGoals,
  projectHistory,
} from './project-agent/history-projection.mjs';
export {
  cleanDisplayName,
  createBotProfileStore,
} from './project-agent/bot-profile-store.mjs';
export { createBotLifecycle } from './project-agent/bot-lifecycle.mjs';
export {
  USER_TURN_LIMITS,
  WAKE_TURN_LIMITS,
  finishAgentTurn,
  planAgentTurn,
} from './project-agent/agent-turn-plan.mjs';
export {
  SAME_PROVIDER_RETRY_DELAYS_MS,
  createProjectAgentRunner,
} from './project-agent/runner.mjs';
export { composeReply } from './project-agent/reply-composer.mjs';
export { prepareReplyReport } from './project-agent/reply-report-facts.mjs';
export {
  BOT_LEVELS,
  GLOBAL_LEVELS,
  TOOL_LEVELS,
  createDigestQueue,
  defaultProjectAgentSettings,
  digestSeparator,
  inQuietHours,
  normalizeProjectAgentSettings,
  planDelivery,
  resolveBotLevel,
} from './project-agent/digest.mjs';
export { verdictRefFor } from './project-agent/acceptance.mjs';
export { createCardProjection, projectCards } from './project-agent/card-projection.mjs';
export {
  DELEGATION_CAPABILITY_IDS,
  DELEGATION_TOOL_SPECS,
  delegationSpecByCapability,
  validateDelegationInput,
  MEMORY_CAPABILITY_IDS,
  MEMORY_TOOL_SPECS,
  memorySpecByCapability,
  validateMemoryInput,
} from './project-agent/tool-specs.mjs';
export { createMemoryStore, isMemoryWorkspaceId, isEffectiveMemory } from './memory/memory-store.mjs';
export { createMemoryMaintenance } from './memory/maintenance.mjs';
export { createMemoryFileAnchors } from './memory/file-anchors.mjs';
export { createMemoryIndex } from './memory/memory-index.mjs';
export { memorySecretReason } from './memory/memory-redaction.mjs';
export { createSnapshot, readSnapshots } from './memory/memory-snapshot.mjs';
export { createMemoryProvider } from './memory/memory-provider.mjs';
export {
  CURATOR_INTERVAL_MS,
  USER_INPUTS_PER_RUN,
  createEpisodeLog,
  isTaskEndEvent,
} from './memory/episodes.mjs';
export {
  decideMemoryAdmission,
  parseCuratorOutput,
  validateCuratorCandidate,
} from './memory/admission-policy.mjs';
export {
  CURATOR_EXCLUDED_CAPABILITY_PREFIXES,
  createMemoryCurator,
  curatorTurnRequest,
} from './memory/curator.mjs';
export {
  looksLikeExplicitNewRequest,
  pickRecentCompletedPlan,
  resolveDerivedPlanRelation,
} from './goal-plan-relation.mjs';
export {
  attachWorkspaceHeadBinding,
  readWorkspaceHead,
  resolveWorkspaceHead,
} from './goal-delivery-binding.mjs';
export {
  buildGoalAcceptanceReport,
} from './goal-acceptance-report.mjs';
export {
  computePlanScopeSnapshot,
  computeReanchorInterval,
  createDeterministicExplorePlan,
  createGoalRunner,
  detectPlanDrift,
  evaluateVerificationGate,
  shouldReanchor,
} from './goal-runner.mjs';
export {
  buildGoalRunnerTickMessage,
  describeVisualRepair,
  normalizeVisualRepair,
  projectVisualRepairFeedback,
  scheduleVisualRepair,
} from './goal-visual-repair.mjs';
export {
  decideIntakeConvergence,
  isIntakeContract,
  isStalledAcceptedGoalRunner,
  serializeAcceptedGoalRunnerHandoff,
  shouldAutoStartAcceptedGoalRunner,
  shouldAutoStartAcceptedGoalRunnerFromChange,
  shouldRearmFailedGoalPlanFromChange,
  shouldResumeGoalRunnerAfterUserDecision,
  shouldRecoverAcceptedGoalRunnerOnConversationOpen,
} from './goal-intake-convergence.mjs';
export { createExecutionScheduler, normalizeConcurrency } from './project-agent/execution-scheduler.mjs';
export {
  createIsolationPlanner,
  decideIsolation,
  MIN_WORKTREE_FREE_BYTES,
  FAILED_WORKTREE_RETENTION_MS,
} from './project-agent/isolation-planner.mjs';
export { createCircuitBreaker, CIRCUIT_FAILURE_LIMIT, CIRCUIT_COOLDOWN_MS } from './project-agent/circuit-breaker.mjs';
export { createProjectRecovery, RECOVERY_PHASES } from './project-agent/recovery.mjs';
export { createObjectiveStore, validateObjectiveDefinition } from './project-agent/objective-store.mjs';
export { createObjectiveService } from './project-agent/objective-service.mjs';
export { OBJECTIVE_TOOL_SPECS, validateObjectiveToolInput } from './project-agent/objective-tool-specs.mjs';
export { createWatchState } from './project-agent/watch-state.mjs';
export { createWatchRunner } from './project-agent/watch-runner.mjs';
export { createWatchProbeRuntime } from './project-agent/watch-probe-provider.mjs';
export { mapObjectiveObservationEvent } from './project-agent/event-mapper.mjs';
export {createObjectiveActions,objectiveActionCardId} from './project-agent/objective-actions.mjs';
export { createDesktopReplyComposer } from './project-agent/reply-composer-port.mjs';
export { createSessionVerification } from './project-agent/session-verification.mjs';
export { createDesktopProjectFacts } from './project-agent/project-facts.mjs';
export { createProjectLifecycleEffects } from './project-agent/project-lifecycle-effects.mjs';
export { runObjectiveProbeTurn } from './project-agent/objective-probe-turn.mjs';
export { createDesktopObjectiveWatchHost } from './project-agent/objective-watch-host.mjs';
export { curatorModelProviderId, runMemoryCuratorTurn } from './project-agent/memory-curator-turn.mjs';
export { createProjectAgentHost } from './project-agent/runtime-host.mjs';
export { createCollectingSink, createCallbackSink } from './project-agent/turn-sinks.mjs';
export { conversationPrefersWorktree, preparePlanExecutionWorkspace } from './project-agent/goal-preferred-worktree.mjs';
export {
  inspectSourceCheckout,
  commitSourceCheckout,
  stashSourceCheckout,
  resolveHandoffConflicts,
  previewHandoffMerge,
  cleanupHandoffPreview,
  triageTaskLine,
  createGoalDeliveryHandoff,
} from './project-agent/goal-delivery-handoff.mjs';
export {
  createGoalRunnerAssistantPlaceholder,
  buildGoalRunnerStreamStartedPayload,
  mapGoalTurnOutcome,
} from './project-agent/goal-runner-message-persistence.mjs';
export { resolveGoalSitePath, createGoalWorktreeAdapter } from './project-agent/goal-worktree-adapter.mjs';
export { createAutomationWorktreeAdapter } from './project-agent/automation-worktree-adapter.mjs';
export {
  isDelegatedWorkSession,
  resolveDelegatedWorkTurn,
  resolveWorkSessionProfile,
  WORK_SESSION_EXCLUDED_CAPABILITY_PREFIXES,
} from './project-agent/work-session-profile.mjs';
export { finalVerifierText, decodeVerifierReport, runVerifierWithReport } from './project-agent/verifier-report.mjs';
export { runBoundedVerification, isVerificationTurn, verificationExecutionBudget } from './project-agent/verifier-lifecycle.mjs';
export { verifierEvidenceSnapshots } from './project-agent/verifier-evidence.mjs';
export { createGoalTaskBranchAdapter, slugifyTaskBranchName, planNeedsTaskBranch } from './project-agent/goal-task-branch.mjs';
export { createProjectGoalRunnerHost, buildGoalRunnerMessage } from './project-agent/goal-runner-host.mjs';
export { createProjectDiagnostics, diagnosticText } from './project-agent/diagnostics.mjs';
export { createOneTimeApprovalBook } from './project-agent/one-time-approval.mjs';
export { projectToolDescription } from './project-agent/tool-prompts.generated.mjs';
export { presentEvidence, evidenceRefAllowed, evidenceBodyFromRecord } from './project-agent/evidence-presenter.mjs';
export { instructionLinesFromText, readProjectInstructionLines } from './project-agent/project-instruction-lines.mjs';
export { fileEvidencePreview } from './project-agent/file-evidence-preview.mjs';
export { evidenceBodyFromHistory, evidenceSourceDescription } from './project-agent/evidence-presenter.mjs';
export { toolResultEvidencePreview } from './project-agent/tool-result-evidence-preview.mjs';
export { truncatePreview, redactShellOutput, outputRedactions } from './project-agent/output-redaction.mjs';
export { shouldPauseForHostHandoff, isHostHandoffPause } from './project-agent/session-host-handoff.mjs';
export { createWorkBudgetGuard, registerWorkBudget, DEFAULT_WORK_BUDGET } from './project-agent/work-budget.mjs';
export { createLegacyCriterionRecovery } from './project-agent/criterion-recovery.mjs';
export { agentMessagesForContext, createAgentCommunication } from './project-agent/agent-communication.mjs';
export { agentDelivery, recordAgentContextAdmission } from './project-agent/agent-delivery.mjs';
export { createAgentEventPublisher } from './project-agent/agent-activity.mjs';
export { agentCommunicationExcludedPrefixes } from './project-agent/work-session-profile.mjs';
export {
  createImageReadAuthority,
  resolvePermissionPrincipal,
  permissionOperationKey,
  IMAGE_READ_GRANT_TTL_MS,
} from './project-agent/permission-inheritance.mjs';
export { createBotAccessPolicyAuthority } from './project-agent/bot-access-policy.mjs';
export { evaluateDelegationCapabilities, delegationCapabilityRequirements } from './project-agent/capability-admission.mjs';
export { capabilityDenial } from './project-agent/capability-denial.mjs';
export * from './project-agent/input-draft-store.mjs';
export * from './project-agent/resource-edit-storage.mjs';
export { inspectCoordinationFork, recoverCoordinationForkBackup } from './project-agent/coordination-fork-recovery.mjs';
export { createCoordinationRecoveryService } from './project-agent/coordination-recovery-service.mjs';
export { executionOwnershipOf } from './project-agent/session-facts.mjs';
export { createWorkingContextProvider } from './project-agent/working-context-provider.mjs';
export { readWorkingContext } from './project-agent/working-context.mjs';
export { CONTINUITY_TOOL_SPECS, CONTINUITY_CAPABILITY_IDS, WORKING_CONTEXT_DESCRIPTION } from './project-agent/working-context-specs.mjs';
