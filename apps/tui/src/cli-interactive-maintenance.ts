import { randomUUID } from 'node:crypto';
import { readFileSync, readSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createConversationStore } from '@peer-agent/conversation-store';
import { interactiveDigest, interactiveToken, normalizeInteractiveOwner, normalizeInteractiveReference } from '@peer-agent/protocol';
import { createInteractiveRuntime } from '@peer-agent/runtime-node/interactive-results';
import { createBotProfileStore, createInputQueue, createProjectInputDraftStore } from '@peer-agent/runtime-node/project-agent';
import { createGoalPlanStore, createHostLease } from '@peer-agent/runtime-node/storage';
import { CLI_EXIT } from './cli-exit.ts';
import { openInteractiveMaintenanceGate } from './project-agent/interactive-maintenance-gate.ts';

const operations = {
  result: { preview: 'preview', cleanup: 'cleanup', receipt: 'readReceipt' },
  followup: { preview: 'previewFollowup', cleanup: 'cleanupFollowup', receipt: 'readFollowupReceipt' },
  material: { preview: 'previewMaterial', cleanup: 'cleanupMaterial', receipt: 'readMaterialReceipt' },
} as const;

function invalid() { return Object.assign(Error('interactive_cleanup_invalid'), { code: 'interactive_cleanup_invalid' }); }
function denied() { return Object.assign(Error('interactive_scope_denied'), { code: 'interactive_scope_denied' }); }

function request(readOnly: boolean) {
  const bytes = Buffer.alloc(8193);
  let size = 0, read = 0;
  do {
    size += read;
    if (size === bytes.length) throw invalid();
    read = readSync(0, bytes, size, bytes.length - size, null);
  } while (read > 0);

  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))); }
  catch { throw invalid(); }
  const { op, kind, target, requestId, expectedDigest } = value ?? {};
  if (!['preview', 'cleanup', 'receipt'].includes(op) || readOnly && op !== 'receipt'
    || typeof kind !== 'string' || !Object.hasOwn(operations, kind)
    || Object.keys(value).length !== (op === 'preview' ? 3 : 5)
    || op !== 'preview' && (!interactiveToken(requestId) || !interactiveDigest(expectedDigest)))
    throw invalid();

  const reference = kind === 'result' ? normalizeInteractiveReference(target) : undefined;
  const owner = kind === 'result' ? reference?.owner : normalizeInteractiveOwner(target?.owner);
  if (!owner) throw invalid();
  const selected = reference ? { reference } : kind === 'followup' ? { owner, followupId: target.followupId }
    : { owner, source: target.source };
  const methods = operations[kind as keyof typeof operations];
  return { op, owner, method: methods[op as keyof typeof methods],
    args: op === 'preview' ? reference ?? selected : { ...selected, requestId, expectedDigest } };
}

/** The maintenance CLI assembles canonical stores without starting the project scheduler or any model. */
export function runInteractiveMaintenance(gateArgs?: string[]): number {
  let cleanupReturned = false;
  try {
    const gate = gateArgs === undefined ? undefined : openInteractiveMaintenanceGate(gateArgs);
    const { op, owner, method, args } = request(!gate);
    const dataHome = gate?.dataHome ?? process.env.PEER_AGENT_HOME ?? process.env.PEER_USER_DATA_PATH ?? path.join(homedir(), '.peer-agent');
    const rootDir = path.join(dataHome, 'project-runtime');
    const profiles = createBotProfileStore({ rootDir: dataHome } as never);
    const getBotConversationId = (id: string) => {
      const profile = profiles.read(id);
      return profile?.status === 'active' ? profile.agentConversationId : undefined;
    };
    if (getBotConversationId(owner.workspaceId) !== owner.conversationId) throw denied();
    const leases = createHostLease({ rootDir, surface: 'tui', hostId: `tui-maintenance-${randomUUID()}` } as never);
    const holdsLease = (id: string) => id === owner.workspaceId && leases.holds(id);
    const enabled = (id: string) => {
      if (!holdsLease(id)) return false;
      try {
        return JSON.parse(readFileSync(path.join(dataHome, 'settings.json'), 'utf8'))?.projectAgent?.interactiveResults === true;
      } catch { return false; }
    };
    let result;
    try {
      if (op !== 'receipt' && !leases.acquire(owner.workspaceId).acquired) throw denied();
      const validateInteractiveFeedback = (row: unknown, id: string): boolean => interactive.feedback.validate(row, id);
      const interactive = createInteractiveRuntime({
        rootDir, getBotConversationId, holdsLease, enabled,
        goalPlanStore: createGoalPlanStore({ storeDir: path.join(dataHome, 'goal-plans') }),
        conversationStore: createConversationStore({ storeDir: path.join(dataHome, 'conversations') }),
        retentionPorts: {
          acquireCompatibility: gate?.acquireCompatibility,
          inputQueue: createInputQueue({ rootDir, validateInteractiveFeedback } as never),
          drafts: createProjectInputDraftStore({ rootDir, validateInteractiveFeedback }),
        },
      });
      try {
        result = interactive.retention[method](args);
        cleanupReturned = op === 'cleanup';
      } finally {
        interactive.close();
      }
    } finally {
      leases.close();
    }
    writeSync(1, JSON.stringify(result) + '\n');
    return CLI_EXIT.ok;
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    const safe = typeof code === 'string' && /^(interactive_[a-z_]+|material_snapshot_unavailable)$/.test(code)
      ? code : 'interactive_retention_unavailable';
    const outcome = cleanupReturned ? 'interactive_cleanup_outcome_unknown' : safe;
    console.error(`peer interactive maintenance: ${outcome}`);
    if (outcome === 'interactive_cleanup_invalid') return CLI_EXIT.usage;
    if (outcome === 'interactive_scope_denied' || outcome === 'interactive_retention_unavailable') return CLI_EXIT.auth;
    return CLI_EXIT.runtime;
  }
}
