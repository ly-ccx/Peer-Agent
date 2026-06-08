export type AgentMemoryWriteActionRisk = 'medium' | 'high' | 'critical';

export type AgentMemoryWriteActionGate =
  | 'pre_or_local_only'
  | 'dry_run_default'
  | 'confirm_pre'
  | 'operator_confirm'
  | 'audit_reason'
  | 'no_auto_cloud_patch'
  | 'evidence_return'
  | 'llm_cost_ack';

export interface AgentMemoryWriteActionPolicy {
  readonly id: string;
  readonly method: 'POST';
  readonly endpoint: string;
  readonly risk: AgentMemoryWriteActionRisk;
  readonly state: 'blocked_until_gated';
  readonly label: {
    readonly zhCN: string;
    readonly enUS: string;
  };
  readonly gates: readonly AgentMemoryWriteActionGate[];
  readonly evidence: readonly string[];
}

const BASE_MEMORY_GATES = [
  'pre_or_local_only',
  'operator_confirm',
  'audit_reason',
  'no_auto_cloud_patch',
  'evidence_return',
] as const satisfies readonly AgentMemoryWriteActionGate[];

export const AGENT_MEMORY_WRITE_ACTION_POLICIES = [
  {
    id: 'agent_memory.backfill_prior_confidence',
    method: 'POST',
    endpoint: '/api/agent-memory/migrations/backfill-prior-confidence',
    risk: 'critical',
    state: 'blocked_until_gated',
    label: { zhCN: '回填 Patch Prior Confidence', enUS: 'Backfill Patch Prior Confidence' },
    gates: [...BASE_MEMORY_GATES, 'dry_run_default', 'confirm_pre'],
    evidence: ['dryRun', 'batchSize', 'limit', 'operatorWorkId', 'affectedPatchCount', 'beforeAfter'],
  },
  {
    id: 'agent_memory.peek_confidence',
    method: 'POST',
    endpoint: '/api/agent-memory/migrations/peek-confidence',
    risk: 'medium',
    state: 'blocked_until_gated',
    label: { zhCN: '查看 Patch Confidence', enUS: 'Peek Patch Confidence' },
    gates: BASE_MEMORY_GATES,
    evidence: ['patchUuid', 'agentId', 'limit', 'operatorWorkId', 'returnedRows'],
  },
  {
    id: 'agent_memory.simulate_trial',
    method: 'POST',
    endpoint: '/api/agent-memory/migrations/simulate-trial',
    risk: 'high',
    state: 'blocked_until_gated',
    label: { zhCN: '模拟 Patch Trial', enUS: 'Simulate Patch Trial' },
    gates: [...BASE_MEMORY_GATES, 'confirm_pre'],
    evidence: ['patchUuid', 'outcome', 'source', 'operatorWorkId', 'trialDelta', 'updatedConfidence'],
  },
  {
    id: 'agent_memory.simulate_shadow_evaluation',
    method: 'POST',
    endpoint: '/api/agent-memory/migrations/simulate-shadow-evaluation',
    risk: 'critical',
    state: 'blocked_until_gated',
    label: { zhCN: '模拟 Shadow Evaluation', enUS: 'Simulate Shadow Evaluation' },
    gates: [...BASE_MEMORY_GATES, 'confirm_pre', 'llm_cost_ack'],
    evidence: ['agentId', 'patchUuids', 'modelId', 'execution', 'scope', 'operatorWorkId', 'llmEvalResult'],
  },
] as const satisfies readonly AgentMemoryWriteActionPolicy[];
