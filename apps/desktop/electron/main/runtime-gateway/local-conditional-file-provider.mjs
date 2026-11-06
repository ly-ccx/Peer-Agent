import { createHash, randomUUID } from 'node:crypto';
import { constants, accessSync, openSync, closeSync, readSync, writeSync, fstatSync, lstatSync, ftruncateSync, fsyncSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { normalizeResourceFileReplaceInput, validResourceEditText, resourceEditToken, RESOURCE_FILE_REPLACE_CAPABILITY, RESOURCE_FILE_REPLACE_PROVIDER, RESOURCE_FILE_REPLACE_TOOL, RESOURCE_EDIT_TEXT_BYTES } from '@peer-agent/protocol';
import { createPermissionGrant, nowIso } from './tool-result-factory.mjs';
import { withFileMutationLock } from './file-mutation-lock.mjs';
import { versionedFileDiff } from './versioned-file-diff.mjs';
const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const issue = (code, outcome = 'failed') => Object.assign(new Error(code), { code, outcome });
function trustedGrant(call, value) {
  if (!value || !resourceEditToken(value.grantId) || typeof value.granted !== 'boolean' || !Number.isFinite(Date.parse(value.decidedAt))
    || ![call.toolCallId, `chat-permission:${call.toolCallId}`].includes(value.toolCallId)
    || value.granted && value.scope !== call.capabilityId || !value.granted && value.scope !== undefined && value.scope !== null && value.scope !== call.capabilityId
    || !['once', 'task', 'session', 'scope', 'persistent', 'denied'].includes(value.duration) || value.granted && value.duration === 'denied') return null;
  return { grantId: value.grantId, toolCallId: call.toolCallId, granted: value.granted, duration: value.duration, ...(value.scope !== undefined ? { scope: value.scope } : {}), decidedAt: value.decidedAt,
    ...(typeof value.policyRevision === 'string' ? { policyRevision: value.policyRevision } : {}) };
}
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
const sameTime = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const isWithin = (root, target) => { const rel = path.relative(root, target); return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
function assertBinding(bound, input) {
  if (!bound?.ok) {
    const reasons = { RESOURCE_EDIT_SCOPE_DENIED: 'denied', RESOURCE_EDIT_FILE_NOT_FOUND: 'failed', RESOURCE_EDIT_SOURCE_UNAVAILABLE: 'failed', RESOURCE_EDIT_SOURCE_CHANGED: 'conflict', RESOURCE_EDIT_VERSION_CHANGED: 'conflict', RESOURCE_EDIT_UNSUPPORTED_TEXT: 'failed', RESOURCE_EDIT_TEXT_LIMIT: 'failed' };
    const code = Object.hasOwn(reasons, bound?.code) ? bound.code : 'RESOURCE_EDIT_SCOPE_DENIED'; throw issue(code, reasons[code]);
  }
  if (bound.path !== input.target.reference.path || bound.resourceId !== input.target.base.resourceId
    || typeof bound.root !== 'string' || !path.isAbsolute(bound.root) || !isWithin(bound.root, bound.path)
    || typeof bound.validate !== 'function' || bound.validate() !== true) throw issue('RESOURCE_EDIT_SCOPE_DENIED', 'denied');
  if (realpathSync(bound.root) !== bound.root || realpathSync(bound.path) !== bound.path) throw issue('RESOURCE_EDIT_SOURCE_CHANGED', 'conflict');
}
function inspect(fd, filePath) {
  const start = fstatSync(fd), current = lstatSync(filePath);
  if (!start.isFile() || !current.isFile() || start.nlink !== 1 || current.nlink !== 1 || !sameFile(start, current) || realpathSync(filePath) !== filePath) throw issue('RESOURCE_EDIT_SOURCE_CHANGED', 'conflict');
  if (start.size > RESOURCE_EDIT_TEXT_BYTES) throw issue('RESOURCE_EDIT_TEXT_LIMIT');
  const bytes = Buffer.alloc(start.size); let offset = 0;
  while (offset < bytes.length) { const read = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!read) throw issue('RESOURCE_EDIT_SOURCE_CHANGED', 'conflict'); offset += read; }
  const finish = fstatSync(fd), node = lstatSync(filePath);
  if (!sameTime(start, finish) || !sameFile(finish, node) || node.nlink !== 1) throw issue('RESOURCE_EDIT_SOURCE_CHANGED', 'conflict');
  const text = bytes.toString('utf8');
  if (!validResourceEditText(text) || !Buffer.from(text).equals(bytes)) throw issue('RESOURCE_EDIT_UNSUPPORTED_TEXT');
  return { stat: finish, bytes, text, version: hash(bytes) };
}
/** The caller supplies host scope/intent facts; neither this Provider nor a draft grants access. */
export function createLocalConditionalFileProvider({ resolveTarget, isIntentCurrent, createId = randomUUID, now = nowIso, io = {} } = {}) {
  if (typeof resolveTarget !== 'function' || typeof isIntentCurrent !== 'function') throw TypeError('Conditional file Provider requires host source and intent authority ports.');
  const write = io.write ?? writeSync, truncate = io.truncate ?? ftruncateSync, sync = io.sync ?? fsyncSync;
  function result(call, input, { outcome, reason, approval, effectStarted = false, before, observedVersion, diff, locale = 'en-US' }) {
    const candidate = approval?.grant;
    const actual = trustedGrant(call, candidate);
    const grant = actual ? actual : createPermissionGrant({ toolCallId: call.toolCallId, granted: false, scope: RESOURCE_FILE_REPLACE_CAPABILITY });
    const status = outcome === 'applied' ? 'success' : outcome === 'denied' ? 'denied' : outcome === 'cancelled' ? 'cancelled' : 'failed';
    return { call, grant, result: {
      toolCallId: call.toolCallId, status, completedAt: now(),
      outputPreview: { kind: 'resource_file_replace_result', status, outcome, reason, effectStarted,
        requestId: input?.requestId, path: input?.target.reference.path, resourceId: input?.target.base.resourceId,
        expectedVersion: input?.target.base.contentVersion, proposedVersion: input?.proposedVersion,
        ...(observedVersion ? { observedVersion } : {}), ...(before ? { bytesBefore: before.bytes.length, bytesAfter: Buffer.byteLength(input.content) } : {}),
        ...(actual ? { permissionCallId: candidate.toolCallId } : {}),
        ...(diff ? { diffPreview: diff.text, diffPreviewTruncated: diff.truncated, additions: diff.additions, deletions: diff.deletions, previewOnly: true } : {}) },
      evidence: { evidenceId: createId(), toolCallId: call.toolCallId, summary: locale?.startsWith('zh') ? `文件条件修改结果：${outcome}${reason ? `（${reason}）` : ''}。` : `Conditional file edit: ${outcome}${reason ? ` (${reason})` : ''}.`,
        locale: locale?.startsWith('zh') ? 'zh-CN' : 'en-US', returnedToCloud: false, dataLevel: 'D2_sensitive', redactions: [], artifactRefs: [] },
    } };
  }
  async function executeCapability(request, context = {}) {
    const call = request?.call; if (call?.capabilityId !== RESOURCE_FILE_REPLACE_CAPABILITY) return null;
    const input = normalizeResourceFileReplaceInput(call.arguments);
    const finish = details => result(call, input, { ...details, locale: context.locale });
    const projected = context.resourceEditProjection?.capabilities?.find(item => item.capabilityId === call.capabilityId && item.name === RESOURCE_FILE_REPLACE_TOOL && ['available', 'needs_permission'].includes(item.health));
    if (!projected || request.projectionId !== context.resourceEditProjection.projectionId || request.sessionId !== context.resourceEditProjection.sessionId) return finish({ outcome: 'denied', reason: 'capability_not_projected' });
    if (!input || call.toolCallId !== `resource-edit:${input.requestId}` || hash(input.content) !== input.proposedVersion) return finish({ outcome: 'failed', reason: 'RESOURCE_EDIT_PAYLOAD_CHANGED' });
    let approval, before, effectStarted = false;
    const current = () => isIntentCurrent(input, call) === true;
    const live = () => { if (context.signal?.aborted) throw issue('execution_cancelled', 'cancelled'); if (!current()) throw issue('RESOURCE_EDIT_SOURCE_CHANGED', 'denied'); };
    try {
      live(); const original = await resolveTarget(input.target); assertBinding(original, input); live();
      return await withFileMutationLock(original.path, async () => {
        live(); let fd;
        try {
          if (typeof context.requestPermission !== 'function') throw issue('permission_unavailable', 'denied');
          approval = await context.requestPermission({ capabilityId: call.capabilityId, toolName: RESOURCE_FILE_REPLACE_TOOL, toolCallId: call.toolCallId,
            args: { requestId: input.requestId, target: input.target, proposedVersion: input.proposedVersion, bytes: Buffer.byteLength(input.content) },
            workspacePath: original.root, filePath: original.path, riskLevel: 'L2_local_write', dataLevel: 'D2_sensitive',
            reason: 'Apply this exact saved draft to its original file if its base version is unchanged.',
            scope: { kind: 'resource-edit', requestId: input.requestId, path: original.path, expectedVersion: input.target.base.contentVersion, proposedVersion: input.proposedVersion } });
          live();
          const grant = trustedGrant(call, approval?.grant);
          if (approval?.granted !== true || grant?.granted !== true) throw issue(approval?.reason || 'permission_not_granted', 'denied');
          if (typeof approval.validate !== 'function' || approval.validate() !== true) throw issue('permission_policy_changed', 'denied');
          const bound = await resolveTarget(input.target); live(); assertBinding(bound, input);
          if (bound.path !== original.path || bound.root !== original.root) throw issue('RESOURCE_EDIT_SOURCE_CHANGED', 'conflict');
          accessSync(bound.path, constants.W_OK);
          fd = openSync(bound.path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
          if (!current() || bound.validate() !== true || approval.validate() !== true) throw issue('permission_policy_changed', 'denied');
          before = inspect(fd, bound.path);
          if (before.version !== input.target.base.contentVersion) throw issue('RESOURCE_EDIT_VERSION_CHANGED', 'conflict');
          if (context.signal?.aborted) throw issue('execution_cancelled', 'cancelled');
          if (before.version !== input.proposedVersion) {
            const body = Buffer.from(input.content); let offset = 0;
            effectStarted = true;
            while (offset < body.length) { const count = write(fd, body, offset, body.length - offset, offset); if (!Number.isInteger(count) || count <= 0 || count > body.length - offset) throw issue('RESOURCE_EDIT_WRITE_UNCONFIRMED', 'uncertain'); offset += count; }
            truncate(fd, body.length); sync(fd);
          }
          const after = inspect(fd, bound.path);
          if (!sameFile(before.stat, after.stat) || after.version !== input.proposedVersion) throw issue('RESOURCE_EDIT_WRITE_UNCONFIRMED', 'uncertain');
          return finish({ outcome: 'applied', reason: effectStarted ? undefined : 'no_change', effectStarted, approval, before, observedVersion: after.version,
            diff: versionedFileDiff(bound.path, before.text, input.content) });
        } catch (error) {
          return finish({ outcome: effectStarted ? 'uncertain' : error.outcome ?? 'failed', reason: error.code ?? 'RESOURCE_EDIT_IO_UNAVAILABLE', approval, before, effectStarted });
        } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
      }, { signal: context.signal });
    } catch (error) { return finish({ outcome: effectStarted ? 'uncertain' : error.code === 'FILE_MUTATION_CANCELLED' ? 'cancelled' : error.outcome ?? 'failed', reason: error.code ?? 'RESOURCE_EDIT_SOURCE_UNAVAILABLE', approval, before, effectStarted }); }
  }
  return { providerId: RESOURCE_FILE_REPLACE_PROVIDER, capabilityIds: [RESOURCE_FILE_REPLACE_CAPABILITY], executeCapability };
}
