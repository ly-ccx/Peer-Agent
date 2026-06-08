export type OpenClawWriteActionGroup = 'governance' | 'studio';

export type OpenClawWriteActionRisk = 'medium' | 'high' | 'critical';

export type OpenClawWriteActionGate =
  | 'cloud_org_policy'
  | 'effective_config'
  | 'operator_confirm'
  | 'audit_reason'
  | 'evidence_return'
  | 'local_runtime_binding'
  | 'idempotency_key'
  | 'dry_run_first';

export interface OpenClawWriteActionPolicy {
  readonly id: string;
  readonly group: OpenClawWriteActionGroup;
  readonly method: 'POST';
  readonly endpoint: string;
  readonly risk: OpenClawWriteActionRisk;
  readonly state: 'blocked_until_gated';
  readonly label: {
    readonly zhCN: string;
    readonly enUS: string;
  };
  readonly gates: readonly OpenClawWriteActionGate[];
  readonly evidence: readonly string[];
}

const GOVERNANCE_GATES = [
  'cloud_org_policy',
  'effective_config',
  'operator_confirm',
  'audit_reason',
  'evidence_return',
  'idempotency_key',
] as const satisfies readonly OpenClawWriteActionGate[];

const STUDIO_GATES = [
  'cloud_org_policy',
  'effective_config',
  'local_runtime_binding',
  'operator_confirm',
  'audit_reason',
  'evidence_return',
  'idempotency_key',
] as const satisfies readonly OpenClawWriteActionGate[];

export const OPENCLAW_WRITE_ACTION_POLICIES = [
  {
    id: 'governance.review_memory_candidate',
    group: 'governance',
    method: 'POST',
    endpoint: '/api/openclaw-governance/memory-candidates/review',
    risk: 'high',
    state: 'blocked_until_gated',
    label: { zhCN: '审核 Memory Candidate', enUS: 'Review Memory Candidate' },
    gates: [...GOVERNANCE_GATES, 'dry_run_first'],
    evidence: ['candidateId', 'decision', 'operatorWorkId', 'reason', 'beforeAfter'],
  },
  {
    id: 'governance.dispatch_zeus_backflow',
    group: 'governance',
    method: 'POST',
    endpoint: '/api/openclaw-governance/zeus-backflow-exports/dispatch',
    risk: 'high',
    state: 'blocked_until_gated',
    label: { zhCN: '派发 Zeus Backflow', enUS: 'Dispatch Zeus Backflow' },
    gates: GOVERNANCE_GATES,
    evidence: ['exportId', 'candidateIds', 'operatorWorkId', 'dispatchResult'],
  },
  {
    id: 'governance.run_simulation_eval',
    group: 'governance',
    method: 'POST',
    endpoint: '/api/openclaw-governance/simulation-evals/run',
    risk: 'medium',
    state: 'blocked_until_gated',
    label: { zhCN: '运行 Simulation Eval', enUS: 'Run Simulation Eval' },
    gates: [...GOVERNANCE_GATES, 'dry_run_first'],
    evidence: ['simulationEvalId', 'trainingRunId', 'scorecardId', 'operatorWorkId'],
  },
  {
    id: 'governance.approve_certification',
    group: 'governance',
    method: 'POST',
    endpoint: '/api/openclaw-governance/certifications/approve',
    risk: 'critical',
    state: 'blocked_until_gated',
    label: { zhCN: '批准 Certification', enUS: 'Approve Certification' },
    gates: GOVERNANCE_GATES,
    evidence: ['certificationId', 'operatorWorkId', 'reason', 'approvalSnapshot'],
  },
  {
    id: 'governance.promote_agent_release',
    group: 'governance',
    method: 'POST',
    endpoint: '/api/openclaw-governance/agent-releases/promote',
    risk: 'critical',
    state: 'blocked_until_gated',
    label: { zhCN: '晋升 Agent Release', enUS: 'Promote Agent Release' },
    gates: GOVERNANCE_GATES,
    evidence: ['releaseId', 'operatorWorkId', 'sourceChannel', 'targetChannel', 'approvalSnapshot'],
  },
  {
    id: 'governance.promote_release_channel',
    group: 'governance',
    method: 'POST',
    endpoint: '/api/openclaw-governance/release-channels/promote',
    risk: 'critical',
    state: 'blocked_until_gated',
    label: { zhCN: '晋升 Release Channel', enUS: 'Promote Release Channel' },
    gates: GOVERNANCE_GATES,
    evidence: ['channelId', 'operatorWorkId', 'releaseDiff', 'approvalSnapshot'],
  },
  {
    id: 'governance.run_upgrade_job',
    group: 'governance',
    method: 'POST',
    endpoint: '/api/openclaw-governance/upgrade-jobs/run',
    risk: 'critical',
    state: 'blocked_until_gated',
    label: { zhCN: '运行 Upgrade Job', enUS: 'Run Upgrade Job' },
    gates: [...GOVERNANCE_GATES, 'dry_run_first'],
    evidence: ['jobId', 'operatorWorkId', 'dryRunResult', 'executionResult'],
  },
  {
    id: 'governance.run_memory_backup',
    group: 'governance',
    method: 'POST',
    endpoint: '/api/openclaw-governance/memory-backup-jobs/run',
    risk: 'high',
    state: 'blocked_until_gated',
    label: { zhCN: '运行 Memory Backup', enUS: 'Run Memory Backup' },
    gates: GOVERNANCE_GATES,
    evidence: ['jobId', 'snapshotId', 'operatorWorkId', 'backupResult'],
  },
  {
    id: 'governance.run_memory_restore',
    group: 'governance',
    method: 'POST',
    endpoint: '/api/openclaw-governance/memory-restore-jobs/run',
    risk: 'critical',
    state: 'blocked_until_gated',
    label: { zhCN: '运行 Memory Restore', enUS: 'Run Memory Restore' },
    gates: [...GOVERNANCE_GATES, 'dry_run_first'],
    evidence: ['jobId', 'workspaceId', 'operatorWorkId', 'restoreDiff', 'restoreResult'],
  },
  {
    id: 'governance.trigger_schedule_policy',
    group: 'governance',
    method: 'POST',
    endpoint: '/api/openclaw-governance/schedule-policies/trigger',
    risk: 'high',
    state: 'blocked_until_gated',
    label: { zhCN: '触发 Schedule Policy', enUS: 'Trigger Schedule Policy' },
    gates: GOVERNANCE_GATES,
    evidence: ['schedulePolicyId', 'operatorWorkId', 'triggeredTrainingRuns'],
  },
  {
    id: 'governance.acknowledge_alert',
    group: 'governance',
    method: 'POST',
    endpoint: '/api/openclaw-governance/alert-incidents/acknowledge',
    risk: 'medium',
    state: 'blocked_until_gated',
    label: { zhCN: '确认 Alert Incident', enUS: 'Acknowledge Alert Incident' },
    gates: GOVERNANCE_GATES,
    evidence: ['incidentId', 'operatorWorkId', 'reason', 'incidentSnapshot'],
  },
  {
    id: 'governance.apply_remediation',
    group: 'governance',
    method: 'POST',
    endpoint: '/api/openclaw-governance/remediation-actions/apply',
    risk: 'critical',
    state: 'blocked_until_gated',
    label: { zhCN: '应用 Remediation Action', enUS: 'Apply Remediation Action' },
    gates: [...GOVERNANCE_GATES, 'dry_run_first'],
    evidence: ['actionId', 'operatorWorkId', 'dryRunResult', 'applyResult'],
  },
  {
    id: 'governance.open_human_takeover',
    group: 'governance',
    method: 'POST',
    endpoint: '/api/openclaw-governance/human-takeovers/open',
    risk: 'high',
    state: 'blocked_until_gated',
    label: { zhCN: '开启 Human Takeover', enUS: 'Open Human Takeover' },
    gates: GOVERNANCE_GATES,
    evidence: ['sourceType', 'targetTaskId', 'targetNodeId', 'operatorWorkId', 'reason'],
  },
  {
    id: 'governance.resolve_human_takeover',
    group: 'governance',
    method: 'POST',
    endpoint: '/api/openclaw-governance/human-takeovers/resolve',
    risk: 'high',
    state: 'blocked_until_gated',
    label: { zhCN: '关闭 Human Takeover', enUS: 'Resolve Human Takeover' },
    gates: GOVERNANCE_GATES,
    evidence: ['takeoverId', 'operatorWorkId', 'resolutionResult'],
  },
  {
    id: 'studio.register_runtime_node',
    group: 'studio',
    method: 'POST',
    endpoint: '/api/openclaw-studio/nodes/register',
    risk: 'critical',
    state: 'blocked_until_gated',
    label: { zhCN: '注册 Runtime Node', enUS: 'Register Runtime Node' },
    gates: STUDIO_GATES,
    evidence: ['nodeId', 'slots', 'capabilityTags', 'operatorWorkId', 'registrationResult'],
  },
  {
    id: 'studio.heartbeat_runtime_node',
    group: 'studio',
    method: 'POST',
    endpoint: '/api/openclaw-studio/nodes/:nodeId/heartbeat',
    risk: 'medium',
    state: 'blocked_until_gated',
    label: { zhCN: 'Runtime Node Heartbeat', enUS: 'Runtime Node Heartbeat' },
    gates: ['cloud_org_policy', 'local_runtime_binding', 'evidence_return', 'idempotency_key'],
    evidence: ['nodeId', 'slotStatus', 'heartbeatAt', 'runtimeFingerprint'],
  },
  {
    id: 'studio.sync_gateway_sessions',
    group: 'studio',
    method: 'POST',
    endpoint: '/api/openclaw-studio/gateway/sessions/sync',
    risk: 'high',
    state: 'blocked_until_gated',
    label: { zhCN: '同步 Gateway Sessions', enUS: 'Sync Gateway Sessions' },
    gates: STUDIO_GATES,
    evidence: ['nodeId', 'slotId', 'sessionCount', 'syncResult'],
  },
  {
    id: 'studio.report_task_evidence',
    group: 'studio',
    method: 'POST',
    endpoint: '/api/openclaw-studio/task-orders/:taskId/evidence',
    risk: 'high',
    state: 'blocked_until_gated',
    label: { zhCN: '上报 Task Evidence', enUS: 'Report Task Evidence' },
    gates: STUDIO_GATES,
    evidence: ['taskId', 'evidenceId', 'evidenceType', 'redactionPolicy', 'artifactRefId'],
  },
  {
    id: 'studio.apply_task_remediation',
    group: 'studio',
    method: 'POST',
    endpoint: '/api/openclaw-studio/task-orders/:taskId/remediation',
    risk: 'critical',
    state: 'blocked_until_gated',
    label: { zhCN: '应用 Task Remediation', enUS: 'Apply Task Remediation' },
    gates: [...STUDIO_GATES, 'dry_run_first'],
    evidence: ['taskId', 'remediationId', 'action', 'operatorWorkId', 'applyResult'],
  },
  {
    id: 'studio.task_order_lifecycle',
    group: 'studio',
    method: 'POST',
    endpoint: '/api/openclaw-studio/task-orders/:taskId/{admit|lease|phase|complete|fail}',
    risk: 'high',
    state: 'blocked_until_gated',
    label: { zhCN: 'Task Order 生命周期', enUS: 'Task Order Lifecycle' },
    gates: STUDIO_GATES,
    evidence: ['taskId', 'previousStatus', 'nextStatus', 'operatorWorkId', 'transitionReason'],
  },
  {
    id: 'studio.cleanup_runtime',
    group: 'studio',
    method: 'POST',
    endpoint: '/api/openclaw-studio/{nodes|task-orders}/:id/*cleanup',
    risk: 'high',
    state: 'blocked_until_gated',
    label: { zhCN: '清理 Runtime 状态', enUS: 'Cleanup Runtime State' },
    gates: STUDIO_GATES,
    evidence: ['targetId', 'failureReason', 'operatorWorkId', 'cleanupResult'],
  },
] as const satisfies readonly OpenClawWriteActionPolicy[];
