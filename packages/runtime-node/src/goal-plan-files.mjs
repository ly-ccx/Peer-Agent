import { normalizeEvidenceRefList, normalizeOptionalString } from "./goal-plan-domain.mjs";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { randomUUID } from "node:crypto";
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
      if (!EVIDENCE_WRAPPER_TOOL_NAMES.has(parsed.toolName)) {
        resolvedOriginals.add(parsed.evidenceRef);
      }
    }
    return [...found.values()];
  } finally {
    closeSync(fd);
  }
}

export function appendJsonl(filePath, obj) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
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

export function writeJsonAtomic(filePath, obj) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  renameSync(tmp, filePath);
  jsonReadCache.delete(filePath);
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
  const artifactRefs = normalizeEvidenceRefList(value.artifactRefs);
  if (artifactRefs.length > 0) record.artifactRefs = artifactRefs;
  const userArtifacts = Array.isArray(value.userArtifacts)
    ? value.userArtifacts
      .filter((artifact) => artifact && typeof artifact === 'object')
      .map((artifact) => {
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
  const merged = { ...current };
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
  const artifactRefs = normalizeEvidenceRefList([
    ...(current.artifactRefs ?? []),
    ...(incoming.artifactRefs ?? []),
  ]);
  if (artifactRefs.length > 0) merged.artifactRefs = artifactRefs;
  const userArtifacts = new Map();
  for (const artifact of [...(current.userArtifacts ?? []), ...(incoming.userArtifacts ?? [])]) {
    if (artifact?.ref) userArtifacts.set(artifact.ref, artifact);
  }
  if (userArtifacts.size > 0) merged.userArtifacts = [...userArtifacts.values()];
  return merged;
}

export function goalFileVersion(file) {
  try {
    const stat = statSync(file);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch { return null; }
  }
