import { normalizeEvidenceRefList, normalizeOptionalString } from "./goal-plan-domain.mjs";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
  writeSync,
  renameSync,
} from 'node:fs';
import { randomUUID } from "node:crypto";
import { normalizeInteractiveUserArtifact, parseInteractiveArtifactRef, normalizeInteractiveInspectionReceipt,
  isInteractiveInspectionEvidenceRef, interactiveInspectionEvidenceRef } from '@peer-agent/protocol';
import path from "node:path";

export function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * JSONL 文件级读缓存（性能治理 §12，multi-task-ui-performance-remediation.md）。
 *
 * 背景：多任务高并发时 listPlans() 以 ~300ms 周期被调用，每次全量
 * readFileSync + JSON.parse×N + normalizePlan×N（trace 实测 activeMeta 热点 4.7s/7.2s）。
 * 索引文件仅在写入时变化，且写入路径统一走 writeJsonl/appendJsonl（同进程）或
 * 外部进程写入（subscribeChanges 的 watcher 会感知）。
 *
 * 契约：statSync 命中（mtimeMs+size 一致）时复用解析结果，绝不复用可变对象引用——
 * 调用方（normalizePlan/filter/sort）可能产生新数组，但缓存返回的是同一份原始记录数组，
 * 因此读缓存返回浅拷贝数组，避免调用方 sort() 原地修改缓存。
 */
const jsonlReadCache = new Map();

// filePath -> { mtimeMs, size, records }

export function readJsonlCached(filePath) {
  let stat = null;
  try {
    stat = statSync(filePath);
  } catch {
    jsonlReadCache.delete(filePath);
    return [];
  }
  const cached = jsonlReadCache.get(filePath);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size
  ) {
    return cached.records.slice(); // 浅拷贝：调用方可安全 sort/splice
  }
  const records = readJsonl(filePath);
  jsonlReadCache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    records,
  });
  return records.slice();
}

const EVIDENCE_TAIL_SCAN_BYTES = 16 * 1024 * 1024;

/**
 * EvidenceIndex 可达数百 MB；任务概览只需要少量已知 ref，禁止为此全量解析。
 * 一次读取有界尾部再统一 UTF-8 解码，避免分块边界截断中文 JSON。
 */
export function readEvidenceRecordsFromTail(filePath, refs, maxScanBytes = EVIDENCE_TAIL_SCAN_BYTES) {
  const wanted = new Set(normalizeEvidenceRefList(refs));
  if (wanted.size === 0 || !existsSync(filePath)) return [];
  const fd = openSync(filePath, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxScanBytes);
    const start = size - length;
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    const lines = buffer.toString('utf8', 0, bytesRead).split('\n');
    if (start > 0) lines.shift(); // 首行可能从 JSON 中间开始。
    const found = new Map();
    const resolvedOriginals = new Set();
    for (let index = lines.length - 1; index >= 0 && resolvedOriginals.size < wanted.size; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      let parsed;
      try {
        parsed = normalizeEvidenceIndexRecord(JSON.parse(line));
      } catch {
        continue;
      }
      if (!parsed || !wanted.has(parsed.evidenceRef)) continue;
      found.set(parsed.evidenceRef, mergeEvidenceIndexRecords(found.get(parsed.evidenceRef), parsed));
      // Older writers append a normalized row that may omit the new artifact kind.
      // Keep scanning for its original canonical publication; append-only bytes survive.
      const needsInteractiveOrigin = parsed.artifactRefs?.some(ref => parseInteractiveArtifactRef(ref))
        && !found.get(parsed.evidenceRef).userArtifacts?.some(item => item.kind === 'interactive')
        || isInteractiveInspectionEvidenceRef(parsed.evidenceRef) && !found.get(parsed.evidenceRef).interactiveInspection;
      if (!EVIDENCE_WRAPPER_TOOL_NAMES.has(parsed.toolName) && !needsInteractiveOrigin) {
        resolvedOriginals.add(parsed.evidenceRef);
      }
    }
    return [...found.values()];
  } finally {
    closeSync(fd);
  }
}

export function appendJsonl(filePath, obj, { durable = false } = {}) {
  const created = mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('evidence_append_target_invalid');
    const bytes = Buffer.from(JSON.stringify(obj) + '\n', 'utf8');
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
    if (durable) fsyncSync(fd);
  } finally { closeSync(fd); }
  if (durable) {
    let folder = path.dirname(filePath);
    const stop = created ? path.dirname(created) : folder;
    while (true) {
      const directory = openSync(folder, 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
      if (folder === stop || path.dirname(folder) === folder) break;
      folder = path.dirname(folder);
    }
  }
}

export function syncJsonl(filePath) {
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('evidence_append_target_invalid');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const directory = openSync(path.dirname(filePath), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function writeGoalChangeEvent(storeDir, event) {
  appendJsonl(path.join(storeDir, '.changes.jsonl'), {
    ...event,
    revision: `${Date.now()}-${randomUUID()}`,
    writerPid: process.pid,
    changedAt: new Date().toISOString(),
  });
}

export function writeJsonl(filePath, items) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, items.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8');
  renameSync(tmp, filePath);
  jsonlReadCache.delete(filePath);
}

let jsonWriteObserver = null;

/**
 * 诊断用。观察者只收到阶段、耗时和字节数，不收到对象、路径或正文。
 * 未注册时写盘行为与原来一致。
 */
export function setJsonWriteObserver(observer) {
  const previous = jsonWriteObserver;
  jsonWriteObserver = typeof observer === 'function' ? observer : null;
  return previous;
}

function notifyJsonWrite(phase, ms, text) {
  if (!jsonWriteObserver) return;
  try {
    jsonWriteObserver({ phase, ms, bytes: Buffer.byteLength(text) });
  } catch {
    // 诊断失败不能挡住计划落盘。
  }
}

export function writeJsonAtomic(filePath, obj) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  const stringifyStarted = performance.now();
  const text = JSON.stringify(obj, null, 2);
  const stringifyMs = performance.now() - stringifyStarted;
  const writeStarted = performance.now();
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, filePath);
  const writeMs = performance.now() - writeStarted;
  jsonReadCache.delete(filePath);
  notifyJsonWrite('stringify', stringifyMs, text);
  notifyJsonWrite('write', writeMs, text);
}

/** 单文件 JSON 读缓存（plan 详情热路径，避免 overview 反复 readFile+JSON.parse）。 */
const jsonReadCache = new Map();

// filePath -> { mtimeMs, size, value }

export function readJson(filePath) {
  if (!existsSync(filePath)) {
    jsonReadCache.delete(filePath);
    return null;
  }
  let stat = null;
  try {
    stat = statSync(filePath);
  } catch {
    jsonReadCache.delete(filePath);
    return null;
  }
  const cached = jsonReadCache.get(filePath);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size
  ) {
    return cached.value;
  }
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8'));
    jsonReadCache.set(filePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      value,
    });
    return value;
  } catch {
    jsonReadCache.delete(filePath);
    return null;
  }
}

export function normalizeEvidenceIndexRecord(value) {
  if (!value || typeof value !== 'object') return null;
  const evidenceRef = normalizeOptionalString(value.evidenceRef);
  if (!evidenceRef) return null;
  const createdAt = normalizeOptionalString(value.createdAt) || new Date().toISOString();
  const record = { evidenceRef, createdAt };
  const optionalFields = [
    'planId',
    'conversationId',
    'streamId',
    'toolCallId',
    'capabilityId',
    'toolName',
  ];
  for (const field of optionalFields) {
    const normalized = normalizeOptionalString(value[field]);
    if (normalized) record[field] = normalized;
  }
  const inspection = normalizeInteractiveInspectionReceipt(value.interactiveInspection);
  if (inspection && interactiveInspectionEvidenceRef(inspection.evidenceId) === evidenceRef
    && record.planId === inspection.execution.planId && record.conversationId === inspection.conversationId
    && record.toolCallId === inspection.toolCallId && record.capabilityId === 'local.interactive.inspect'
    && record.toolName === 'inspect_interactive_result' && record.createdAt === inspection.observedAt) record.interactiveInspection = inspection;
  const artifactRefs = normalizeEvidenceRefList(value.artifactRefs);
  if (artifactRefs.length > 0) record.artifactRefs = artifactRefs;
  const userArtifacts = Array.isArray(value.userArtifacts)
    ? value.userArtifacts
      .filter((artifact) => artifact && typeof artifact === 'object')
      .map((artifact) => {
        if (artifact.kind === 'interactive') return normalizeInteractiveUserArtifact(artifact) ?? null;
        const kind = ['code-change', 'file', 'image'].includes(artifact.kind) ? artifact.kind : null;
        const ref = normalizeOptionalString(artifact.ref);
        const label = normalizeOptionalString(artifact.label);
        if (!kind || !ref || !label) return null;
        const normalized = { kind, ref, label };
        const artifactPath = normalizeOptionalString(artifact.path);
        if (artifactPath) normalized.path = artifactPath;
        // 新建文件（kind='file'）同样带增删统计，因此不能只放行 code-change，
        // 否则「新建文件」这一类产物的 +N/−M 会在持久化这一层被丢掉。
        if ((kind === 'code-change' || kind === 'file') && artifact.preview?.kind === 'code') {
          const additions = Number.isSafeInteger(artifact.preview.additions) && artifact.preview.additions >= 0
            ? artifact.preview.additions
            : 0;
          const deletions = Number.isSafeInteger(artifact.preview.deletions) && artifact.preview.deletions >= 0
            ? artifact.preview.deletions
            : 0;
          const diffLines = Array.isArray(artifact.preview.diffLines)
            ? artifact.preview.diffLines
              .filter((line) => typeof line === 'string')
              .slice(0, 41)
              .map((line) => line.slice(0, 240))
            : [];
          if (diffLines.length > 0) normalized.preview = { kind: 'code', additions, deletions, diffLines };
        }
        if (kind === 'image' && artifact.preview?.kind === 'image') {
          const dataUrl = normalizeOptionalString(artifact.preview.dataUrl);
          const width = Number.isSafeInteger(artifact.preview.width) && artifact.preview.width > 0
            ? Math.min(640, artifact.preview.width)
            : 0;
          const height = Number.isSafeInteger(artifact.preview.height) && artifact.preview.height > 0
            ? Math.min(640, artifact.preview.height)
            : 0;
          if (dataUrl && dataUrl.length <= 512 * 1024
            && /^data:image\/(?:png|jpeg|webp);base64,/i.test(dataUrl)
            && width > 0 && height > 0) {
            normalized.preview = { kind: 'image', dataUrl, width, height };
          }
        }
        return normalized;
      })
      .filter(Boolean)
    : [];
  if (userArtifacts.length > 0) record.userArtifacts = userArtifacts;
  const filePreview = value.bodyPreview?.kind === 'file'
    && ['local.file.read', 'local.file.list', 'local.file.search'].includes(record.capabilityId)
    && ['read_file', 'list_files', 'search_files'].includes(record.toolName);
  const commandPreview = value.bodyPreview?.kind === 'command' && record.capabilityId === 'local.shell.exec'
    && ['bash', 'Bash'].includes(record.toolName);
  if ((filePreview || commandPreview) && typeof value.bodyPreview.text === 'string') {
    record.bodyPreview = {
      kind: value.bodyPreview.kind, text: value.bodyPreview.text.slice(0, 4000),
      truncated: value.bodyPreview.truncated === true || value.bodyPreview.text.length > 4000,
    };
  }
  return record;
}

const EVIDENCE_WRAPPER_TOOL_NAMES = new Set(['goal_update_task']);

export function mergeEvidenceIndexRecords(current, incoming) {
  if (!current) return incoming;
  if (!incoming) return current;
  // A delivery wrapper (including an old writer's lossy append) cannot rebind a
  // canonical publication's source. These are immutable facts, not last-writer metadata.
  if (current.interactiveInspection && incoming.interactiveInspection
    && JSON.stringify(current.interactiveInspection) !== JSON.stringify(incoming.interactiveInspection)) throw Object.assign(Error('interactive_inspection_conflict'), { code: 'interactive_inspection_conflict' });
  const canonical = [current, incoming].find(record => record.interactiveInspection || record.userArtifacts?.some(item => item.kind === 'interactive'));
  const merged = { ...current };
  if (canonical?.interactiveInspection) merged.interactiveInspection = canonical.interactiveInspection;
  if (incoming.bodyPreview && !current.bodyPreview && !EVIDENCE_WRAPPER_TOOL_NAMES.has(incoming.toolName)) {
    merged.bodyPreview = incoming.bodyPreview;
  }
  for (const field of ['planId', 'conversationId', 'streamId']) {
    if (incoming[field]) merged[field] = incoming[field];
  }
  const currentIsWrapper = EVIDENCE_WRAPPER_TOOL_NAMES.has(current.toolName);
  const incomingIsWrapper = EVIDENCE_WRAPPER_TOOL_NAMES.has(incoming.toolName);
  if (!current.toolName || (currentIsWrapper && !incomingIsWrapper)) {
    for (const field of ['toolCallId', 'capabilityId', 'toolName']) {
      if (incoming[field]) merged[field] = incoming[field];
    }
    if (incoming.createdAt) merged.createdAt = incoming.createdAt;
  } else if (!incomingIsWrapper) {
    for (const field of ['toolCallId', 'capabilityId', 'toolName']) {
      if (!merged[field] && incoming[field]) merged[field] = incoming[field];
    }
  }
  const artifactRefs = [...new Set(normalizeEvidenceRefList([
    ...(current.artifactRefs ?? []),
    ...(incoming.artifactRefs ?? []),
  ]))];
  if (artifactRefs.length > 0) merged.artifactRefs = artifactRefs;
  const userArtifacts = new Map();
  for (const artifact of [...(current.userArtifacts ?? []), ...(incoming.userArtifacts ?? [])]) {
    if (artifact?.ref) userArtifacts.set(artifact.ref, artifact);
  }
  if (userArtifacts.size > 0) merged.userArtifacts = [...userArtifacts.values()];
  if (canonical) for (const field of ['planId', 'conversationId', 'streamId', 'toolCallId', 'capabilityId', 'toolName', 'createdAt']) {
    if (canonical[field] !== undefined) merged[field] = canonical[field]; else delete merged[field];
  }
  return merged;
}

/** Fold only the new append-only publication facts; preserve legacy index semantics. */
export function retainInteractiveEvidence(records) {
  const output = [], positions = new Map();
  for (const record of records) {
    const interactive = record.userArtifacts?.some(item => item.kind === 'interactive')
      || record.artifactRefs?.some(ref => parseInteractiveArtifactRef(ref)) || isInteractiveInspectionEvidenceRef(record.evidenceRef);
    if (!interactive) { output.push(record); continue; }
    const position = positions.get(record.evidenceRef);
    if (position === undefined) { positions.set(record.evidenceRef, output.length); output.push(record); }
    else output[position] = mergeEvidenceIndexRecords(output[position], record);
  }
  return output;
}

export function goalFileVersion(file) {
  try {
    const stat = statSync(file);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch { return null; }
  }
