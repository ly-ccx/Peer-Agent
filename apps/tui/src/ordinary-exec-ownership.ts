import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { createConversationStore } from '@peer-agent/conversation-store';
import type { RuntimeTurnUsage } from '@peer-agent/protocol';
import { SHARED_LOCAL_TOOL_CONTRACT_LIST, type PermissionGrant } from '@peer-agent/runtime-core';
import type { RuntimeSdkProviderExecution } from '@peer-agent/runtime-sdk';
import {
  commitOrdinaryToolOutcome, createGoalPlanStore, digestApprovalArgs, getNodeHookConfigPaths,
  localRecorderIdentity, NODE_FILE_CAPABILITY_MANIFESTS, ordinaryToolGrant, providerExecutionScopes, providerFileScopes,
  stopExecutionHandles,
} from '@peer-agent/runtime-node';
import type { ChatModelPort } from './chat-controller.ts';
import type { CreateProviderChatModelOptions } from './provider-chat-model.ts';
import type { CreateTuiHostOptions, TuiHost } from './tui-host.ts';

type Identity = { conversationId: string; streamId: string };
type Cognition = NonNullable<ReturnType<NonNullable<CreateProviderChatModelOptions['resolveOwnedCognition']>>>
  & { signal: AbortSignal };
type Prepared = Parameters<typeof commitOrdinaryToolOutcome>[0]['prepared']
  & {
    dispatch(grant: ReturnType<typeof ordinaryToolGrant>): void;
    assertDispatching(): void;
    beginShell(id: string): { started(pid: number, pidStart: string): void; stopped(): void };
    bindShellCommand(pid: number): void;
  };
type OwnedTool = { prepared: Prepared; toolCallId: string; capabilityId: string;
  dispatched: boolean; commandBound: boolean; shellCwd?: string; shellGrant?: PermissionGrant };
type Owner = {
  start(): void;
  appendText(input: { id: string; role: 'user' | 'assistant'; content: string }): void;
  runCognition<T>(operation: (binding: Cognition) => T | Promise<T>): Promise<T>;
  runTool<T>(operation: (binding: {
    signal: AbortSignal;
    prepareTool(input: { toolCallId: string; dispatchId: string; messageId: string; capabilityId: string;
      argsDigest: string; declaredScopes: unknown; toolName: string; args: Record<string, unknown> }): Prepared;
  }) => T | Promise<T>): Promise<T>;
  stopAdmission(): void;
  stop(): Promise<{ phase: string; usage: RuntimeTurnUsage | null }>;
};
type OwnershipStore = ReturnType<typeof createConversationStore> & {
  ordinaryExecutionAdmission: {
    snapshot(id: string): object;
    claim(snapshot: object, options: {
      streamId: string; owner: { pid: number; pidStart: string; bootId: string; hostId: string; acquiredAt: string };
      attribution: { at: string; modelProviderId: string; model: string };
      findEvidenceRecords: ReturnType<typeof createGoalPlanStore>['findEvidenceIndexRecords'];
    }): Owner;
  };
};

const FOREGROUND_SHELL = 'local.shell.exec';
const SUPPORTED_TOOLS = new Map<string, string>(SHARED_LOCAL_TOOL_CONTRACT_LIST
  .filter(tool => tool.capabilityId === FOREGROUND_SHELL
    || NODE_FILE_CAPABILITY_MANIFESTS.some(manifest => manifest.capabilityId === tool.capabilityId))
  .map(tool => [tool.capabilityId, tool.toolName]));

export function supportsOwnedCapabilities(capabilities?: readonly string[]): boolean {
  return !!capabilities?.length && capabilities.every(capability => SUPPORTED_TOOLS.has(capability));
}

function fileScopes(workspace: string, capability: string, input: unknown) {
  const target = path.resolve(workspace, typeof input === 'string' ? input.trim() : '.');
  return providerFileScopes(target).map(scope => capability === 'local.file.list'
    || capability === 'local.file.search' && statSync(scope.path, { throwIfNoEntry: false })?.isDirectory()
    ? { ...scope, kind: 'directory' } : scope);
}

function observedShellCwd(pid: number): string {
  if (process.platform === 'linux') return readlinkSync(`/proc/${pid}/cwd`);
  if (process.platform === 'darwin') {
    const output = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-d', 'cwd', '-Fn0'],
      { encoding: 'utf8', timeout: 1200, maxBuffer: 16 * 1024 });
    const cwd = output.split('\0').filter(field => field.startsWith('n'));
    if (cwd.length === 1) return cwd[0].slice(1);
  }
  throw new Error('shell_session_scope_unproven');
}

function preserveShellObservation(execution: RuntimeSdkProviderExecution, tracked: OwnedTool): RuntimeSdkProviderExecution {
  if (!tracked.shellGrant) return execution;
  const result = { ...execution.result, permissionGrant: tracked.shellGrant };
  const output = 'output' in result ? result.output : undefined;
  const observedExit = output && typeof output === 'object' && 'exitCode' in output && typeof output.exitCode === 'number';
  if (tracked.commandBound && !observedExit) {
    return { ...execution, result: { ...result, status: 'failed', error: {
      code: 'execution_outcome_unknown', message: 'The original Shell command has no confirmed result.', recoverable: false,
    } } };
  }
  return { ...execution, result };
}

/** Development assembly for the real exec entry on its explicitly isolated data root. */
export function createOrdinaryExecOwnership(dataHome: string, workspaceRoot: string) {
  const { globalPath, workspacePath } = getNodeHookConfigPaths({ userDataPath: dataHome, workspaceRoot });
  if (!existsSync(path.join(dataHome, '.native-cli-fixture'))
    || [globalPath, workspacePath].some(file => file && existsSync(file))) {
    throw new Error('isolated ordinary ownership requires a fixture root without Hooks');
  }
  const store = createConversationStore({ storeDir: path.join(dataHome, 'conversations') }) as OwnershipStore;
  const evidenceIndex = createGoalPlanStore({ storeDir: path.join(dataHome, 'goal-plans') });
  const sessionId = `peer-exec-${randomUUID()}`;
  const streamId = `${sessionId}:stream:0`;
  const cognition = new AsyncLocalStorage<Cognition>();
  const tool = new AsyncLocalStorage<OwnedTool>();
  let previousTool: Promise<void> = Promise.resolve();
  let owner: Owner | undefined;
  let conversationId: string | undefined;
  function current(identity?: Partial<Identity>) {
    if (!owner || !conversationId
      || identity && (identity.conversationId !== conversationId || identity.streamId !== streamId)) {
      throw new Error('conversation_execution_source_changed');
    }
    return owner;
  }
  function currentTool(call: { toolCallId: string; capabilityId: string }) {
    const actual = tool.getStore();
    if (!actual || call.toolCallId !== actual.toolCallId || call.capabilityId !== actual.capabilityId) {
      throw new Error('conversation_execution_source_changed');
    }
    return actual;
  }
  const ownedTool: NonNullable<CreateTuiHostOptions['ownedTool']> = {
    beforeFileEffect(call, grant) {
      const actual = currentTool(call);
      actual.prepared.dispatch(ordinaryToolGrant(call, grant));
      actual.dispatched = true;
    },
    ownForeground(call, grant) {
      const actual = currentTool(call);
      const planned = actual.shellCwd;
      if (!planned) throw new Error('shell_session_scope_unproven');
      function checkCwd(cwd: string) {
        if (realpathSync(cwd) !== planned) throw new Error('shell_session_scope_changed');
      }
      return {
        authorize(cwd) {
          checkCwd(cwd);
          if (actual.dispatched) return actual.prepared.assertDispatching();
          actual.prepared.dispatch(ordinaryToolGrant(call, grant));
          actual.dispatched = true;
          actual.shellGrant = grant;
        },
        beforeSpawn() {
          const handle = actual.prepared.beginShell(`shell-session_${randomUUID()}`);
          return {
            started(pid) {
              const pidStart = pid && localRecorderIdentity().lookup(pid);
              if (!pid || !pidStart) throw new Error('shell_session_owner_unproven');
              handle.started(pid, pidStart);
            },
            stopped: handle.stopped,
          };
        },
        beforeWrite(pid) {
          if (!pid) throw new Error('shell_session_owner_unproven');
          checkCwd(observedShellCwd(pid));
          actual.prepared.bindShellCommand(pid);
          actual.commandBound = true;
        },
      };
    },
    checkScope() {
      const actual = tool.getStore();
      if (!actual) throw new Error('conversation_execution_source_changed');
      if (actual.dispatched) actual.prepared.assertDispatching();
    },
    deferEvidence: () => tool.getStore() !== undefined,
  };
  const resolveOwnedCognition: CreateProviderChatModelOptions['resolveOwnedCognition'] = identity => {
    current(identity);
    const binding = cognition.getStore();
    if (!binding) throw new Error('conversation_execution_source_changed');
    return binding;
  };

  return {
    store, evidenceIndex, sessionId, ownedTool, resolveOwnedCognition,
    begin(id: string, selection: { providerId: string; modelId: string }, prompt: string) {
      const { pid, pidStart, bootId } = localRecorderIdentity();
      if (!pidStart || !bootId) throw new Error('conversation_execution_owner_unproven');
      const at = new Date().toISOString();
      const port = store.ordinaryExecutionAdmission;
      owner = port.claim(port.snapshot(id), {
        streamId, owner: { pid, pidStart, bootId, hostId: sessionId, acquiredAt: at },
        attribution: { at, modelProviderId: selection.providerId, model: selection.modelId },
        findEvidenceRecords: evidenceIndex.findEvidenceIndexRecords,
      });
      conversationId = id;
      owner.start();
      owner.appendText({ id: randomUUID(), role: 'user', content: prompt });
    },
    wrapModel(model: ChatModelPort): ChatModelPort {
      return { ...model, runTurn(state, context) {
        return current(context.run).runCognition(binding => cognition.run(binding, () => model.runTurn(state, {
          ...context,
          signal: context.signal ? AbortSignal.any([context.signal, binding.signal]) : binding.signal,
        })));
      } };
    },
    wrapHost(host: TuiHost): TuiHost {
      return { ...host, async execute(capabilityId, args, context) {
        const toolCallId = context?.toolCallId;
        const toolName = SUPPORTED_TOOLS.get(capabilityId);
        if (!toolName || !context || !toolCallId) {
          throw new Error('conversation_execution_out_of_scope');
        }
        return current(context).runTool(binding => {
          const signal = context.signal ? AbortSignal.any([context.signal, binding.signal]) : binding.signal;
          // The legacy loop can submit reads as a batch. Keep each call
          // tracked from admission while using the shared single-call Store.
          const next = previousTool.then(() => {
            signal.throwIfAborted();
            const shellCwd = capabilityId === FOREGROUND_SHELL
              ? realpathSync(path.resolve(workspaceRoot, typeof args.cwd === 'string' ? args.cwd : '.')) : undefined;
            const prepared = binding.prepareTool({ toolCallId, dispatchId: randomUUID(), messageId: randomUUID(),
              capabilityId, argsDigest: digestApprovalArgs(args),
              declaredScopes: shellCwd ? providerExecutionScopes(shellCwd) : fileScopes(workspaceRoot, capabilityId, args.path), toolName, args });
            const tracked: OwnedTool = { prepared, toolCallId, capabilityId, dispatched: false, commandBound: false, shellCwd };
            return tool.run(tracked, async () => {
              const result = await host.execute(capabilityId, args, { ...context, signal });
              const execution = preserveShellObservation(result, tracked);
              commitOrdinaryToolOutcome({ prepared, execution, identity: { conversationId: conversationId!, streamId },
                toolName, evidenceIndex, completedAt: new Date().toISOString() });
              return execution;
            });
          });
          previousTool = next.then(() => undefined, () => undefined);
          return next;
        });
      } };
    },
    closeAdmission() { owner?.stopAdmission(); },
    async finish(text?: string) {
      if (!owner) return;
      try {
        if (text?.trim()) owner.appendText({ id: randomUUID(), role: 'assistant', content: text });
      } finally {
        owner.stopAdmission();
        await stopExecutionHandles(conversationId);
        const result = await owner.stop();
        if (result.phase !== 'stopped') throw new Error('conversation_execution_recovery_required');
      }
    },
  };
}
