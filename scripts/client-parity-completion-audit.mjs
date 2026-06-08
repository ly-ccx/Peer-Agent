import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLOUD_CONTRACT_BLOCKER_CLASSES,
  createExpectedCloudContractProbeContracts,
} from '../apps/desktop/electron/main/cloud-contract-probe.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_BRANCH = 'dev/0.0.1';
const REQUIRED_VERSION = '0.0.1';
const prodReportPattern = /^prod-e2e-report\..+\.json$/;
const cloudContractSnapshotPattern = /^cloud-contract-probe\..+\.json$/;
const expectedCloudContractProbes = createExpectedCloudContractProbeContracts();

function pathExists(relativePath) {
  return existsSync(join(root, relativePath));
}

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function hasText(relativePath, text) {
  return pathExists(relativePath) && read(relativePath).includes(text);
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function packageVersion() {
  try {
    return JSON.parse(read('package.json')).version ?? '';
  } catch {
    return '';
  }
}

function validateProdReports() {
  const architectureDir = join(root, 'docs/architecture');
  const reports = readdirSync(architectureDir)
    .filter((entry) => prodReportPattern.test(entry))
    .map((entry) => `docs/architecture/${entry}`)
    .filter((entry) => entry !== 'docs/architecture/prod-e2e-report.template.json');

  const validated = [];
  const failed = [];
  for (const report of reports) {
    try {
      execFileSync('node', ['scripts/validate-prod-e2e-report.mjs', report], {
        cwd: root,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      validated.push(report);
    } catch (error) {
      failed.push({
        report,
        message: error.stderr?.toString().trim() || error.message,
      });
    }
  }
  return { reports, validated, failed };
}

function validateCloudContractSnapshots() {
  const architectureDir = join(root, 'docs/architecture');
  const snapshots = readdirSync(architectureDir)
    .filter((entry) => cloudContractSnapshotPattern.test(entry))
    .map((entry) => `docs/architecture/${entry}`)
    .sort();

  const valid = [];
  const failed = [];
  for (const snapshot of snapshots) {
    try {
      const parsed = JSON.parse(read(snapshot));
      const snapshotErrors = [];
      if (typeof parsed.origin !== 'string' || parsed.origin.trim().length === 0) {
        snapshotErrors.push('origin must be a non-empty string');
      }
      if (typeof parsed.checkedAt !== 'string' || parsed.checkedAt.trim().length === 0) {
        snapshotErrors.push('checkedAt must be a non-empty string');
      }
      if (!Array.isArray(parsed.results)) {
        failed.push({ snapshot, message: 'results must be an array' });
        continue;
      }
      if (typeof parsed.blockerCount !== 'number') {
        failed.push({ snapshot, message: 'blockerCount must be a number' });
        continue;
      }

      const resultsById = new Map();
      let computedBlockerCount = 0;
      for (const [index, result] of parsed.results.entries()) {
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          snapshotErrors.push(`results[${index}] must be an object`);
          continue;
        }
        for (const key of ['id', 'method', 'path', 'class']) {
          if (typeof result[key] !== 'string' || result[key].trim().length === 0) {
            snapshotErrors.push(`results[${index}].${key} must be a non-empty string`);
          }
        }
        if (typeof result.id === 'string') {
          if (resultsById.has(result.id)) {
            snapshotErrors.push(`duplicate result id: ${result.id}`);
          }
          resultsById.set(result.id, result);
        }
        if (typeof result.class === 'string' && CLOUD_CONTRACT_BLOCKER_CLASSES.has(result.class)) {
          computedBlockerCount += 1;
        }
      }

      for (const { id, method, path } of expectedCloudContractProbes) {
        const result = resultsById.get(id);
        if (!result) {
          snapshotErrors.push(`missing contract result: ${id}`);
          continue;
        }
        if (result.method !== method) {
          snapshotErrors.push(`${id}: method must be ${method}, got ${JSON.stringify(result.method)}`);
        }
        if (result.path !== path) {
          snapshotErrors.push(`${id}: path must be ${path}, got ${JSON.stringify(result.path)}`);
        }
      }

      if (parsed.blockerCount !== computedBlockerCount) {
        snapshotErrors.push(`blockerCount mismatch: reported ${parsed.blockerCount}, computed ${computedBlockerCount}`);
      }

      if (snapshotErrors.length > 0) {
        failed.push({ snapshot, message: snapshotErrors.join('; ') });
        continue;
      }
      valid.push(snapshot);
    } catch (error) {
      failed.push({
        snapshot,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { snapshots, valid, failed };
}

function allFiles(paths) {
  return paths.every(pathExists);
}

function completionItem(id, requirement, ok, evidence, blocker = '') {
  return {
    id,
    requirement,
    status: ok ? 'pass' : 'blocked',
    evidence,
    blocker,
  };
}

const prodReports = validateProdReports();
const cloudContractSnapshots = validateCloudContractSnapshots();
const latestCloudContractSnapshot = cloudContractSnapshots.valid.at(-1);
const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const currentVersion = packageVersion();
const checks = [
  completionItem(
    'branchVersion',
    'The active workspace is on dev/0.0.1 with package version 0.0.1 before claiming client-cloud parity.',
    currentBranch === REQUIRED_BRANCH && currentVersion === REQUIRED_VERSION,
    `branch=${currentBranch}; version=${currentVersion || '<unknown>'}`,
    `Expected branch ${REQUIRED_BRANCH} and version ${REQUIRED_VERSION}.`,
  ),
  completionItem(
    'protocol',
    'Protocol contracts cover cloud/client chat runtime, execution, memory, share, billing, channel, governance, observability, statistics, studio, and gated write policies.',
    allFiles([
      'packages/protocol/src/chat.ts',
      'packages/protocol/src/execution.ts',
      'packages/protocol/src/memory.ts',
      'packages/protocol/src/share.ts',
      'packages/protocol/src/billing.ts',
      'packages/protocol/src/channel.ts',
      'packages/protocol/src/governance.ts',
      'packages/protocol/src/observability.ts',
      'packages/protocol/src/statistics.ts',
      'packages/protocol/src/studio.ts',
      'packages/protocol/src/openclaw-governance.ts',
      'packages/protocol/src/openclaw-write-policy.ts',
      'packages/protocol/src/agent-memory-write-policy.ts',
    ]),
    'packages/protocol/src/*',
    'Missing protocol contract files.',
  ),
  completionItem(
    'chatKernel',
    'Chat Kernel parses streams and maintains chat, thinking, confirmation, and message action state.',
    allFiles([
      'packages/chat-kernel/src/stream-parser.ts',
      'packages/chat-kernel/src/chat-reducer.ts',
      'packages/chat-kernel/src/thinking-reducer.ts',
      'packages/chat-kernel/src/confirmation-reducer.ts',
      'packages/chat-kernel/src/message-actions.ts',
    ]),
    'packages/chat-kernel/src/*',
    'Missing Chat Kernel files.',
  ),
  completionItem(
    'cloudGateway',
    'Electron Cloud Chat Gateway is the renderer-to-cloud exit and includes stream, message, execution, assistant, agent, share, memory, billing, governance, observability, statistics, studio, local proxy, and runtime projection APIs.',
    hasText('apps/desktop/electron/main/cloud-chat-service.mjs', 'startMessageStream') &&
      hasText('apps/desktop/electron/main/cloud-chat-service.mjs', 'publishRuntimeProjection') &&
      hasText('apps/desktop/electron/main/cloud-chat-service.mjs', 'pollClientToolCalls') &&
      hasText('apps/desktop/electron/preload/preload.cjs', 'startMessageStream'),
    'apps/desktop/electron/main/cloud-chat-service.mjs; apps/desktop/electron/preload/preload.cjs',
    'Cloud Gateway or preload surface is missing required runtime APIs.',
  ),
  completionItem(
    'realConversationFlow',
    'Renderer has real conversation list/detail/message flow, stream composer, timeline, Thinking/Tool/Confirmation UI, and message actions.',
    hasText('apps/desktop/renderer/src/chat/components/CloudChatSurface.tsx', 'ThinkingTimeline') &&
      hasText('apps/desktop/renderer/src/chat/components/CloudChatSurface.tsx', 'MessageActionBar') &&
      hasText('apps/desktop/renderer/src/chat/components/CloudChatSurface.tsx', 'resolveConfirmation') &&
      hasText('apps/desktop/renderer/src/chat/state/useCloudChatRuntime.ts', 'sendMessage'),
    'apps/desktop/renderer/src/chat/components/CloudChatSurface.tsx; apps/desktop/renderer/src/chat/state/useCloudChatRuntime.ts',
    'Real conversation runtime or timeline UI is missing required surfaces.',
  ),
  completionItem(
    'shareMemoryBillingChannel',
    'Share, Memory, Billing, and Channel parity are represented in protocol, gateway, runtime, and UI panels.',
    hasText('apps/desktop/renderer/src/chat/components/CloudChatSurface.tsx', 'ConversationContext') &&
      hasText('apps/desktop/renderer/src/chat/components/CloudChatSurface.tsx', 'ChannelEvidencePanel') &&
      hasText('apps/desktop/renderer/src/chat/state/channelRuntime.ts', 'CHANNEL_FILTERS') &&
      hasText('apps/desktop/electron/main/cloud-chat-service.mjs', 'getBillingSummary'),
    'ConversationContext; ChannelEvidencePanel; channelRuntime.ts; cloud-chat-service.mjs',
    'Share/Memory/Billing/Channel parity evidence is incomplete.',
  ),
  completionItem(
    'localProxyEvidenceBoundary',
    'Local capability proxy remains client initiated, permission reviewed, and evidence-return based; cloud cognition remains authoritative.',
    hasText('apps/desktop/renderer/src/chat/state/useCloudChatRuntime.ts', 'pollClientToolCalls') &&
      hasText('apps/desktop/renderer/src/chat/state/useCloudChatRuntime.ts', 'approveLocalAction') &&
      hasText('apps/desktop/renderer/src/chat/state/useCloudChatRuntime.ts', 'reportClientToolResult') &&
      hasText('docs/architecture/05-chat-parity-client-implementation.md', '云端负责认知') &&
      hasText('docs/architecture/05-chat-parity-client-implementation.md', '云端为准，个人为辅'),
    'useCloudChatRuntime.ts; docs/architecture/05-chat-parity-client-implementation.md',
    'Local proxy / evidence / cloud cognition boundary evidence is incomplete.',
  ),
  completionItem(
    'runtimeProjectionPollBinding',
    'Accepted Runtime Projection ids are carried from publish success into Local Capability Proxy polling so cloud-assigned local work is scoped to the active cloud projection.',
    hasText('apps/desktop/renderer/src/App.tsx', 'setRuntimeProjectionId(response.data.projectionId)') &&
      hasText('apps/desktop/renderer/src/App.tsx', 'runtimeProjectionId={runtimeProjectionId}') &&
      hasText('apps/desktop/renderer/src/chat/components/CloudChatSurface.tsx', 'runtimeProjectionId') &&
      hasText('apps/desktop/renderer/src/chat/state/useCloudChatRuntime.ts', 'projectionId: runtimeProjectionId ?? undefined') &&
      hasText('docs/architecture/11-client-runtime-cloud-contract-handoff.md', 'accepted Runtime Projection id'),
    'App.tsx; CloudChatSurface.tsx; useCloudChatRuntime.ts; docs/architecture/11-client-runtime-cloud-contract-handoff.md',
    'Runtime Projection publish result is not provably bound to Local Capability Proxy polling.',
  ),
  completionItem(
    'taskThreadEvidenceArtifacts',
    'Task-thread artifacts preserve client-tool Evidence results, including denied local execution, with stable evidence-derived artifact ids.',
    hasText('packages/task-thread/src/index.ts', '`evt_artifact_${result.evidence.evidenceId}`') &&
      hasText('packages/task-thread/src/task-thread.test.ts', 'attaches denied results and creates stable evidence artifact ids') &&
      hasText('packages/task-thread/package.json', '"test": "node --test src/*.test.ts"'),
    'packages/task-thread/src/index.ts; packages/task-thread/src/task-thread.test.ts',
    'Task-thread Evidence artifact coverage is incomplete.',
  ),
  completionItem(
    'cloudContractHandoff',
    'Remaining cloud runtime routes for Runtime Projection, client tool-call polling, Evidence return, and OpenClaw read readiness are documented with route shapes, security gates, and acceptance criteria.',
    hasText('docs/architecture/11-client-runtime-cloud-contract-handoff.md', 'POST /api/client/runtime/tasks/poll') &&
      hasText('docs/architecture/11-client-runtime-cloud-contract-handoff.md', 'POST /api/chat/client-tool/result') &&
      hasText('docs/architecture/11-client-runtime-cloud-contract-handoff.md', 'POST /api/client/runtime/projection') &&
      hasText('docs/architecture/11-client-runtime-cloud-contract-handoff.md', 'The cloud must not call local ports directly.'),
    'docs/architecture/11-client-runtime-cloud-contract-handoff.md',
    'Cloud runtime contract handoff is missing required local proxy / Evidence route coverage.',
  ),
  completionItem(
    'backendContractTasklist',
    'The remaining cloud blockers are also captured as a backend-facing tasklist with priorities, minimum implementation behavior, issue checklist, and acceptance commands.',
    hasText('docs/architecture/13-cloud-backend-contract-tasklist.md', 'Backend Issue Checklist') &&
      hasText('docs/architecture/13-cloud-backend-contract-tasklist.md', 'codex/zeus-atlas-client-runtime-contracts') &&
      hasText('docs/architecture/13-cloud-backend-contract-tasklist.md', 'P0 Local Runtime Loop') &&
      hasText('docs/architecture/13-cloud-backend-contract-tasklist.md', 'POST /api/client/runtime/projection') &&
      hasText('docs/architecture/13-cloud-backend-contract-tasklist.md', 'POST /api/client/runtime/tasks/poll') &&
      hasText('docs/architecture/13-cloud-backend-contract-tasklist.md', 'POST /api/chat/client-tool/result') &&
      hasText('docs/architecture/13-cloud-backend-contract-tasklist.md', 'prod-e2e:validate'),
    'docs/architecture/13-cloud-backend-contract-tasklist.md',
    'Backend-facing cloud contract tasklist is missing required implementation or acceptance coverage.',
  ),
  completionItem(
    'cloudContractSnapshot',
    'Current production cloud contract probe blocker evidence is captured as a machine-readable snapshot for backend handoff diffing.',
    cloudContractSnapshots.valid.length > 0,
    cloudContractSnapshots.valid.length > 0
      ? cloudContractSnapshots.valid.join(', ')
      : cloudContractSnapshots.snapshots.length > 0
        ? cloudContractSnapshots.failed.map((item) => item.snapshot).join(', ')
        : 'no docs/architecture/cloud-contract-probe.<date>.json found',
    cloudContractSnapshots.snapshots.length === 0
      ? 'No cloud contract probe snapshot exists.'
      : 'No cloud contract probe snapshot has a valid shape.',
  ),
  completionItem(
    'prodValidation',
    'A real production E2E report on the current dev/0.0.1 HEAD validates all required checks and has no cloud contract probe blockers.',
    prodReports.validated.length > 0,
    prodReports.validated.length > 0
      ? prodReports.validated.join(', ')
      : prodReports.reports.length > 0
        ? prodReports.failed.map((item) => item.report).join(', ')
        : latestCloudContractSnapshot
          ? `no docs/architecture/prod-e2e-report.<date>.json found; latest blocker snapshot: ${latestCloudContractSnapshot}`
          : 'no docs/architecture/prod-e2e-report.<date>.json found',
    prodReports.reports.length === 0
      ? `No real production E2E report exists.${latestCloudContractSnapshot ? ` Latest cloud contract blocker snapshot: ${latestCloudContractSnapshot}.` : ''}`
      : 'No production E2E report validates successfully on the current HEAD.',
  ),
];

console.log(`Client-cloud parity completion audit for ${git(['rev-parse', '--short', 'HEAD'])}`);
for (const check of checks) {
  const mark = check.status === 'pass' ? 'PASS' : 'BLOCKED';
  console.log(`[${mark}] ${check.id}: ${check.requirement}`);
  console.log(`  evidence: ${check.evidence}`);
  if (check.status !== 'pass' && check.blocker) console.log(`  blocker: ${check.blocker}`);
}

const blockers = checks.filter((check) => check.status !== 'pass');
if (blockers.length > 0) {
  console.error(`Client-cloud parity completion audit blocked: ${blockers.length} unmet requirement(s).`);
  process.exit(1);
}

console.log('Client-cloud parity completion audit passed.');
