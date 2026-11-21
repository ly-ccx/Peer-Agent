import { lstatSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { normalizeConversationExecution } from '@peer-agent/protocol';
import { withFileLock } from './conversation-file-lock.mjs';
import { readPersistedText } from './persisted-history.mjs';
import { assignSessionPreview } from './session-preview.mjs';

const JSONL_LIMIT = 8 * 1024 * 1024;
const ROW_LIMIT = 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const fail = (code, cause) => { throw Object.assign(new Error(code, { cause }), { code }); };
const usageAmounts = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'];

function fileVersion(file) {
  let info;
  try { info = lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile()) fail('conversation_execution_invalid');
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

function currentRun(meta) {
  if (!Object.hasOwn(meta, 'runtimeExecution')) return null;
  const run = normalizeConversationExecution(meta.runtimeExecution);
  if (run.identity.conversationId !== meta.id) fail('conversation_execution_invalid');
  return run;
}

function validateJsonValue(value, budget, depth = 0) {
  if (--budget.nodes < 0 || depth > 64) fail('conversation_execution_invalid');
  if (value === null || typeof value === 'boolean' || typeof value === 'string' && value.isWellFormed()
    || typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('conversation_execution_invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (Array.isArray(value) && (keys.length !== value.length + 1
    || keys.slice(0, -1).some((key, index) => key !== String(index)))) {
    fail('conversation_execution_invalid');
  }
  for (const key of keys) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = descriptors[key];
    if (!key.isWellFormed() || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('conversation_execution_invalid');
    }
    validateJsonValue(descriptor.value, budget, depth + 1);
  }
}

function readBody(file, meta) {
  const text = readPersistedText(file, meta.contentRevision === 0, JSONL_LIMIT, undefined, true) ?? '';
  if (text && !text.endsWith('\n')) fail('conversation_execution_invalid');
  const lines = text ? text.slice(0, -1).split('\n') : [];
  const rows = [];
  const ids = new Set();
  const budget = { nodes: 65_536 };
  try {
    for (const [position, line] of lines.entries()) {
      if (/^[ \t\r]*$/.test(line)) continue;
      const row = JSON.parse(line);
      const before = budget.nodes;
      validateJsonValue(row, budget);
      if (!row || typeof row.id !== 'string' || !row.id || Buffer.byteLength(row.id) > 200 || ids.has(row.id)) {
        fail('conversation_execution_invalid');
      }
      ids.add(row.id);
      rows.push({ row, position, nodes: before - budget.nodes });
      if (rows.length > 4096) fail('conversation_execution_invalid');
    }
  } catch (error) {
    fail('conversation_execution_invalid', error);
  }
  if (meta.messageCount !== rows.length || !Number.isSafeInteger(meta.contentRevision)
    || meta.contentRevision >= Number.MAX_SAFE_INTEGER) fail('conversation_execution_source_changed');
  return { lines, rows, budget };
}

function changeBody(meta, body, message, at, previous) {
  const { lines, rows, budget } = body;
  if (!previous && (rows.length >= 4096 || rows.some(entry => entry.row.id === message.id))) {
    fail('conversation_execution_source_changed');
  }
  validateJsonValue(message, { nodes: budget.nodes + (previous?.nodes ?? 0) });
  const messageLine = JSON.stringify(message);
  if (Buffer.byteLength(messageLine) > ROW_LIMIT) fail('conversation_execution_invalid');
  lines[previous?.position ?? lines.length] = messageLine;
  const nextText = lines.join('\n') + '\n';
  if (Buffer.byteLength(nextText) > JSONL_LIMIT) fail('conversation_execution_invalid');
  if (previous) previous.row = message;
  const messages = rows.map(entry => entry.row);
  if (!previous) messages.push(message);
  meta.messageCount = messages.length;
  meta.contentRevision += 1;
  meta.contextSnapshot = null;
  meta.updatedAt = at;
  assignSessionPreview(meta, messages);
  return nextText;
}

function assertGrant(grant, call) {
  if (grant?.toolCallId !== call.toolCallId || grant.capabilityId !== call.capabilityId
    || typeof grant.granted !== 'boolean' || typeof grant.grantId !== 'string' || !grant.grantId.trim()
    || typeof grant.decidedAt !== 'string' || !Number.isFinite(Date.parse(grant.decidedAt))) {
    fail('conversation_execution_invalid');
  }
}

function assertResult(result, grant, call) {
  assertGrant(grant, call);
  if (result?.toolCallId !== call.toolCallId || result.capabilityId !== call.capabilityId
    || !['success', 'denied', 'cancelled', 'failed'].includes(result.status)
    || result.status === 'success' && (call.phase !== 'dispatching' || !grant.granted)
    || call.phase === 'prepared' && grant.granted
    || typeof result.completedAt !== 'string' || !Number.isFinite(Date.parse(result.completedAt))
    || result.evidence?.toolCallId !== call.toolCallId
    || typeof result.evidence.evidenceId !== 'string' || !result.evidence.evidenceId.trim()
    || typeof result.evidence.summary !== 'string' || !Array.isArray(result.evidence.artifactRefs)) {
    fail('conversation_execution_invalid');
  }
}

/** Internal shared Store port. The Host still owns permission, effects and stop observations. */
export function createOrdinaryExecutionAdmission({ indexFile, convFile, streamPatchFile, contextSnapshotFile,
  writeIndexText, writeHistoryText, commitUsage }) {
  const snapshots = new WeakMap();

  function observe(id) {
    if (typeof id !== 'string' || !ID.test(id)) fail('conversation_execution_invalid');
    const indexVersion = fileVersion(indexFile);
    const sources = [convFile(id), streamPatchFile(id), contextSnapshotFile(id)];
    const versions = sources.map(fileVersion);
    const text = readPersistedText(indexFile, false, JSONL_LIMIT, undefined, true);
    if (!text.endsWith('\n')) fail('conversation_execution_invalid');
    const lines = text.split('\n');
    const ids = new Set();
    const budget = { nodes: 65_536 };
    let meta, rowIndex, rowNodes;
    try {
      for (const [position, line] of lines.entries()) {
        if (/^[ \t\r]*$/.test(line)) continue;
        const row = JSON.parse(line);
        const previousNodes = budget.nodes;
        validateJsonValue(row, budget);
        if (!row || typeof row.id !== 'string' || ids.has(row.id) || ids.size >= 4096) fail('conversation_execution_invalid');
        ids.add(row.id);
        if (row.id === id) {
          meta = row;
          rowIndex = position;
          rowNodes = previousNodes - budget.nodes;
        }
      }
    } catch {
      fail('conversation_execution_invalid');
    }
    if (!meta) fail('conversation_not_found');
    if (![null, undefined, 'chat'].includes(meta.role) || meta.parentConversationId != null) fail('conversation_execution_out_of_scope');
    if (!Number.isSafeInteger(meta.contentRevision ?? 0) || (meta.contentRevision ?? 0) < 0
      || (meta.contentRevision > 0 && versions[0] === null)) fail('conversation_execution_invalid');
    if (versions[1] !== null) fail('conversation_execution_busy');
    if (indexVersion !== fileVersion(indexFile) || !sources.every((file, i) => fileVersion(file) === versions[i])) {
      fail('conversation_execution_source_changed');
    }
    return { meta, rowIndex, lines, indexVersion, sources, versions, rowBudget: rowNodes + budget.nodes };
  }

  const withLocks = (id, run) => withFileLock(indexFile, () => withFileLock(convFile(id), run));

  function assertObservedSource(observation) {
    if (observation.indexVersion !== fileVersion(indexFile)
      || !observation.sources.every((file, i) => fileVersion(file) === observation.versions[i])) {
      fail('conversation_execution_source_changed');
    }
  }

  function persist(observation, run, bodyText) {
    observation.meta.runtimeExecution = run;
    validateJsonValue(observation.meta, { nodes: observation.rowBudget });
    // Keep every other line byte-for-byte, including metadata from newer peers.
    const nextLine = JSON.stringify(observation.meta);
    if (Buffer.byteLength(nextLine) > ROW_LIMIT) fail('conversation_execution_invalid');
    observation.lines[observation.rowIndex] = nextLine;
    const text = observation.lines.join('\n');
    if (Buffer.byteLength(text) > JSONL_LIMIT) fail('conversation_execution_invalid');
    const check = () => assertObservedSource(observation);
    if (bodyText === undefined) {
      writeIndexText(text, check);
    } else {
      const [body] = observation.sources;
      check();
      try {
        writeHistoryText(body, bodyText, check);
        observation.versions[0] = fileVersion(body);
        if (readPersistedText(body, false, JSONL_LIMIT, undefined, true) !== bodyText) {
          fail('conversation_execution_source_changed');
        }
        writeIndexText(text, check);
      } catch (error) {
        // The body may already be durable. Retain the claim and message for
        // reconciliation. Without a receipt the Host cannot dispatch.
        fail('conversation_execution_commit_uncertain', error);
      }
    }
    return nextLine;
  }

  function ownRun(id, initialVersions, initialLine, record, findEvidenceRecords) {
    let run = record;
    let versions = initialVersions;
    let expectedLine = initialLine;
    let started = false;
    let admissionClosed = false;
    let untracked = false;
    let stopInProgress;
    const running = new Map();

    function sourceMatches(current) {
      return current.lines[current.rowIndex] === expectedLine && isDeepStrictEqual(current.versions, versions);
    }

    function withOwnedRun(requireCurrentSource, action) {
      return withLocks(id, () => {
        const current = observe(id);
        if (!isDeepStrictEqual(currentRun(current.meta), run)) fail('conversation_execution_source_changed');
        if (requireCurrentSource && !sourceMatches(current)) {
          fail('conversation_execution_source_changed');
        }
        return action(current);
      });
    }

    function publish(current, changes, updatedAt = new Date().toISOString(), bodyText) {
      publishAt(current, changes, true, updatedAt, bodyText);
    }

    function publishAt(current, changes, advance, updatedAt = new Date().toISOString(), bodyText) {
      const next = normalizeConversationExecution({ ...run, ...changes, revision: run.revision + 1, updatedAt });
      const nextLine = persist(current, next, bodyText);
      if (advance) {
        expectedLine = nextLine;
        versions = current.versions;
      }
      run = next;
    }

    function requireActive() {
      if (!started || admissionClosed || run.phase !== 'active') fail('conversation_execution_busy');
    }

    function track(kind, operation, bind) {
      withOwnedRun(true, requireActive);
      const lease = { kind, controller: new AbortController() };
      const task = Promise.resolve().then(() => {
        lease.controller.signal.throwIfAborted();
        return operation(bind(lease));
      });
      running.set(lease, task);
      const completed = () => { running.delete(lease); };
      void task.then(completed, completed);
      return task;
    }

    function checkTracked(lease, kind) {
      if (!lease) {
        untracked = true;
        return;
      }
      if (!running.has(lease) || lease.kind !== kind) fail('conversation_execution_busy');
    }

    function closeAdmission() {
      // Close the in-process gate even if the durable fence fails. A later
      // stop may retry the same fence without admitting another request.
      admissionClosed = true;
      return withOwnedRun(false, current => {
        if (!started) fail('conversation_execution_busy');
        if (run.phase === 'stopping' || run.stop) return;
        if (run.phase !== 'active') fail('conversation_execution_busy');
        publish(current, { phase: 'stopping' });
      });
    }

    async function stopOwned(timeoutMs) {
      try { closeAdmission(); }
      finally {
        for (const lease of running.keys()) lease.controller.abort();
      }
      if (running.size > 0) {
        let timer;
        try {
          await Promise.race([
            Promise.allSettled([...running.values()]),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(Object.assign(new Error('conversation_execution_stop_unproven'), {
                code: 'conversation_execution_stop_unproven',
              })), timeoutMs);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      if (untracked || running.size !== 0) fail('conversation_execution_stop_unproven');
      withOwnedRun(false, current => {
        if (run.stop) return;
        if (run.phase !== 'stopping' || run.handles.length
          || run.pendingTools.some(call => call.nativeProcess)) fail('conversation_execution_stop_unproven');
        const at = new Date().toISOString();
        publish(current, {
          phase: run.pendingTools.length || !run.usageCommitted ? 'recovery_required' : 'stopped',
          pendingTools: run.pendingTools.map(call => call.phase === 'dispatching'
            ? { ...call, phase: 'outcome_unknown' } : call),
          stop: { owner: run.owner, observedAt: at, runnerIdle: true, admissionClosed: true, handlesEnded: true },
        }, at);
      });
      // A complete local stop remains durable if the independent billing
      // transaction fails or the process exits in its publication window.
      control.commitUsage();
      return withOwnedRun(false, () => structuredClone(run));
    }

    const control = Object.freeze({
      closeBeforeStart() {
        return withOwnedRun(true, current => {
          if (started) fail('conversation_execution_busy');
          if (run.phase !== 'active') fail('conversation_execution_source_changed');
          const at = new Date().toISOString();
          publish(current, {
            phase: 'stopped',
            stop: { owner: run.owner, observedAt: at, runnerIdle: true, admissionClosed: true, handlesEnded: true },
          }, at);
        });
      },

      start() {
        return withOwnedRun(true, () => {
          if (started || run.phase !== 'active') fail('conversation_execution_busy');
          started = true;
        });
      },

      assertCognitionSource(lease) {
        return withOwnedRun(true, () => {
          requireActive();
          checkTracked(lease, 'cognition');
          if (run.pendingTools.length) fail('conversation_execution_busy');
        });
      },

      appendText({ id, role, content }) {
        return withOwnedRun(true, current => {
          if (!started || run.stop || !['active', 'stopping'].includes(run.phase)
            || role === 'user' && admissionClosed || !['user', 'assistant'].includes(role)
            || typeof content !== 'string' || !content.trim()) fail('conversation_execution_invalid');
          const at = new Date().toISOString();
          const body = readBody(current.sources[0], current.meta);
          const message = { id, role, content, streamId: run.identity.streamId, createdAt: at };
          publish(current, {}, at, changeBody(current.meta, body, message, at));
        });
      },

      observeUsage(usage, unknown, lease) {
        return withOwnedRun(false, current => {
          checkTracked(lease, 'cognition');
          if (!started || run.phase !== 'active' && !(lease && run.phase === 'stopping')) {
            fail('conversation_execution_busy');
          }
          if (!usage || usage.providerRequestCount < 1 || typeof unknown !== 'boolean') {
            fail('conversation_execution_usage_conflict');
          }
          if (run.usage) {
            if (usage.providerRequestCount < run.usage.providerRequestCount
              || usageAmounts.some(key => usage[key] < run.usage[key])
              || usage.providerRequestCount === run.usage.providerRequestCount && !isDeepStrictEqual(usage, run.usage)) {
              fail('conversation_execution_usage_conflict');
            }
            if (isDeepStrictEqual(usage, run.usage) && (!unknown || run.unknownUsage)) return;
          }
          // Preserve billing even if a concurrent history change blocked cognition.
          // Only a publication from the previously expected source advances that source.
          publishAt(current, {
            usage, unknownUsage: run.unknownUsage || unknown, usageCommitted: usage.totalTokens === 0,
          }, sourceMatches(current));
        });
      },

      commitUsage() {
        return withOwnedRun(false, current => {
          if (running.size) fail('conversation_execution_busy');
          if (run.stop && run.usageCommitted) return;
          if (run.phase !== 'stopping' && !run.stop) fail('conversation_execution_busy');
          if (!run.usage || run.usage.totalTokens === 0 || run.usageCommitted) return;
          const receipt = commitUsage(id, { usage: run.usage, attribution: run.attribution })?.ledgerRow;
          if (!receipt || receipt.id !== run.identity.streamId || receipt.streamId !== run.identity.streamId
            || receipt.conversationId !== id || receipt.usageScope !== 'runtime_turn'
            || receipt.providerRequestCount !== run.usage.providerRequestCount
            || usageAmounts.some(key => receipt[key] !== run.usage[key])) {
            fail('conversation_execution_usage_conflict');
          }
          // The existing ledger advances derived metadata under the held index lock.
          // Recheck the original run and body before acknowledging that durable row.
          const after = observe(id);
          if (!isDeepStrictEqual(currentRun(after.meta), run) || !isDeepStrictEqual(after.versions, current.versions)) {
            fail('conversation_execution_source_changed');
          }
          const released = run.stop && !run.pendingTools.length && !run.handles.length;
          publish(after, { usageCommitted: true, phase: released ? 'stopped' : run.phase });
          return receipt;
        });
      },

      prepareTool({ toolCallId, dispatchId, messageId, capabilityId, argsDigest, declaredScopes, toolName, args }, lease) {
        return withOwnedRun(true, current => {
          requireActive();
          checkTracked(lease, 'local_tool');
          if (lease && !['local.file.read', 'local.file.list', 'local.file.search',
            'local.file.write', 'local.file.edit', 'local.shell.exec'].includes(capabilityId)) {
            fail('conversation_execution_out_of_scope');
          }
          if (run.pendingTools.length !== 0) fail('conversation_execution_busy');
          if (typeof toolName !== 'string' || !toolName.trim() || Buffer.byteLength(toolName) > 200
            || !args || typeof args !== 'object' || Array.isArray(args)) fail('conversation_execution_invalid');
          const at = new Date().toISOString();
          const message = {
            id: messageId, role: 'assistant', streamId: run.identity.streamId, content: '', createdAt: at,
            segments: [{ type: 'tool-call', tool: toolName, toolCallId, args }], permissionGrants: [],
          };
          const body = readBody(current.sources[0], current.meta);
          const bodyText = changeBody(current.meta, body, message, at);
          publish(current, {
            pendingTools: [{ toolCallId, dispatchId, messageId, capabilityId, argsDigest, declaredScopes, phase: 'prepared' }],
          }, at, bodyText);

          const originalSegment = structuredClone(message.segments[0]);
          const currentCall = () => {
            const call = run.pendingTools.find(p => p.toolCallId === toolCallId && p.dispatchId === dispatchId);
            if (!call) fail('conversation_execution_busy');
            return call;
          };
          const originalTool = current => {
            const body = readBody(current.sources[0], current.meta);
            const entry = body.rows.find(entry => entry.row.id === messageId);
            const row = entry?.row;
            if (row?.role !== 'assistant' || row.streamId !== run.identity.streamId
              || !Array.isArray(row.segments) || row.segments.length !== 1 || !Array.isArray(row.permissionGrants)) {
              fail('conversation_execution_source_changed');
            }
            const { result, ...segment } = row.segments[0];
            if (!isDeepStrictEqual(segment, originalSegment)) fail('conversation_execution_source_changed');
            return { body, entry, row, segment, result };
          };
          const writeTool = (current, tool, patch, changes) => {
            const at = new Date().toISOString();
            const bodyText = changeBody(current.meta, tool.body, { ...tool.row, ...patch }, at, tool.entry);
            publish(current, changes, at, bodyText);
          };
          const shellDispatch = () => {
            requireActive();
            checkTracked(lease, 'local_tool');
            if (currentCall().phase !== 'dispatching' || capabilityId !== 'local.shell.exec') {
              fail('conversation_execution_invalid');
            }
          };
          const shellHandle = () => run.handles.find(handle => handle.metadata.kind === 'shell_session');
          return Object.freeze({
            dispatch(grant) {
              return withOwnedRun(true, current => {
                requireActive();
                checkTracked(lease, 'local_tool');
                const call = currentCall();
                if (call.phase !== 'prepared') fail('conversation_execution_busy');
                assertGrant(grant, call);
                if (!grant.granted) fail('conversation_execution_invalid');
                const tool = originalTool(current);
                if (tool.result !== undefined || tool.row.permissionGrants.length !== 0) {
                  fail('conversation_execution_source_changed');
                }
                writeTool(current, tool, { permissionGrants: [grant] }, {
                  pendingTools: run.pendingTools.map(row => ({ ...row, phase: 'dispatching' })),
                });
              });
            },

            assertDispatching() {
              return withOwnedRun(true, () => {
                requireActive();
                checkTracked(lease, 'local_tool');
                if (currentCall().phase !== 'dispatching') fail('conversation_execution_busy');
              });
            },

            beginShell(handleId) {
              return withOwnedRun(true, current => {
                shellDispatch();
                if (run.handles.length) fail('conversation_execution_busy');
                const process = { schemaVersion: 1, kind: 'command', handleId, toolCallId, dispatchId,
                  execution: run.identity, generation: 1, state: 'starting', owner: run.owner };
                const original = { handleId, toolCallId, state: 'active', metadata: {
                  kind: 'shell_session', nativeShellSession: { schemaVersion: 1, process, command: null },
                } };
                publish(current, { handles: [original] });
                const requireOriginal = () => {
                  const handle = shellHandle();
                  const previous = handle?.metadata.nativeShellSession.process;
                  if (previous?.handleId !== handleId || previous.toolCallId !== toolCallId
                    || previous.dispatchId !== dispatchId) fail('conversation_execution_source_changed');
                  return handle;
                };
                return Object.freeze({
                  started(pid, pidStart) {
                    return withOwnedRun(true, observed => {
                      shellDispatch();
                      const handle = requireOriginal();
                      const session = handle.metadata.nativeShellSession;
                      if (session.process.state !== 'starting') fail('conversation_execution_source_changed');
                      const next = { ...session, process: { ...session.process, state: 'running',
                        child: { ...run.owner, pid, pidStart } } };
                      publish(observed, { handles: [{ ...handle, metadata: { ...handle.metadata, nativeShellSession: next } }] });
                    });
                  },
                  stopped() {
                    return withOwnedRun(false, observed => {
                      const handle = requireOriginal();
                      publishAt(observed, { handles: run.handles.filter(row => row !== handle) }, sourceMatches(observed));
                    });
                  },
                });
              });
            },

            bindShellCommand(pid) {
              return withOwnedRun(true, current => {
                shellDispatch();
                const handle = shellHandle();
                const session = handle?.metadata.nativeShellSession;
                if (session?.process.state !== 'running' || session.process.child.pid !== pid || session.command) {
                  fail('conversation_execution_source_changed');
                }
                const updated = { ...session, command: { toolCallId, dispatchId, generation: session.process.generation } };
                publish(current, { handles: [{ ...handle, metadata: { ...handle.metadata, nativeShellSession: updated } }] });
              });
            },

            publishResult(result, grant) {
              return withOwnedRun(true, current => {
                checkTracked(lease, 'local_tool');
                const call = currentCall();
                assertResult(result, grant, call);
                const tool = originalTool(current);
                const grants = tool.row.permissionGrants;
                if (tool.result !== undefined) {
                  if (isDeepStrictEqual(tool.result, result) && isDeepStrictEqual(grants, [grant])) return;
                  fail('conversation_execution_source_changed');
                }
                const expectedGrants = call.phase === 'dispatching' ? [grant] : [];
                if (!isDeepStrictEqual(grants, expectedGrants)) fail('conversation_execution_source_changed');
                writeTool(current, tool, { segments: [{ ...tool.segment, result }], permissionGrants: [grant] }, {});
              });
            },

            settle() {
              return withOwnedRun(true, current => {
                checkTracked(lease, 'local_tool');
                const call = currentCall();
                const tool = originalTool(current);
                if (!tool.result || tool.row.permissionGrants.length !== 1) fail('conversation_execution_invalid');
                assertResult(tool.result, tool.row.permissionGrants[0], call);
                const handle = shellHandle();
                const shell = handle?.metadata.nativeShellSession;
                const command = shell?.command;
                if (tool.result.error?.code === 'execution_outcome_unknown' || call.nativeProcess
                  || run.handles.length !== (handle ? 1 : 0)
                  || command && (command.toolCallId !== toolCallId || command.dispatchId !== dispatchId)) {
                  fail('conversation_execution_busy');
                }
                const evidenceRef = `tool-result://${call.toolCallId}`;
                const records = findEvidenceRecords?.([evidenceRef]);
                if (!records?.some(row => row.evidenceRef === evidenceRef
                  && row.conversationId === id && row.streamId === run.identity.streamId
                  && row.toolCallId === call.toolCallId && row.capabilityId === call.capabilityId)) {
                  fail('conversation_execution_evidence_missing');
                }
                const handles = command ? [{ ...handle, metadata: { ...handle.metadata,
                  nativeShellSession: { ...shell, command: null } } }] : run.handles;
                publish(current, { pendingTools: [], handles });
              });
            },
          });
        });
      },

      stopAdmission: closeAdmission,

      runCognition(operation) {
        return track('cognition', operation, lease => ({
          signal: lease.controller.signal,
          assertCognitionSource: () => control.assertCognitionSource(lease),
          observeUsage: (usage, unknown) => control.observeUsage(usage, unknown, lease),
        }));
      },

      runTool(operation) {
        return track('local_tool', operation, lease => ({
          signal: lease.controller.signal,
          prepareTool: input => control.prepareTool(input, lease),
        }));
      },

      stop({ timeoutMs = 5000 } = {}) {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647) {
          fail('conversation_execution_invalid');
        }
        if (!stopInProgress) {
          admissionClosed = true;
          const stopping = Promise.resolve().then(() => stopOwned(timeoutMs));
          stopInProgress = stopping;
          const done = () => { stopInProgress = undefined; };
          void stopping.then(done, done);
        }
        return stopInProgress;
      },
    });
    return control;
  }

  return {
    snapshot(id) {
      const observed = observe(id);
      const token = Object.freeze({ id, contentRevision: observed.meta.contentRevision ?? 0 });
      snapshots.set(token, { metadataLine: observed.lines[observed.rowIndex], versions: observed.versions });
      return token;
    },

    claim(snapshot, { streamId, owner, findEvidenceRecords, attribution = {} }) {
      const expected = snapshots.get(snapshot);
      if (!expected) fail('conversation_execution_source_changed');
      const { id } = snapshot;
      return withLocks(id, () => {
        const observed = observe(id);
        const prior = currentRun(observed.meta);
        if (prior && (prior.phase !== 'stopped' || prior.identity.streamId === streamId)) {
          fail('conversation_execution_busy');
        }
        if (expected.metadataLine !== observed.lines[observed.rowIndex]
          || !isDeepStrictEqual(expected.versions, observed.versions)) {
          fail('conversation_execution_source_changed');
        }
        const at = owner?.acquiredAt;
        if (typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) {
          fail('conversation_execution_invalid');
        }
        const run = normalizeConversationExecution({
          schemaVersion: 1, identity: { kind: 'conversation', conversationId: id, streamId },
          engine: 'peer-ts', owner, revision: 1, phase: 'active', pendingTools: [], handles: [],
          usage: null, unknownUsage: false, attribution: { ...attribution, id: streamId, streamId },
          usageCommitted: true, stop: null, updatedAt: at,
        });
        const nextLine = persist(observed, run);
        snapshots.delete(snapshot);
        return ownRun(id, observed.versions, nextLine, run, findEvidenceRecords);
      });
    },
  };
}
