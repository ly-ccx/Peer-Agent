import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readFile, readdir, stat as statAsync } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { createPermissionGrant, nowIso } from './tool-result-factory.mjs';

const MAX_TOOL_CONTEXT_CHARS = 4_000;
/** Hard cap for write_file content (UTF-8 bytes). Giant single payloads stall SSE tool-arg streams. */
export const MAX_WRITE_FILE_BYTES = 32 * 1024;

const FILE_CAPABILITY_TO_TOOL = {
  'local.file.read': 'read_file',
  'local.file.list': 'list_files',
  'local.file.edit': 'edit_file',
  'local.file.write': 'write_file',
  'local.file.search': 'search_files',
};

// Explorer 只读搜索：限定在 workspace 内、跳过依赖/构建产物与二进制文件，
// 避免遍历成本失控，同时保持与 read_file 一致的只读边界。
const SEARCH_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  '.idea',
  '.vscode',
  '.pnpm',
  '__pycache__',
  '.venv',
  'venv',
  'target',
]);
const SEARCH_MAX_FILE_BYTES = 1_000_000;
const SEARCH_DEFAULT_MAX_RESULTS = 50;
const SEARCH_MAX_RESULTS_CAP = 200;
const SEARCH_MAX_FILES_SCANNED = 5_000;
const SEARCH_YIELD_EVERY_FILES = 16;
const SEARCH_SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.7z',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp4', '.mp3', '.wav', '.mov',
  '.wasm', '.dylib', '.so', '.dll', '.bin',
]);

let ripgrepResolved = null;

function yieldEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('search aborted');
  error.name = 'AbortError';
  throw error;
}

async function hasRipgrep() {
  if (process.env.PEER_AGENT_DISABLE_RIPGREP === '1') return false;
  if (ripgrepResolved !== null) return ripgrepResolved;
  ripgrepResolved = await new Promise((resolvePromise) => {
    const child = spawn('rg', ['--version'], { stdio: 'ignore' });
    child.once('error', () => resolvePromise(false));
    child.once('exit', (code) => resolvePromise(code === 0));
  });
  return ripgrepResolved;
}

function previewText(value, maxChars = MAX_TOOL_CONTEXT_CHARS) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return { text, truncated: false };
  const headChars = Math.max(1_000, Math.floor(maxChars * 0.55));
  const tailChars = Math.max(800, maxChars - headChars - 80);
  return {
    text: `${text.slice(0, headChars)}\n...[context preview truncated: ${text.length} chars]...\n${text.slice(-tailChars)}`,
    truncated: true,
  };
}

function quoteShellPath(filePath) {
  return `"${String(filePath ?? '').replace(/(["\\$`])/g, '\\$1')}"`;
}

function lineCount(value) {
  const text = String(value ?? '');
  return text ? text.split('\n').length : 0;
}

function formatContextResult(payload) {
  return JSON.stringify(payload, null, 2);
}

function hashContent(content) {
  return createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex');
}

function resolveToolPath(rawPath, cwd) {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new Error('path is required');
  }
  return isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath);
}

function isInsidePath(filePath, rootPath) {
  const rel = relative(resolve(rootPath), resolve(filePath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function ensureWritablePathAllowed({ tool, args, filePath, workspacePath, requestPermission }) {
  if (isInsidePath(filePath, workspacePath)) return { granted: true };
  if (typeof requestPermission !== 'function') {
    return {
      granted: false,
      reason: `Refusing to ${tool === 'edit_file' ? 'edit' : 'write'} outside the active workspace: ${filePath}`,
    };
  }
  const approval = await requestPermission({ tool, args, filePath, workspacePath });
  if (approval?.granted) {
    return { granted: true, approval };
  }
  return {
    granted: false,
    approval,
    reason: `User denied ${tool} outside the active workspace: ${filePath}`,
  };
}

// 只读检索的越界判定：与 ensureWritablePathAllowed 对称。
// workspace 内直接放行；越界时走同一套 requestPermission 网关（full_local 自动放行，
// 其它 accessLevel 弹窗确认）。requestPermission 缺失时回退到原有 workspace 限制文案，
// 保证未接权限管道的调用方行为不变。
async function ensureReadablePathAllowed({ tool, args, filePath, workspacePath, requestPermission }) {
  if (isInsidePath(filePath, workspacePath)) return { granted: true };
  if (typeof requestPermission !== 'function') {
    return {
      granted: false,
      reason: `${tool} is restricted to the workspace; path must stay inside the workspace root.`,
    };
  }
  const approval = await requestPermission({ tool, args, filePath, workspacePath });
  if (approval?.granted) {
    return { granted: true, approval };
  }
  return {
    granted: false,
    approval,
    reason: `User denied ${tool} outside the active workspace: ${filePath}`,
  };
}

function getFileSnapshot(filePath, content = null) {
  const stats = statSync(filePath);
  const currentContent = content === null ? readFileSync(filePath, 'utf8') : content;
  return {
    content: currentContent,
    contentHash: hashContent(currentContent),
    mtimeMs: stats.mtimeMs,
    sizeBytes: stats.size,
  };
}

function recordReadState(toolContext, { cwd, filePath, content, fullRead = true }) {
  if (!toolContext?.readFiles) return null;
  const snapshot = getFileSnapshot(filePath, content);
  const state = {
    conversationId: toolContext.conversationId || null,
    workspacePath: cwd,
    filePath,
    contentHash: snapshot.contentHash,
    mtimeMs: snapshot.mtimeMs,
    sizeBytes: snapshot.sizeBytes,
    fullRead,
    readAt: new Date().toISOString(),
  };
  toolContext.readFiles.set(filePath, state);
  return state;
}

function requireReadState(toolContext, filePath) {
  const state = toolContext?.readFiles?.get(filePath);
  if (!state?.fullRead) {
    return {
      ok: false,
      reason: `Existing file must be read with read_file before editing or overwriting: ${filePath}`,
    };
  }
  return { ok: true, state };
}

function validateFreshReadState(toolContext, filePath) {
  const readState = requireReadState(toolContext, filePath);
  if (!readState.ok) return readState;

  const current = getFileSnapshot(filePath);
  if (current.contentHash !== readState.state.contentHash) {
    return {
      ok: false,
      reason: [
        'File changed after it was read; re-run read_file before editing.',
        `path: ${filePath}`,
        `readHash: ${readState.state.contentHash}`,
        `currentHash: ${current.contentHash}`,
      ].join('\n'),
    };
  }

  return { ok: true, state: readState.state, current };
}

function countOccurrences(content, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const found = content.indexOf(needle, index);
    if (found === -1) break;
    count += 1;
    index = found + needle.length;
  }
  return count;
}

function truncateText(text, maxChars = MAX_TOOL_CONTEXT_CHARS) {
  const value = String(text ?? '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 90)}\n...[diff preview truncated: ${value.length} chars]...`;
}

function createUnifiedDiffPreview(filePath, before, after, maxChars = MAX_TOOL_CONTEXT_CHARS) {
  if (before === after) return '';
  const beforeLines = String(before ?? '').split('\n');
  const afterLines = String(after ?? '').split('\n');
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const context = 3;
  const beforeStart = Math.max(0, prefix - context);
  const afterStart = Math.max(0, prefix - context);
  const beforeEnd = Math.min(beforeLines.length, beforeLines.length - suffix + context);
  const afterEnd = Math.min(afterLines.length, afterLines.length - suffix + context);
  const beforeChangeStart = prefix;
  const beforeChangeEnd = beforeLines.length - suffix;
  const afterChangeStart = prefix;
  const afterChangeEnd = afterLines.length - suffix;

  const lines = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${beforeStart + 1},${beforeEnd - beforeStart} +${afterStart + 1},${afterEnd - afterStart} @@`,
  ];

  for (let i = beforeStart; i < beforeChangeStart; i += 1) {
    lines.push(` ${beforeLines[i] ?? ''}`);
  }
  for (let i = beforeChangeStart; i < beforeChangeEnd; i += 1) {
    lines.push(`-${beforeLines[i] ?? ''}`);
  }
  for (let i = afterChangeStart; i < afterChangeEnd; i += 1) {
    lines.push(`+${afterLines[i] ?? ''}`);
  }
  for (let i = Math.max(beforeChangeEnd, beforeEnd - context); i < beforeEnd; i += 1) {
    if (i >= beforeChangeEnd && i < beforeLines.length) lines.push(` ${beforeLines[i] ?? ''}`);
  }

  return truncateText(lines.join('\n'), maxChars);
}

function formatToolFailure(tool, status, reason, extra = {}) {
  return {
    success: false,
    error: reason,
    output: formatContextResult({
      kind: `${tool}_result`,
      tool,
      status,
      reason,
      ...extra,
    }),
  };
}

function materializeFileRead({ filePath, content, readState }) {
  const snapshot = readState ?? getFileSnapshot(filePath, content);
  const preview = previewText(content);
  return {
    success: true,
    output: formatContextResult({
      kind: 'local_file_ref',
      tool: 'read_file',
      path: filePath,
      chars: content.length,
      lines: lineCount(content),
      mtimeMs: snapshot.mtimeMs,
      sizeBytes: snapshot.sizeBytes,
      contentHash: snapshot.contentHash,
      fullRead: readState?.fullRead ?? true,
      preview: preview.text,
      contextPreviewTruncated: preview.truncated,
      suggestedRetrieval: [
        `sed -n '1,160p' ${quoteShellPath(filePath)}`,
        `rg -n "<pattern>" ${quoteShellPath(filePath)}`,
      ],
    }),
  };
}

function formatSearchSuccess({ query, cwd, searchRoot, matches, filesWithMatches, truncated }) {
  const summaryLines = matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
  const headline = matches.length === 0
    ? `No matches for "${query}".`
    : `Found ${matches.length} match(es) in ${filesWithMatches} file(s)${truncated ? ' (truncated)' : ''}.`;
  return {
    success: true,
    output: formatContextResult({
      status: 'success',
      tool: 'search_files',
      query,
      root: relative(cwd, searchRoot) || '.',
      matchCount: matches.length,
      fileCount: filesWithMatches,
      truncated,
      matches,
      preview: [headline, ...summaryLines].join('\n'),
    }),
  };
}

async function searchWithRipgrep({ query, searchRoot, cwd, caseSensitive, maxResults, signal }) {
  const args = [
    '--json',
    '--hidden',
    '--color', 'never',
    '--fixed-strings',
    '--max-filesize', String(SEARCH_MAX_FILE_BYTES),
  ];
  if (!caseSensitive) args.push('-i');
  for (const dir of SEARCH_IGNORED_DIRS) {
    args.push('--glob', `!${dir}/**`);
  }
  args.push('--', query, searchRoot);

  return await new Promise((resolvePromise, reject) => {
    const child = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let settled = false;
    const matches = [];
    const matchedFiles = new Set();
    let truncated = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        reject(error);
        return;
      }
      resolvePromise({
        matches,
        filesWithMatches: matchedFiles.size,
        truncated,
      });
    };

    const onAbort = () => {
      child.kill('SIGTERM');
      const error = new Error('search aborted');
      error.name = 'AbortError';
      finish(error);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed?.type !== 'match') continue;
        const absPath = parsed.data?.path?.text;
        const lineNumber = parsed.data?.line_number;
        const text = String(parsed.data?.lines?.text ?? '').replace(/\n$/, '');
        if (!absPath || !Number.isFinite(lineNumber)) continue;
        matches.push({
          path: relative(cwd, absPath) || absPath,
          line: lineNumber,
          text: truncateText(text.trim(), 240),
        });
        matchedFiles.add(absPath);
        if (matches.length >= maxResults) {
          truncated = true;
          child.kill('SIGTERM');
          finish(null);
          return;
        }
      }
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code, sig) => {
      if (settled) return;
      if (code === 0 || code === 1 || code === null || sig === 'SIGTERM' || sig === 'SIGKILL') {
        finish(null);
        return;
      }
      const error = new Error(`rg exited with code ${code}`);
      error.code = 'RG_EXIT';
      finish(error);
    });
  });
}

async function searchByWalkingFiles({ query, searchRoot, cwd, caseSensitive, maxResults, signal }) {
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches = [];
  const stack = [searchRoot];
  let scanned = 0;
  let filesWithMatches = 0;
  let truncated = false;

  while (stack.length > 0) {
    throwIfAborted(signal);
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      throwIfAborted(signal);
      const entryPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (SEARCH_IGNORED_DIRS.has(entry.name)) continue;
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SEARCH_SKIP_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      scanned += 1;
      if (scanned > SEARCH_MAX_FILES_SCANNED) {
        truncated = truncated || matches.length >= maxResults;
        return { matches, filesWithMatches, truncated: true };
      }
      if (scanned % SEARCH_YIELD_EVERY_FILES === 0) {
        await yieldEventLoop();
        throwIfAborted(signal);
      }
      if (matches.length >= maxResults) {
        truncated = true;
        return { matches, filesWithMatches, truncated };
      }

      let fileStat;
      try {
        fileStat = await statAsync(entryPath);
      } catch {
        continue;
      }
      if (fileStat.size > SEARCH_MAX_FILE_BYTES) continue;

      let content;
      try {
        content = await readFile(entryPath, 'utf8');
      } catch {
        continue;
      }
      if (content.includes('\u0000')) continue;

      const lines = content.split('\n');
      let fileMatched = false;
      for (let i = 0; i < lines.length; i += 1) {
        const haystack = caseSensitive ? lines[i] : lines[i].toLowerCase();
        if (!haystack.includes(needle)) continue;
        fileMatched = true;
        matches.push({
          path: relative(cwd, entryPath) || entryPath,
          line: i + 1,
          text: truncateText(lines[i].trim(), 240),
        });
        if (matches.length >= maxResults) {
          truncated = true;
          break;
        }
      }
      if (fileMatched) filesWithMatches += 1;
      if (truncated) return { matches, filesWithMatches, truncated };
    }
  }

  return { matches, filesWithMatches, truncated };
}

export async function runFileSearch({ args = {}, cwd, requestPermission, signal } = {}) {
  const query = typeof args.query === 'string' ? args.query : '';
  if (query.length === 0) {
    return formatToolFailure('search_files', 'blocked', 'query must be a non-empty string');
  }

  const searchRoot = args.path ? resolveToolPath(args.path, cwd) : resolve(cwd);
  const pathPermission = await ensureReadablePathAllowed({
    tool: 'search_files',
    args,
    filePath: searchRoot,
    workspacePath: cwd,
    requestPermission,
  });
  if (!pathPermission.granted) {
    return formatToolFailure('search_files', 'blocked', pathPermission.reason, {
      path: searchRoot,
      workspacePath: cwd,
      permission: pathPermission.approval?.reason || 'not_granted',
    });
  }
  if (!existsSync(searchRoot)) {
    return formatToolFailure('search_files', 'failed', `Path not found: ${searchRoot}`, {
      path: searchRoot,
    });
  }

  const maxResults = Math.min(
    Math.max(Number.isInteger(args.max_results) ? args.max_results : SEARCH_DEFAULT_MAX_RESULTS, 1),
    SEARCH_MAX_RESULTS_CAP,
  );
  const caseSensitive = args.case_sensitive === true;
  throwIfAborted(signal);

  let scanned;
  try {
    scanned = await hasRipgrep()
      ? await searchWithRipgrep({ query, searchRoot, cwd, caseSensitive, maxResults, signal })
      : await searchByWalkingFiles({ query, searchRoot, cwd, caseSensitive, maxResults, signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    scanned = await searchByWalkingFiles({ query, searchRoot, cwd, caseSensitive, maxResults, signal });
  }

  return formatSearchSuccess({
    query,
    cwd,
    searchRoot,
    matches: scanned.matches,
    filesWithMatches: scanned.filesWithMatches,
    truncated: scanned.truncated,
  });
}

async function runFileTool({ name, args, cwd, toolContext, requestPermission }) {
  try {
    if (name === 'read_file') {
      const filePath = resolveToolPath(args.path, cwd);
      if (!existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
      const content = readFileSync(filePath, 'utf8');
      const readState = recordReadState(toolContext, { cwd, filePath, content, fullRead: true });
      return materializeFileRead({ filePath, content, readState });
    }

    if (name === 'list_files') {
      const directoryPath = resolveToolPath(args.path ?? '.', cwd);
      if (!existsSync(directoryPath)) return { success: false, error: `Directory not found: ${directoryPath}` };
      if (!statSync(directoryPath).isDirectory()) return { success: false, error: `Not a directory: ${directoryPath}` };
      const entries = readdirSync(directoryPath, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => ({
          name: entry.name,
          path: relative(cwd, resolve(directoryPath, entry.name)) || '.',
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        }));
      return {
        success: true,
        output: formatContextResult({
          status: 'success',
          tool: name,
          path: relative(cwd, directoryPath) || '.',
          entries,
        }),
      };
    }

    if (name === 'search_files') {
      return runFileSearch({ args, cwd, requestPermission });
    }

    if (name === 'edit_file') {
      const filePath = resolveToolPath(args.path, cwd);
      if (!existsSync(filePath)) {
        return formatToolFailure('edit_file', 'failed', `File not found: ${filePath}`, { path: filePath });
      }
      if (typeof args.old_string !== 'string' || args.old_string.length === 0) {
        return formatToolFailure('edit_file', 'blocked', 'old_string must be a non-empty string', { path: filePath });
      }
      if (typeof args.new_string !== 'string') {
        return formatToolFailure('edit_file', 'blocked', 'new_string must be a string', { path: filePath });
      }

      const freshness = validateFreshReadState(toolContext, filePath);
      if (!freshness.ok) {
        return formatToolFailure('edit_file', 'blocked', freshness.reason, { path: filePath });
      }

      const before = freshness.current.content;
      const occurrences = countOccurrences(before, args.old_string);
      if (occurrences === 0) {
        return formatToolFailure('edit_file', 'blocked', 'old_string was not found in the current file; re-read the file and retry with an exact match.', { path: filePath });
      }
      if (occurrences > 1 && args.replace_all !== true) {
        return formatToolFailure('edit_file', 'blocked', `old_string matched ${occurrences} times; set replace_all=true only if every occurrence should be replaced.`, { path: filePath, occurrences });
      }

      const after = args.replace_all === true
        ? before.split(args.old_string).join(args.new_string)
        : before.replace(args.old_string, args.new_string);
      const replacements = args.replace_all === true ? occurrences : 1;
      const diffPreview = createUnifiedDiffPreview(filePath, before, after);
      const pathPermission = await ensureWritablePathAllowed({
        tool: 'edit_file',
        args,
        filePath,
        workspacePath: cwd,
        requestPermission,
      });
      if (!pathPermission.granted) {
        return formatToolFailure('edit_file', 'blocked', pathPermission.reason, {
          path: filePath,
          workspacePath: cwd,
          permission: pathPermission.approval?.reason || 'not_granted',
        });
      }
      writeFileSync(filePath, after, 'utf8');
      const nextState = recordReadState(toolContext, { cwd, filePath, content: after, fullRead: true });
      return {
        success: true,
        output: formatContextResult({
          kind: 'file_edit_result',
          tool: 'edit_file',
          status: 'success',
          path: filePath,
          replacements,
          bytesBefore: Buffer.byteLength(before, 'utf8'),
          bytesAfter: Buffer.byteLength(after, 'utf8'),
          mtimeBefore: freshness.current.mtimeMs,
          mtimeAfter: nextState?.mtimeMs ?? null,
          contentHashBefore: freshness.current.contentHash,
          contentHashAfter: nextState?.contentHash ?? hashContent(after),
          diffPreview,
          contextPreviewTruncated: diffPreview.length >= MAX_TOOL_CONTEXT_CHARS,
        }),
      };
    }

    if (name === 'write_file') {
      const filePath = resolveToolPath(args.path, cwd);
      if (typeof args.content !== 'string') {
        return formatToolFailure('write_file', 'blocked', 'content must be a string', { path: filePath });
      }
      const contentBytes = Buffer.byteLength(args.content, 'utf8');
      if (contentBytes > MAX_WRITE_FILE_BYTES) {
        return formatToolFailure(
          'write_file',
          'blocked',
          `write_file content exceeds ${MAX_WRITE_FILE_BYTES} bytes (got ${contentBytes}). Use chunked writes: write a short skeleton with write_file, then append/revise with multiple edit_file calls. Do not emit one giant payload.`,
          { path: filePath, contentBytes, maxBytes: MAX_WRITE_FILE_BYTES },
        );
      }

      const exists = existsSync(filePath);
      let before = '';
      let beforeSnapshot = null;
      if (exists) {
        if (args.allow_overwrite !== true) {
          return formatToolFailure('write_file', 'blocked', 'write_file cannot replace an existing file unless allow_overwrite=true; use edit_file for scoped changes.', { path: filePath });
        }
        const freshness = validateFreshReadState(toolContext, filePath);
        if (!freshness.ok) {
          return formatToolFailure('write_file', 'blocked', freshness.reason, { path: filePath });
        }
        before = freshness.current.content;
        beforeSnapshot = freshness.current;
      }

      const pathPermission = await ensureWritablePathAllowed({
        tool: 'write_file',
        args,
        filePath,
        workspacePath: cwd,
        requestPermission,
      });
      if (!pathPermission.granted) {
        return formatToolFailure('write_file', 'blocked', pathPermission.reason, {
          path: filePath,
          workspacePath: cwd,
          permission: pathPermission.approval?.reason || 'not_granted',
        });
      }

      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, args.content, 'utf8');
      const nextState = recordReadState(toolContext, { cwd, filePath, content: args.content, fullRead: true });
      const diffPreview = exists ? createUnifiedDiffPreview(filePath, before, args.content) : '';
      return {
        success: true,
        output: formatContextResult({
          kind: 'file_write_result',
          tool: 'write_file',
          status: 'success',
          path: filePath,
          created: !exists,
          bytesWritten: Buffer.byteLength(args.content, 'utf8'),
          mtimeBefore: beforeSnapshot?.mtimeMs ?? null,
          mtimeAfter: nextState?.mtimeMs ?? null,
          contentHashBefore: beforeSnapshot?.contentHash ?? null,
          contentHashAfter: nextState?.contentHash ?? hashContent(args.content),
          diffPreview: diffPreview || null,
          contextPreviewTruncated: diffPreview.length >= MAX_TOOL_CONTEXT_CHARS,
        }),
      };
    }

    return { success: false, error: `Unknown file tool: ${name}` };
  } catch (err) {
    return { success: false, error: err?.message || 'file capability failed', stderr: err?.stderr?.slice?.(0, 4000) };
  }
}

function statusFromFileResult(fileResult) {
  if (fileResult.success) return 'success';
  try {
    const parsed = JSON.parse(fileResult.output || '{}');
    return parsed.status === 'blocked' ? 'denied' : (parsed.status || 'failed');
  } catch {
    return 'failed';
  }
}

function buildFileCapabilityResult({ call, name, locale, fileResult }) {
  const status = statusFromFileResult(fileResult);
  const dataLevel =
    name === 'read_file' || name === 'list_files' || name === 'search_files'
      ? 'D1_internal'
      : 'D2_sensitive';
  return {
    toolCallId: call.toolCallId,
    status,
    outputPreview: {
      status,
      tool: name,
      fileResult,
      legacyResult: fileResult,
    },
    evidence: {
      evidenceId: randomUUID(),
      toolCallId: call.toolCallId,
      summary: locale === 'zh-CN'
        ? `本地文件能力 ${name} 执行完成，状态：${status}。`
        : `Local file capability ${name} completed with status ${status}.`,
      locale,
      returnedToCloud: false,
      dataLevel,
      redactions: [],
      artifactRefs: [],
    },
    completedAt: nowIso(),
  };
}

function readArgs(call) {
  if (call.arguments && typeof call.arguments === 'object') return call.arguments;
  if (typeof call.arguments === 'string') {
    try {
      return JSON.parse(call.arguments);
    } catch {
      return {};
    }
  }
  return {};
}

export function createLocalFileProvider({ workspaceRoot } = {}) {
  async function executeCapability(request, context = {}) {
    const call = request.call;
    const name = FILE_CAPABILITY_TO_TOOL[call.capabilityId];
    if (!name) return null;
    const args = readArgs(call);
    const cwd = context.workspaceRoot || workspaceRoot || process.cwd();
    const fileResult = await runFileTool({
      name,
      args,
      cwd,
      toolContext: context.toolContext,
      requestPermission: context.requestPermission,
    });
    const status = statusFromFileResult(fileResult);
    const grant = createPermissionGrant({
      toolCallId: call.toolCallId,
      granted: status !== 'denied',
      scope: call.capabilityId,
      duration: status !== 'denied' ? 'once' : 'denied',
    });

    return {
      call,
      grant,
      result: buildFileCapabilityResult({
        call,
        name,
        locale: context.locale ?? 'zh-CN',
        fileResult,
      }),
    };
  }

  return {
    providerId: 'local.file',
    capabilityIds: Object.keys(FILE_CAPABILITY_TO_TOOL),
    executeCapability,
  };
}
