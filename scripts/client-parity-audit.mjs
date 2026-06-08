import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const requiredFiles = [
  '.env.example',
  'apps/desktop/electron/main/cloud-chat-service.mjs',
  'apps/desktop/electron/main/cloud-contract-probe.mjs',
  'apps/desktop/electron/main/cloud-contract-probe.test.mjs',
  'apps/desktop/electron/main/core-health.test.mjs',
  'apps/desktop/electron/main/env-loader.mjs',
  'apps/desktop/electron/main/main.mjs',
  'apps/desktop/electron/preload/preload.cjs',
  'apps/desktop/renderer/src/chat/api/chatClient.ts',
  'apps/desktop/renderer/src/chat/components/CloudChatSurface.tsx',
  'apps/desktop/renderer/src/chat/state/clientToolEvidence.ts',
  'apps/desktop/renderer/src/chat/state/clientToolEvidence.test.ts',
  'apps/desktop/renderer/src/chat/state/useCloudChatRuntime.ts',
  'apps/desktop/renderer/src/chat/state/channelRuntime.ts',
  'packages/chat-kernel/src/chat-reducer.ts',
  'packages/chat-kernel/src/confirmation-reducer.ts',
  'packages/chat-kernel/src/message-actions.ts',
  'packages/chat-kernel/src/stream-parser.ts',
  'packages/chat-kernel/src/thinking-reducer.ts',
  'packages/task-thread/src/index.ts',
  'packages/task-thread/src/task-thread.test.ts',
  'packages/protocol/src/agent-memory-write-policy.ts',
  'packages/protocol/src/billing.ts',
  'packages/protocol/src/channel.ts',
  'packages/protocol/src/chat.ts',
  'packages/protocol/src/execution.ts',
  'packages/protocol/src/governance.ts',
  'packages/protocol/src/memory.ts',
  'packages/protocol/src/observability.ts',
  'packages/protocol/src/openclaw-governance.ts',
  'packages/protocol/src/openclaw-write-policy.ts',
  'packages/protocol/src/share.ts',
  'packages/protocol/src/statistics.ts',
  'packages/protocol/src/studio.ts',
  'docs/architecture/07-client-cloud-parity-completion-audit.md',
  'docs/architecture/08-prod-e2e-validation-runbook.md',
  'docs/architecture/09-high-risk-write-scope.md',
  'docs/architecture/11-client-runtime-cloud-contract-handoff.md',
  'docs/architecture/12-dev-0.0.1-review-summary.md',
  'docs/architecture/13-cloud-backend-contract-tasklist.md',
  'docs/architecture/cloud-contract-probe.2026-05-14.json',
  'docs/architecture/prod-e2e-report.template.json',
  'scripts/prod-e2e-checks.mjs',
  'scripts/client-parity-completion-audit.mjs',
  'scripts/prod-cloud-contract-probe.mjs',
  'scripts/prod-e2e-preflight.mjs',
  'scripts/create-prod-e2e-report.mjs',
  'scripts/load-dotenv.mjs',
  'scripts/validate-prod-e2e-report.mjs',
];

const requiredText = [
  ['packages/protocol/src/index.ts', "export * from './agent-memory-write-policy.ts';"],
  ['packages/protocol/src/index.ts', "export * from './openclaw-write-policy.ts';"],
  ['apps/desktop/renderer/src/chat/components/CloudChatSurface.tsx', 'ChannelEvidencePanel'],
  ['apps/desktop/renderer/src/chat/components/CloudChatSurface.tsx', 'OpenClawWriteGatePanel'],
  ['apps/desktop/renderer/src/chat/components/CloudChatSurface.tsx', 'AgentMemoryWriteGatePanel'],
  ['apps/desktop/renderer/src/chat/components/CloudChatSurface.tsx', 'AgentMemoryReviewPanel'],
  ['apps/desktop/renderer/src/chat/components/CloudChatSurface.tsx', 'ChatStatisticsPanel'],
  ['apps/desktop/electron/main/cloud-chat-service.mjs', '/api/chat/statistics/export'],
  ['apps/desktop/renderer/src/chat/components/CloudChatSurface.tsx', 'exportChatStatistics'],
  ['apps/desktop/renderer/src/chat/components/CloudChatSurface.tsx', 'OpenClawGovernancePanel'],
  ['apps/desktop/renderer/src/chat/components/CloudChatSurface.tsx', 'OpenClawStudioPanel'],
  ['apps/desktop/renderer/src/chat/components/CloudChatSurface.tsx', 'probeCloudContracts'],
  ['apps/desktop/renderer/src/chat/state/useCloudChatRuntime.ts', 'markClientToolResultReturnedToCloud(rawResult)'],
  ['apps/desktop/renderer/src/chat/state/useCloudChatRuntime.ts', 'rejectClientToolCall'],
  ['apps/desktop/renderer/src/chat/state/useCloudChatRuntime.ts', 'returnClientToolEvidence'],
  ['apps/desktop/renderer/src/App.tsx', 'setRuntimeProjectionId(response.data.projectionId)'],
  ['apps/desktop/renderer/src/App.tsx', 'runtimeProjectionId={runtimeProjectionId}'],
  ['apps/desktop/renderer/src/chat/state/useCloudChatRuntime.ts', 'projectionId: runtimeProjectionId ?? undefined'],
  ['apps/desktop/renderer/src/chat/state/useCloudChatRuntime.ts', 'clientToolGrants'],
  ['apps/desktop/renderer/src/chat/state/clientToolEvidence.test.ts', 'marks the outbound cloud payload evidence'],
  ['apps/desktop/renderer/src/chat/state/clientToolEvidence.test.ts', 'records local adapter failures as evidence'],
  ['apps/desktop/renderer/src/chat/state/clientToolEvidence.test.ts', 'records local user denial as evidence'],
  ['apps/desktop/electron/main/main.mjs', "duration: granted ? 'once' : 'denied'"],
  ['apps/desktop/electron/preload/preload.cjs', 'denyLocalAction'],
  ['packages/i18n/src/index.ts', "'review.deny'"],
  ['packages/i18n/src/index.ts', "'review.returnEvidence'"],
  ['apps/desktop/package.json', '"test": "node --test electron/main/*.test.mjs renderer/src/chat/state/*.test.ts"'],
  ['apps/desktop/electron/main/cloud-contract-probe.test.mjs', 'classifyCloudContractStatus separates route existence from blockers'],
  ['apps/desktop/electron/main/cloud-contract-probe.test.mjs', 'createExpectedCloudContractProbeContracts exposes the route contract audited by completion checks'],
  ['apps/desktop/electron/main/cloud-contract-probe.test.mjs', 'createCloudContractProbes applies local proxy route overrides to runtime handoff probes'],
  ['apps/desktop/electron/main/core-health.test.mjs', 'runHealthStub returns failed evidence when the Rust core binary is missing'],
  ['apps/desktop/electron/main/core-health.test.mjs', 'runHealthStub executes the Rust core command and wraps success evidence'],
  ['packages/task-thread/package.json', '"test": "node --test src/*.test.ts"'],
  ['packages/task-thread/src/index.ts', '`evt_artifact_${result.evidence.evidenceId}`'],
  ['packages/task-thread/src/task-thread.test.ts', 'attaches denied results and creates stable evidence artifact ids'],
  ['packages/i18n/src/index.ts', "'chat.localProxy.probeContracts'"],
  ['packages/i18n/src/index.ts', "'chat.openclawWriteGate.title'"],
  ['packages/i18n/src/index.ts', "'chat.memoryWriteGate.title'"],
  ['docs/architecture/07-client-cloud-parity-completion-audit.md', 'Status: not complete'],
  ['docs/architecture/07-client-cloud-parity-completion-audit.md', 'codex/zeus-atlas-client-runtime-contracts'],
  ['docs/architecture/07-client-cloud-parity-completion-audit.md', '5c8272e Cover client runtime validation status'],
  ['docs/architecture/07-client-cloud-parity-completion-audit.md', 'blockerCount: 6'],
  ['docs/architecture/08-prod-e2e-validation-runbook.md', 'pnpm@10.22.0 prod-e2e:validate'],
  ['docs/architecture/08-prod-e2e-validation-runbook.md', 'pnpm@10.22.0 prod-e2e:preflight'],
  ['docs/architecture/08-prod-e2e-validation-runbook.md', 'pnpm@10.22.0 prod-e2e:probe-contract'],
  ['docs/architecture/08-prod-e2e-validation-runbook.md', 'pnpm@10.22.0 prod-e2e:create-report'],
  ['docs/architecture/08-prod-e2e-validation-runbook.md', '--with-contract-probe'],
  ['docs/architecture/09-high-risk-write-scope.md', '`0.0.1` 不开放 OpenClaw Governance'],
  ['docs/architecture/09-high-risk-write-scope.md', 'blocked_until_gated'],
  ['docs/architecture/11-client-runtime-cloud-contract-handoff.md', 'POST /api/client/runtime/tasks/poll'],
  ['docs/architecture/11-client-runtime-cloud-contract-handoff.md', 'POST /api/chat/client-tool/result'],
  ['docs/architecture/11-client-runtime-cloud-contract-handoff.md', 'POST /api/client/runtime/projection'],
  ['docs/architecture/11-client-runtime-cloud-contract-handoff.md', 'The cloud must not call local ports directly.'],
  ['docs/architecture/cloud-contract-probe.2026-05-14.json', '"blockerCount": 6'],
  ['docs/architecture/cloud-contract-probe.2026-05-14.json', '"/api/client/runtime/tasks/poll"'],
  ['package.json', '"prod-e2e:preflight": "node scripts/prod-e2e-preflight.mjs"'],
  ['package.json', '"parity:completion-audit": "node scripts/client-parity-completion-audit.mjs"'],
  ['package.json', '"prod-e2e:probe-contract": "node scripts/prod-cloud-contract-probe.mjs"'],
  ['package.json', '"prod-e2e:create-report": "node scripts/create-prod-e2e-report.mjs"'],
  ['package.json', '"prod-e2e:validate": "node scripts/validate-prod-e2e-report.mjs"'],
  ['.env.example', 'ZEUS_ATLAS_BUC_CLIENT_ID=cbu-xiaoer-node-service'],
  ['.env.example', 'ZEUS_ATLAS_CLOUD_GATEWAY_URL=https://cbu-xiaoer-service.alibaba-inc.com'],
  ['README.md', './docs/architecture/11-client-runtime-cloud-contract-handoff.md'],
  ['README.md', './docs/architecture/12-dev-0.0.1-review-summary.md'],
  ['README.md', './docs/architecture/13-cloud-backend-contract-tasklist.md'],
  ['README.md', 'prod-e2e:probe-contract'],
  ['README.md', 'parity:completion-audit'],
  ['docs/architecture/12-dev-0.0.1-review-summary.md', 'client implementation ready for review'],
  ['docs/architecture/12-dev-0.0.1-review-summary.md', 'parity:completion-audit'],
  ['docs/architecture/12-dev-0.0.1-review-summary.md', 'prod-e2e:validate'],
  ['docs/architecture/13-cloud-backend-contract-tasklist.md', 'Backend Issue Checklist'],
  ['docs/architecture/13-cloud-backend-contract-tasklist.md', 'codex/zeus-atlas-client-runtime-contracts'],
  ['docs/architecture/13-cloud-backend-contract-tasklist.md', '5c8272e Cover client runtime validation status'],
  ['docs/architecture/13-cloud-backend-contract-tasklist.md', 'ai_chat_tool_calls'],
  ['docs/architecture/13-cloud-backend-contract-tasklist.md', '`422` validation'],
  ['docs/architecture/13-cloud-backend-contract-tasklist.md', 'controller coverage'],
  ['docs/architecture/13-cloud-backend-contract-tasklist.md', 'POST /api/client/runtime/projection'],
  ['docs/architecture/13-cloud-backend-contract-tasklist.md', 'prod-e2e:probe-contract'],
  ['scripts/prod-e2e-preflight.mjs', 'parsed.protocol === \'https:\''],
  ['scripts/prod-e2e-preflight.mjs', 'preHost: isPreHost'],
  ['scripts/prod-e2e-preflight.mjs', 'Cloud Gateway URL is configured with HTTPS'],
  ['scripts/prod-e2e-preflight.mjs', 'cloudGatewayReachable'],
  ['scripts/prod-e2e-preflight.mjs', "method: 'HEAD'"],
  ['scripts/prod-cloud-contract-probe.mjs', '--json'],
  ['scripts/prod-cloud-contract-probe.mjs', '--out <snapshot.json>'],
  ['scripts/prod-cloud-contract-probe.mjs', 'writeSnapshot(report, args.out)'],
  ['scripts/validate-prod-e2e-report.mjs', "git(['rev-parse', 'HEAD'])"],
  ['scripts/validate-prod-e2e-report.mjs', 'commit must match current HEAD'],
  ['scripts/validate-prod-e2e-report.mjs', 'cloudContractProbe.results must be an array'],
  ['scripts/validate-prod-e2e-report.mjs', 'cloudContractProbe.blockerCount must be 0 for production acceptance'],
  ['scripts/validate-prod-e2e-report.mjs', 'CLOUD_CONTRACT_BLOCKER_CLASSES'],
  ['scripts/create-prod-e2e-report.mjs', '--with-contract-probe'],
  ['scripts/client-parity-completion-audit.mjs', 'Client-cloud parity completion audit blocked'],
  ['scripts/client-parity-completion-audit.mjs', 'branchVersion'],
  ['scripts/client-parity-completion-audit.mjs', "const REQUIRED_BRANCH = 'dev/0.0.1';"],
  ['scripts/client-parity-completion-audit.mjs', 'prodValidation'],
  ['scripts/client-parity-completion-audit.mjs', 'taskThreadEvidenceArtifacts'],
  ['scripts/client-parity-completion-audit.mjs', 'cloudContractSnapshot'],
  ['scripts/client-parity-completion-audit.mjs', 'cloud-contract-probe.<date>.json'],
  ['apps/desktop/electron/main/main.mjs', 'loadLocalEnv({ workspaceRoot })'],
  ['scripts/prod-e2e-preflight.mjs', 'loadDotenv()'],
  ['apps/desktop/electron/main/cloud-contract-probe.mjs', '/api/client/runtime/tasks/poll'],
  ['apps/desktop/electron/main/cloud-contract-probe.mjs', '/api/client/runtime/projection'],
  ['apps/desktop/electron/main/cloud-contract-probe.mjs', '/api/openclaw-governance/effective-agent-config/resolve-conversation'],
];

const forbiddenText = [
  ['docs/architecture/08-prod-e2e-validation-runbook.md', 'prod-e2e:probe-contract -- --json'],
  ['docs/architecture/08-prod-e2e-validation-runbook.md', 'prod-e2e:probe-contract -- --out'],
  ['docs/architecture/11-client-runtime-cloud-contract-handoff.md', 'prod-e2e:probe-contract -- --out'],
];

const requiredEndpoints = [
  '/api/openclaw-governance/certifications/approve',
  '/api/openclaw-governance/agent-releases/promote',
  '/api/openclaw-governance/remediation-actions/apply',
  '/api/openclaw-studio/nodes/register',
  '/api/openclaw-studio/task-orders/:taskId/evidence',
  '/api/agent-memory/migrations/backfill-prior-confidence',
  '/api/agent-memory/migrations/simulate-trial',
  '/api/agent-memory/migrations/simulate-shadow-evaluation',
];

const errors = [];

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) {
    errors.push(`missing required artifact: ${file}`);
  }
}

for (const [file, snippet] of requiredText) {
  if (!existsSync(join(root, file))) {
    continue;
  }
  const text = read(file);
  if (!text.includes(snippet)) {
    errors.push(`${file}: missing snippet ${snippet}`);
  }
}

for (const [file, snippet] of forbiddenText) {
  if (!existsSync(join(root, file))) {
    continue;
  }
  const text = read(file);
  if (text.includes(snippet)) {
    errors.push(`${file}: forbidden snippet ${snippet}`);
  }
}

const writePolicyFiles = [
  'packages/protocol/src/openclaw-write-policy.ts',
  'packages/protocol/src/agent-memory-write-policy.ts',
];

for (const file of writePolicyFiles) {
  const text = read(file);
  const policyCount = (text.match(/id: '/g) ?? []).length;
  const blockedCount = (text.match(/^\s+state: 'blocked_until_gated',/gm) ?? []).length;
  const nonBlockedState = text.match(/^\s+state: '(?!blocked_until_gated)[^']+',/gm);
  if (policyCount === 0) {
    errors.push(`${file}: no write policies found`);
  }
  if (blockedCount !== policyCount) {
    errors.push(`${file}: expected every write policy to be blocked (${blockedCount}/${policyCount})`);
  }
  if (nonBlockedState) {
    errors.push(`${file}: found non-blocked write state ${nonBlockedState.join(', ')}`);
  }
}

const allPolicyText = writePolicyFiles.map(read).join('\n');
for (const endpoint of requiredEndpoints) {
  if (!allPolicyText.includes(endpoint)) {
    errors.push(`write policy missing endpoint: ${endpoint}`);
  }
}

if (errors.length > 0) {
  console.error('Client parity audit failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Client parity audit passed: ${requiredFiles.length} artifacts, ${requiredEndpoints.length} gated write endpoints.`);
