import { createHash, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readFileSync, lstatSync, realpathSync,
  mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

const PREFIX = 'local-desktop-preview-artifact://';
const REF = /^local-desktop-preview-artifact:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
// 同一套受治理的 UI 产物仓服务两种宿主。ref 前缀随宿主变化，避免网页产物在 Evidence 里
// 冒充桌面预览产物；两者共用同一条索引、字节校验与身份校验规则。
const HOST_PREFIX = { desktop: PREFIX, web: 'local-web-ui-artifact://' };
const HOST_REF = {
  desktop: REF,
  web: /^local-web-ui-artifact:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
};
const hostOfRef = ref => (Object.keys(HOST_PREFIX).find(host => HOST_PREFIX[host] === String(ref).slice(0, HOST_PREFIX[host].length))) ?? null;

function isPathInsideRegisteredWorkspace(candidate, registeredRoot) {
  if (candidate === registeredRoot) return true;
  const relative = path.relative(registeredRoot, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
/** 受治理产物的 ID 部分；两种宿主共用同一个产物目录，前缀只用于区分宿主身份。 */
export function artifactIdFromRef(ref) {
  const host = hostOfRef(ref);
  const match = host ? HOST_REF[host].exec(String(ref)) : null;
  if (!match) throw new Error('preview-artifact-ref-invalid');
  return match[1];
}
const HASH = /^[0-9a-f]{64}$/;
const MAX_PNG = 8 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const previewRequirementRevision = plan => hash(JSON.stringify([plan.goal, plan.successCriteria]));

// The host chooses the root and relative filename. Never follow a path in JSON.
// O_NOFOLLOW also closes the last-component lstat/open race. This is not an OS sandbox.
export function previewOwnedPath(root, relative) {
  const base = realpathSync(root);
  const target = path.resolve(base, relative);
  if (!target.startsWith(`${base}${path.sep}`)) throw new Error('preview-artifact-path');
  let current = base;
  for (const part of path.relative(base, target).split(path.sep)) {
    current = path.join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('preview-artifact-symlink');
  }
  if (realpathSync(target) !== target) throw new Error('preview-artifact-path');
  return target;
}
export function ensurePreviewDirectory(root, relative) {
  let current = realpathSync(root);
  for (const part of relative.split('/')) {
    if (!part || part === '.' || part === '..') throw new Error('preview-artifact-path');
    current = path.join(current, part);
    try { mkdirSync(current, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory()) throw new Error('preview-artifact-path');
  }
  return current;
}
export function readPreviewFile(root, relative, maxBytes = 1024 * 1024) {
  const filePath = previewOwnedPath(root, relative);
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('preview-artifact-size');
    const bytes = readFileSync(fd);
    if (bytes.length > maxBytes) throw new Error('preview-artifact-size');
    return { bytes, filePath };
  } finally { closeSync(fd); }
}
function validatePng(bytes, width, height) {
  if (bytes.length < 33 || bytes.length > MAX_PNG
    || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR'
    || !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1
    || width !== bytes.readUInt32BE(16) || height !== bytes.readUInt32BE(20)) {
    throw new Error('preview-invalid-png');
  }
}
// 产物必须由所属宿主的真实工具产生并入索引：桌面是 desktop_preview，网页是
// browser_screenshot。用另一个宿主的工具回执顶替，不构成该要求的证据。
const HOST_TOOL_IDENTITY = {
  desktop: { capabilityId: 'local.desktop.preview', toolName: 'desktop_preview' },
  web: { capabilityId: 'local.web.control.screenshot', toolName: 'browser_screenshot' },
};
function matchesIndex(record, stored) {
  const expected = HOST_TOOL_IDENTITY[stored.host ?? 'desktop'];
  return record?.planId === stored.planId && record?.conversationId === stored.conversationId
    && record?.toolCallId === stored.toolCallId && record?.evidenceRef === stored.evidenceRef
    && !!expected && record?.capabilityId === expected.capabilityId && record?.toolName === expected.toolName
    && record.artifactRefs?.includes(stored.artifactRef);
}

/** Durable retrieval only: never mints model admission or a visual judgment. */
export function createDesktopPreviewArtifactStore({ userDataPath, workspaceRoot, goalPlanStore }) {
  userDataPath = realpathSync(userDataPath);
  const workspace = realpathSync(workspaceRoot);
  const directory = path.join(userDataPath, 'ui-delivery', 'artifacts');
  function write({ plan, observation, toolCallId, png, width, height }) {
    validatePng(png, width, height); // Provider has already decoded the real image.
    if (observation.scene !== undefined && !['application', 'background-runtime'].includes(observation.scene)) {
      throw new Error('preview-scene-invalid');
    }
    const host = observation.host ?? 'desktop';
    if (!['desktop', 'web'].includes(host)) throw new Error('preview-host-invalid');
    ensurePreviewDirectory(userDataPath, 'ui-delivery/artifacts');
    const id = randomUUID();
    const record = { version: 1, artifactRef: `${HOST_PREFIX[host]}${id}`, artifactHash: hash(png),
      planId: plan.planId, conversationId: plan.conversationId, workspacePath: workspace,
      toolCallId, evidenceRef: `tool-result://${toolCallId}`, requirementRevision: previewRequirementRevision(plan),
      sourceFingerprint: observation.sourceFingerprint, buildFingerprint: observation.buildFingerprint,
      instanceId: observation.instanceId, host, scene: observation.scene ?? 'application', capturedAt: new Date().toISOString(), width, height };
    const filePath = path.join(directory, `${id}.png`);
    writeFileSync(filePath, png, { flag: 'wx', mode: 0o600 });
    const temporary = path.join(directory, `${id}.json.tmp`);
    writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path.join(directory, `${id}.json`));
    return { ...record, filePath };
  }
  function read(ref, scope, expectedObservation) {
    const refHost = hostOfRef(ref);
    const match = typeof ref === 'string' && refHost ? HOST_REF[refHost].exec(ref) : null;
    if (!match || !scope?.planId || !scope?.conversationId) throw new Error('preview-artifact-scope');
    const relative = `ui-delivery/artifacts/${match[1]}`;
    const stored = JSON.parse(readPreviewFile(userDataPath, `${relative}.json`, 16384).bytes.toString('utf8'));
    // Prefer the caller-supplied host plan. getPlan applies UI projection, which reads
    // this artifact; using the projected getter here busy-loops the Desktop main thread.
    const plan = scope.planId === stored.planId && scope.conversationId === stored.conversationId
      ? scope
      : goalPlanStore.getPlan(scope.planId);
    if (stored.version !== 1 || stored.artifactRef !== ref || stored.planId !== scope.planId
      || stored.conversationId !== scope.conversationId || plan?.conversationId !== scope.conversationId
      || stored.workspacePath !== workspace || !HASH.test(stored.artifactHash)
      || !HASH.test(stored.requirementRevision) || !HASH.test(stored.sourceFingerprint)
      || !HASH.test(stored.buildFingerprint) || typeof stored.instanceId !== 'string' || !stored.instanceId
      || typeof stored.toolCallId !== 'string' || !stored.toolCallId
      || stored.evidenceRef !== `tool-result://${stored.toolCallId}`) throw new Error('preview-artifact-record');
    if (stored.scene !== undefined && !['application', 'background-runtime'].includes(stored.scene)) throw new Error('preview-artifact-scene');
    // host 是可选字段：旧记录没有它，按 desktop 解释。
    if (stored.host !== undefined && !['desktop', 'web'].includes(stored.host)) throw new Error('preview-artifact-host');
    // ref 前缀与记录声明的宿主必须一致，否则同一张图可以借改前缀换个宿主。
    if ((stored.host ?? 'desktop') !== refHost) throw new Error('preview-artifact-host-mismatch');
    const planWorkspace = plan.executionWorkspacePath || plan.targetWorkspacePath || plan.originWorkspacePath;
    if (planWorkspace) {
      try {
        if (!isPathInsideRegisteredWorkspace(realpathSync(planWorkspace), workspace)) {
          throw new Error('preview-artifact-workspace');
        }
      } catch (error) {
        if (error?.message === 'preview-artifact-workspace') throw error;
        throw new Error('preview-artifact-workspace');
      }
    }
    // Read the durable index, not a caller-provided claim or a stale in-memory lookup.
    const indexed = goalPlanStore.listEvidenceIndex().findLast(record => record.evidenceRef === stored.evidenceRef);
    if (!matchesIndex(indexed, stored)) {
      throw new Error('preview-artifact-unindexed');
    }
    if (expectedObservation) {
      for (const field of ['artifactRef', 'artifactHash', 'evidenceRef', 'instanceId', 'sourceFingerprint', 'buildFingerprint', 'requirementRevision']) {
        if (expectedObservation[field] !== stored[field]) throw new Error('preview-observation-mismatch');
      }
      if ((expectedObservation.scene ?? 'application') !== (stored.scene ?? 'application')) throw new Error('preview-observation-scene-mismatch');
      if ((expectedObservation.host ?? 'desktop') !== (stored.host ?? 'desktop')) throw new Error('preview-observation-host-mismatch');
      if (expectedObservation.admittedToRunId !== '') throw new Error('preview-admission-unimplemented');
    }
    const { bytes, filePath } = readPreviewFile(userDataPath, `${relative}.png`, MAX_PNG);
    if (hash(bytes) !== stored.artifactHash) throw new Error('preview-artifact-hash');
    validatePng(bytes, stored.width, stored.height);
    return { ...stored, filePath }; // No image bytes in presentation/Evidence.
  }
  function resolveArtifact(ref, evidenceRecord, scope = evidenceRecord) {
    if (typeof ref !== 'string' || !ref.startsWith('local-desktop-preview-artifact:')) return undefined;
    try {
      const record = read(ref, scope);
      if (!matchesIndex(evidenceRecord, record)) throw new Error('preview-artifact-index-mismatch');
      return { openPath: record.filePath };
    } catch { return {}; } // Handled but invalid: no arbitrary path fallback.
  }
  return { write, read, resolveArtifact };
}
