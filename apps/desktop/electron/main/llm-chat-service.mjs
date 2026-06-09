import { execSync } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  COMPACTION_CONFIG,
  compactIfNeeded,
  estimateTokensFromMessages,
  microcompactMessagesForContext,
} from './context-compactor.mjs';
import { getDataHome } from './data-store.mjs';
import {
  buildAnthropicTools,
  buildOpenAITools,
  buildSystemPrompt,
} from './llm-prompts.mjs';
import { createShellArtifactStore } from './runtime-gateway/shell-artifacts.mjs';

const activeStreams = new Map();
const pendingPermissionRequests = new Map();
const conversationToolContexts = new Map();

const OPENAI_REASONING_EFFORT = { low: 'low', default: 'medium', high: 'high' };
const ANTHROPIC_THINKING_BUDGET = { low: 4096, default: 10240, high: 32768 };
const MAX_TOOL_CONTEXT_CHARS = 4_000;
const shellArtifactStore = createShellArtifactStore({ userDataPath: getDataHome() });

const TOOLS_OPENAI = buildOpenAITools();
const TOOLS_ANTHROPIC = buildAnthropicTools();

export { buildAnthropicTools, buildOpenAITools, buildSystemPrompt };

const UNSUPPORTED_TOOL_CLAIM_PATTERNS = [
  /\[Tool call:/i,
  /真实返回|工具返回|命令返回|实际返回|stdoutPreview|stderrPreview|exitCode|tool result|command returned|tool returned/i,
  /cat\s+出来|git status|npm run|pnpm|yarn|bun\s+run|sed -n|rg -n/i,
  /(?:发起|发出了|开始|重新)(?:[^。！？\n]{0,40})(?:bash|read_file|edit_file|write_file|工具)(?:[^。！？\n]{0,40})(?:调用|执行)/u,
  /我(?:已经|刚才|实际|真实|确实)(?:[^。！？\n]{0,24})?(?:执行|运行|检查|查|看|读取|读|写入|修改|改|验证|确认|回读|拿到)/u,
  /我(?:执行了|运行了|检查了|查了|看了|读取了|读了|写入了|写好了|修改了|改了|验证了|确认了|回读了|拿到了)/u,
  /\bI\s+(?:just\s+)?(?:ran|executed|checked|verified|read|wrote|modified|updated|confirmed)\b/i,
];

const DANGLING_TOOL_INTENT_PATTERNS = [
  /(?:先|我先|接下来|现在|马上|直接|准备)(?:[^。！？\n]{0,80})(?:查|看|定位|摸清|确认|验证|读取|读|搜索|执行|运行|改|修改|动手|回读|查询)(?:[^。！？\n]{0,100})(?:：|:)\s*$/u,
  /(?:先一次性查全|相关文件和关键代码|消息发送链路|输入区结构)(?:[^。！？\n]{0,80})(?:：|:)?\s*$/u,
  /我先(?:[^。！？\n]{0,120})(?:真实工具|工具真实返回|贴真实返回|每步贴)(?:[^。！？\n]{0,80})(?:。|！|!|：|:)?\s*$/u,
  /(?:真实工具|工具真实返回|贴真实返回|每步贴)(?:[^。！？\n]{0,100})(?:：|:)?\s*$/u,
  /\b(?:I(?:'ll| will| am going to)|Let me|I need to|I'll now)(?:.{0,100})(?:inspect|check|read|run|search|look|verify|modify|write)(?:.{0,80})(?::)?\s*$/is,
];

export function hasUnsupportedToolClaim(text) {
  const value = String(text || '');
  if (!value.trim()) return false;
  return UNSUPPORTED_TOOL_CLAIM_PATTERNS.some((pattern) => pattern.test(value));
}

export function hasDanglingToolIntent(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  return DANGLING_TOOL_INTENT_PATTERNS.some((pattern) => pattern.test(value));
}

function shouldRetryNoToolResponse(text) {
  return hasUnsupportedToolClaim(text) || hasDanglingToolIntent(text);
}

function unsupportedToolResponseCorrection() {
  return [
    'The previous assistant output claimed or promised local tool/file/command activity, but this turn emitted no actual tool call.',
    'Discard that output.',
    'If the user request requires local filesystem, git, shell, build, runtime, or verification facts, call an available tool now.',
    'Do not stop after a tool-use preamble. Either emit the tool call in this turn, or answer without claiming or promising local execution.',
  ].join(' ');
}

function unsupportedToolResponseFallback() {
  return '我还没有完成实际工具调用，因此不能声称或承诺已经读取、执行、修改或验证。本轮回答已被拦截，避免把无工具证据的内容写入对话。';
}

function emptyModelResponseError() {
  return 'empty_model_response: 模型没有返回任何文本或工具调用，请检查当前模型、baseUrl、API 兼容性或模型是否支持当前请求格式。';
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

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) return null;
  const mediaType = match[1] || 'application/octet-stream';
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || '';
  const data = isBase64 ? payload : Buffer.from(decodeURIComponent(payload), 'utf8').toString('base64');
  return { mediaType, data };
}

function normalizeOpenAIContent(content) {
  if (!Array.isArray(content)) return content;
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      parts.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url' && part.image_url?.url) {
      parts.push({ type: 'image_url', image_url: { url: String(part.image_url.url) } });
    } else {
      parts.push(part);
    }
  }
  return parts.length ? parts : '';
}

function normalizeAnthropicContent(content) {
  if (!Array.isArray(content)) return content;
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      parts.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url' && part.image_url?.url) {
      const parsed = parseDataUrl(part.image_url.url);
      if (parsed?.mediaType.startsWith('image/')) {
        parts.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: parsed.mediaType,
            data: parsed.data,
          },
        });
      }
    } else if (part.type === 'image' || part.type === 'tool_use' || part.type === 'tool_result') {
      parts.push(part);
    }
  }
  return parts.length ? parts : '';
}

export function normalizeOpenAIMessages(messages) {
  return messages.map((message) => ({
    ...message,
    content: normalizeOpenAIContent(message.content),
  }));
}

export function normalizeAnthropicMessages(messages) {
  return messages.map((message) => ({
    ...message,
    content: normalizeAnthropicContent(message.content),
  }));
}

function hashContent(content) {
  return createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex');
}

export function createToolContext({ conversationId = null, workspacePath = null } = {}) {
  return {
    conversationId,
    workspacePath,
    readFiles: new Map(),
  };
}

function getConversationToolContext({ conversationId = null, workspacePath = null } = {}) {
  if (!conversationId) return createToolContext({ conversationId, workspacePath });
  const key = `${conversationId}::${workspacePath || process.cwd()}`;
  let context = conversationToolContexts.get(key);
  if (!context) {
    context = createToolContext({ conversationId, workspacePath });
    conversationToolContexts.set(key, context);
  }
  return context;
}

function resolveToolPath(rawPath, cwd) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new Error('path must be a non-empty string');
  }
  return isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath);
}

function isInsidePath(filePath, rootPath) {
  const rel = relative(resolve(rootPath), resolve(filePath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function buildFilePermissionCall({ tool, args, filePath, workspacePath, toolCallId }) {
  const action = tool === 'edit_file' ? 'edit' : 'write';
  return {
    toolCallId: `chat-permission:${toolCallId || randomUUID()}`,
    capabilityId: `local.file.${action}`,
    displayName: tool,
    reason: `The ${tool} tool wants to modify a file outside the active workspace.`,
    arguments: {
      tool,
      path: filePath,
      workspacePath,
      args,
    },
    argumentsPreview: {
      command: `${action} ${filePath}`,
      action,
      path: filePath,
      workspacePath,
    },
    riskLevel: 'L2_local_write',
    dataLevel: 'D2_sensitive',
    requestedAt: new Date().toISOString(),
  };
}

function createChatPermissionRequester({ webContents, streamId, toolCallId }) {
  return ({ tool, args, filePath, workspacePath }) => new Promise((resolvePermission) => {
    const call = buildFilePermissionCall({ tool, args, filePath, workspacePath, toolCallId });
    pendingPermissionRequests.set(call.toolCallId, {
      streamId,
      resolve: resolvePermission,
    });
    const active = activeStreams.get(streamId);
    if (active) {
      if (!active.permissionIds) active.permissionIds = new Set();
      active.permissionIds.add(call.toolCallId);
    }
    webContents.send('chat:stream:permission-request', { streamId, call });
  });
}

function settlePermissionRequest(toolCallId, grant) {
  const pending = pendingPermissionRequests.get(toolCallId);
  if (!pending) return false;
  pendingPermissionRequests.delete(toolCallId);
  activeStreams.get(pending.streamId)?.permissionIds?.delete(toolCallId);
  pending.resolve({
    granted: Boolean(grant?.granted),
    grant,
    reason: grant?.granted ? 'local_user_approved_once' : 'local_user_denied',
  });
  return true;
}

function settleStreamPermissionRequests(streamId, grant) {
  const active = activeStreams.get(streamId);
  const ids = active?.permissionIds ? [...active.permissionIds] : [];
  for (const id of ids) {
    settlePermissionRequest(id, grant);
  }
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

function isPromptTooLongResponse(status, text) {
  if (status === 413) return true;
  const value = String(text || '').toLowerCase();
  return (
    value.includes('prompt_too_long') ||
    value.includes('context_length_exceeded') ||
    value.includes('maximum context length') ||
    value.includes('too many tokens') ||
    value.includes('token limit')
  );
}

async function persistAndNotifyCompaction({
  persistCompaction,
  conversationId,
  compactResult,
  streamId,
  webContents,
  emergency = false,
}) {
  if (persistCompaction && conversationId) {
    await persistCompaction({ conversationId, compactResult, preservePendingAssistant: true });
  }
  webContents.send('chat:compaction', { streamId, stage: 'done', emergency, ...compactResult.notification });
}

function shouldShowCompactionStart(messages, contextWindow) {
  if (!contextWindow) return false;
  return estimateTokensFromMessages(messages) > contextWindow * COMPACTION_CONFIG.triggerRatio;
}

function hasContent(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined;
}

function isEmptyAssistantMessage(message) {
  return (
    message?.role === 'assistant' &&
    !message?.tool_calls?.length &&
    !hasContent(message?.content)
  );
}

export function sanitizeApiMessages(messages) {
  return messages.filter((message) => {
    if (!message || typeof message !== 'object') return false;
    if (isEmptyAssistantMessage(message)) return false;
    if (message.role === 'system') return hasContent(message.content);
    if (message.role === 'user') return hasContent(message.content);
    if (message.role === 'assistant') return hasContent(message.content) || Boolean(message.tool_calls?.length);
    if (message.role === 'tool') return hasContent(message.content);
    return false;
  });
}

async function materializeShellOutput({ command, cwd, stdout, stderr, exitCode, status }) {
  const taskId = `llm_shell_${randomUUID()}`;
  const now = new Date().toISOString();
  const artifact = await shellArtifactStore.writeTaskArtifacts({
    taskId,
    toolCallId: taskId,
    command,
    cwd,
    stdout,
    stderr,
    classification: {
      category: 'inline_llm_tool',
      riskLevel: 'L4_privileged',
      dataLevel: 'D2_sensitive',
      command,
      cwd,
    },
    startedAt: now,
    completedAt: now,
  });
  const stdoutPreview = previewText(stdout);
  const stderrPreview = previewText(stderr);
  return {
    success: status === 'success',
    output: formatContextResult({
      kind: 'local_tool_result_ref',
      tool: 'bash',
      command,
      cwd,
      status,
      exitCode,
      stdoutPath: artifact.stdoutPath,
      stderrPath: artifact.stderrPath,
      metadataPath: artifact.metadataPath,
      artifactRef: artifact.artifactRef,
      artifactRefs: artifact.artifactRefs,
      stdoutChars: String(stdout ?? '').length,
      stderrChars: String(stderr ?? '').length,
      stdoutLines: lineCount(stdout),
      stderrLines: lineCount(stderr),
      stdoutPreview: stdoutPreview.text || null,
      stderrPreview: stderrPreview.text || null,
      contextPreviewTruncated: stdoutPreview.truncated || stderrPreview.truncated,
      suggestedRetrieval: [
        `rg -n "FAIL|Error|error|failed|Expected|panic" ${quoteShellPath(artifact.stdoutPath)}`,
        `tail -n 120 ${quoteShellPath(artifact.stdoutPath)}`,
        ...(status === 'success' ? [] : [`sed -n '1,160p' ${quoteShellPath(artifact.stderrPath)}`]),
      ],
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

export async function executeTool(name, args, workspacePath, toolContext = null, options = {}) {
  const cwd = workspacePath || process.cwd();
  const requestPermission = options?.requestPermission;
  try {
    if (name === 'bash') {
      const output = execSync(args.command, { cwd, timeout: 30000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
      return await materializeShellOutput({
        command: args.command,
        cwd,
        stdout: output,
        stderr: '',
        exitCode: 0,
        status: 'success',
      });
    }
    if (name === 'read_file') {
      const filePath = resolveToolPath(args.path, cwd);
      if (!existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
      const content = readFileSync(filePath, 'utf8');
      const readState = recordReadState(toolContext, { cwd, filePath, content, fullRead: true });
      return materializeFileRead({ filePath, content, readState });
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
    return { success: false, error: `Unknown tool: ${name}` };
  } catch (err) {
    if (name === 'bash') {
      return await materializeShellOutput({
        command: args.command,
        cwd,
        stdout: err?.stdout?.toString?.() ?? '',
        stderr: err?.stderr?.toString?.() || err?.message || 'execution failed',
        exitCode: typeof err?.status === 'number' ? err.status : null,
        status: 'failed',
      });
    }
    return { success: false, error: err?.message || 'execution failed', stderr: err?.stderr?.slice?.(0, 4000) };
  }
}

export function createLlmChatService({ llmConfigStore, persistCompaction = null }) {
  function setWorkspacePath(wsPath) { activeWorkspacePath = wsPath; }

  function getDefaultProvider() {
    const providers = llmConfigStore.listProviders();
    return providers.find((p) => p.isDefault && p.apiKeyConfigured) || providers.find((p) => p.apiKeyConfigured) || null;
  }

  async function sendMessage({ messages, webContents, streamId, effort = 'default', conversationId = null }) {
    const provider = getDefaultProvider();
    if (!provider) {
      webContents.send('chat:stream:error', { streamId, error: 'no_provider_configured' });
      return;
    }

    const apiKey = llmConfigStore.getDecryptedApiKey(provider.id);
    if (!apiKey) {
      webContents.send('chat:stream:error', { streamId, error: 'api_key_not_found' });
      return;
    }

    const controller = new AbortController();
    activeStreams.set(streamId, { controller, webContents, permissionIds: new Set() });

    const systemPrompt = buildSystemPrompt(activeWorkspacePath);
    const toolContext = getConversationToolContext({ conversationId, workspacePath: activeWorkspacePath });

    const contextWindow = provider.contextWindow || 0;

    try {
      if (provider.provider === 'anthropic') {
        await agentLoopAnthropic({ baseUrl: provider.baseUrl, apiKey, model: provider.model, systemPrompt, messages, webContents, streamId, signal: controller.signal, effort, contextWindow, conversationId, persistCompaction, toolContext });
      } else {
        await agentLoopOpenAI({ baseUrl: provider.baseUrl, apiKey, model: provider.model, systemPrompt, messages, webContents, streamId, signal: controller.signal, effort, contextWindow, conversationId, persistCompaction, toolContext });
      }
    } catch (err) {
      console.error('[llm-chat] error:', err);
      if (err?.name !== 'AbortError') {
        webContents.send('chat:stream:error', { streamId, error: err?.message || 'stream_failed' });
      }
    } finally {
      settleStreamPermissionRequests(streamId, {
        granted: false,
        reason: 'stream_finished',
      });
      activeStreams.delete(streamId);
    }
  }

  function abort(streamId) {
    const active = activeStreams.get(streamId);
    if (!active) return { aborted: false };
    active.controller.abort();
    settleStreamPermissionRequests(streamId, {
      granted: false,
      reason: 'stream_aborted',
    });
    active.webContents.send('chat:stream:aborted', { streamId });
    activeStreams.delete(streamId);
    return { aborted: true };
  }

  function resolvePermissionGrant(toolCallId, grant) {
    return settlePermissionRequest(toolCallId, grant);
  }

  return { sendMessage, abort, setWorkspacePath, resolvePermissionGrant };
}

// ── OpenAI agent loop ──

async function agentLoopOpenAI({ baseUrl, apiKey, model, systemPrompt, messages, webContents, streamId, signal, effort, contextWindow, conversationId, persistCompaction, toolContext }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let apiMessages = sanitizeApiMessages([{ role: 'system', content: systemPrompt }, ...messages]);
  const usage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
  const providerConfig = { provider: 'openai', baseUrl, apiKey, model };
  let unsupportedToolClaimRetries = 0;

  for (let turn = 0; turn < 20; turn++) {
    const microcompactResult = microcompactMessagesForContext(apiMessages);
    if (microcompactResult.stats.compactedCount > 0) {
      apiMessages = microcompactResult.messages;
      console.log(
        `[llm-chat] Microcompacted ${microcompactResult.stats.compactedCount} historical messages (${microcompactResult.stats.savedChars} chars saved)`,
      );
    }

    // Layer 1: 每轮检查是否需要压缩
    if (contextWindow) {
      const showCompactionStart = shouldShowCompactionStart(apiMessages, contextWindow);
      if (showCompactionStart) {
        webContents.send('chat:compaction', { streamId, stage: 'start' });
      }
      const compactResult = await compactIfNeeded({
        messages: apiMessages,
        systemPrompt,
        contextWindow,
        providerConfig,
        signal,
      });
      if (compactResult.compacted) {
        apiMessages = compactResult.messages;
        await persistAndNotifyCompaction({
          persistCompaction,
          conversationId,
          compactResult,
          streamId,
          webContents,
        });
      } else if (showCompactionStart) {
        webContents.send('chat:compaction', { streamId, stage: 'idle' });
      }
    }
    apiMessages = normalizeOpenAIMessages(sanitizeApiMessages(apiMessages));
    const body = { model, messages: apiMessages, stream: true, stream_options: { include_usage: true }, tools: TOOLS_OPENAI };
    if (effort && effort !== 'default') body.reasoning_effort = OPENAI_REASONING_EFFORT[effort] ?? 'medium';

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (isPromptTooLongResponse(res.status, text)) {
        webContents.send('chat:compaction', { streamId, stage: 'start', emergency: true });
        const compactResult = await compactIfNeeded({
          messages: apiMessages,
          systemPrompt,
          contextWindow,
          providerConfig: null,
          signal,
          force: true,
        });
        if (compactResult.compacted) {
          apiMessages = compactResult.messages;
          await persistAndNotifyCompaction({
            persistCompaction,
            conversationId,
            compactResult,
            streamId,
            webContents,
            emergency: true,
          });
          continue;
        }
        webContents.send('chat:compaction', { streamId, stage: 'idle', emergency: true });
      }
      webContents.send('chat:stream:error', { streamId, error: `HTTP ${res.status}: ${text.slice(0, 300)}` });
      return;
    }

    const { content, toolCalls, streamUsage } = await consumeOpenAIStream(res, webContents, streamId);
    if (streamUsage) {
      usage.inputTokens += streamUsage.inputTokens || 0;
      usage.outputTokens += streamUsage.outputTokens || 0;
      usage.cacheWriteTokens += streamUsage.cacheWriteTokens || 0;
      usage.cacheReadTokens += streamUsage.cacheReadTokens || 0;
    }

    const effectiveContent = content;
    const effectiveToolCalls = toolCalls;

    if (!effectiveToolCalls.length) {
      if (!String(effectiveContent || '').trim()) {
        webContents.send('chat:stream:error', { streamId, error: emptyModelResponseError() });
        return;
      }
      if (shouldRetryNoToolResponse(effectiveContent)) {
        if (unsupportedToolClaimRetries < 1) {
          unsupportedToolClaimRetries += 1;
          apiMessages.push({ role: 'user', content: unsupportedToolResponseCorrection() });
          continue;
        }
        webContents.send('chat:stream:error', { streamId, error: unsupportedToolResponseFallback() });
        return;
      }
      webContents.send('chat:stream:done', { streamId, usage });
      return;
    }

    apiMessages.push({ role: 'assistant', content: effectiveContent || null, tool_calls: effectiveToolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })) });

    for (const tc of effectiveToolCalls) {
      const args = safeParseJson(tc.arguments);
      webContents.send('chat:stream:tool-call', { streamId, tool: tc.name, args, toolCallId: tc.id });
      const result = await executeTool(tc.name, args, activeWorkspacePath, toolContext, {
        requestPermission: createChatPermissionRequester({ webContents, streamId, toolCallId: tc.id }),
      });
      if (signal.aborted) return;
      const output = result.output || (result.success ? '' : `Error: ${result.error}${result.stderr ? '\n' + result.stderr : ''}`);
      webContents.send('chat:stream:tool-result', { streamId, toolCallId: tc.id, result: output.slice(0, 4000) });
      apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: output });
    }
  }

  webContents.send('chat:stream:done', { streamId, usage });
}

let activeWorkspacePath = null;

function consumeOpenAIStreamLine(line, state, webContents, streamId) {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('data: ')) return;
  const payload = trimmed.slice(6);
  if (payload === '[DONE]') return;
  try {
    const parsed = JSON.parse(payload);
    const delta = parsed.choices?.[0]?.delta;
    if (delta?.content) {
      state.content += delta.content;
      webContents.send('chat:stream:delta', { streamId, content: delta.content });
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (!state.toolCalls[tc.index]) state.toolCalls[tc.index] = { id: '', name: '', arguments: '' };
        if (tc.id) state.toolCalls[tc.index].id = tc.id;
        if (tc.function?.name) state.toolCalls[tc.index].name = tc.function.name;
        if (tc.function?.arguments) state.toolCalls[tc.index].arguments += tc.function.arguments;
      }
    }
    if (parsed.usage) {
      const u = parsed.usage;
      const cachedTokens = u.prompt_tokens_details?.cached_tokens ?? 0;
      state.usage = {
        inputTokens: u.prompt_tokens ?? 0,
        outputTokens: u.completion_tokens ?? 0,
        cacheReadTokens: cachedTokens,
        cacheWriteTokens: 0,
      };
      webContents.send('chat:stream:usage', { streamId, usage: state.usage });
    }
  } catch {
    /* skip malformed stream frame */
  }
}

async function consumeOpenAIStream(res, webContents, streamId) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const state = { content: '', toolCalls: [], usage: null };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      consumeOpenAIStreamLine(line, state, webContents, streamId);
    }
  }
  if (buffer.trim()) consumeOpenAIStreamLine(buffer, state, webContents, streamId);

  return { content: state.content, toolCalls: state.toolCalls.filter(Boolean), streamUsage: state.usage };
}

// ── Anthropic agent loop ──

async function agentLoopAnthropic({ baseUrl, apiKey, model, systemPrompt, messages, webContents, streamId, signal, effort, contextWindow, conversationId, persistCompaction, toolContext }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
  let effectiveSystem = systemPrompt;
  let apiMessages = sanitizeApiMessages(messages);
  const usage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
  const providerConfig = { provider: 'anthropic', baseUrl, apiKey, model };
  let unsupportedToolClaimRetries = 0;

  for (let turn = 0; turn < 20; turn++) {
    const microcompactResult = microcompactMessagesForContext(apiMessages);
    if (microcompactResult.stats.compactedCount > 0) {
      apiMessages = microcompactResult.messages;
      console.log(
        `[llm-chat] Microcompacted ${microcompactResult.stats.compactedCount} historical messages (${microcompactResult.stats.savedChars} chars saved)`,
      );
    }

    // Layer 1: 每轮检查是否需要压缩
    if (contextWindow) {
      const compactableMessages = [{ role: 'system', content: effectiveSystem }, ...apiMessages];
      const showCompactionStart = shouldShowCompactionStart(compactableMessages, contextWindow);
      if (showCompactionStart) {
        webContents.send('chat:compaction', { streamId, stage: 'start' });
      }
      const compactResult = await compactIfNeeded({
        messages: compactableMessages,
        systemPrompt: effectiveSystem,
        contextWindow,
        providerConfig,
        signal,
      });
      if (compactResult.compacted) {
        // Re-separate system from conversation messages for Anthropic
        effectiveSystem = compactResult.messages
          .filter((m) => m.role === 'system')
          .map((m) => m.content)
          .join('\n\n');
        apiMessages = compactResult.messages.filter((m) => m.role !== 'system');
        await persistAndNotifyCompaction({
          persistCompaction,
          conversationId,
          compactResult,
          streamId,
          webContents,
        });
      } else if (showCompactionStart) {
        webContents.send('chat:compaction', { streamId, stage: 'idle' });
      }
    }
    apiMessages = normalizeAnthropicMessages(sanitizeApiMessages(apiMessages));
    const body = { model, system: effectiveSystem, messages: apiMessages, max_tokens: 16384, stream: true, tools: TOOLS_ANTHROPIC };
    if (effort === 'high') {
      body.thinking = { type: 'enabled', budget_tokens: ANTHROPIC_THINKING_BUDGET.high };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (isPromptTooLongResponse(res.status, text)) {
        webContents.send('chat:compaction', { streamId, stage: 'start', emergency: true });
        const compactResult = await compactIfNeeded({
          messages: [{ role: 'system', content: effectiveSystem }, ...apiMessages],
          systemPrompt: effectiveSystem,
          contextWindow,
          providerConfig: null,
          signal,
          force: true,
        });
        if (compactResult.compacted) {
          effectiveSystem = compactResult.messages
            .filter((m) => m.role === 'system')
            .map((m) => m.content)
            .join('\n\n');
          apiMessages = compactResult.messages.filter((m) => m.role !== 'system');
          await persistAndNotifyCompaction({
            persistCompaction,
            conversationId,
            compactResult,
            streamId,
            webContents,
            emergency: true,
          });
          continue;
        }
        webContents.send('chat:compaction', { streamId, stage: 'idle', emergency: true });
      }
      webContents.send('chat:stream:error', { streamId, error: `HTTP ${res.status}: ${text.slice(0, 300)}` });
      return;
    }

    const { textContent, toolUseBlocks, stopReason, streamUsage } = await consumeAnthropicStream(res, webContents, streamId);
    if (streamUsage) {
      usage.inputTokens += streamUsage.inputTokens || 0;
      usage.outputTokens += streamUsage.outputTokens || 0;
      usage.cacheWriteTokens += streamUsage.cacheWriteTokens || 0;
      usage.cacheReadTokens += streamUsage.cacheReadTokens || 0;
    }

    const effectiveTextContent = textContent;
    const effectiveToolUseBlocks = stopReason === 'tool_use' ? toolUseBlocks : [];

    if (!effectiveToolUseBlocks.length) {
      if (!String(effectiveTextContent || '').trim()) {
        webContents.send('chat:stream:error', { streamId, error: emptyModelResponseError() });
        return;
      }
      if (shouldRetryNoToolResponse(effectiveTextContent)) {
        if (unsupportedToolClaimRetries < 1) {
          unsupportedToolClaimRetries += 1;
          apiMessages.push({ role: 'user', content: unsupportedToolResponseCorrection() });
          continue;
        }
        webContents.send('chat:stream:error', { streamId, error: unsupportedToolResponseFallback() });
        return;
      }
      webContents.send('chat:stream:done', { streamId, usage });
      return;
    }

    const assistantContent = [];
    if (effectiveTextContent) assistantContent.push({ type: 'text', text: effectiveTextContent });
    for (const tu of effectiveToolUseBlocks) {
      assistantContent.push({ type: 'tool_use', id: tu.id, name: tu.name, input: safeParseJson(tu.inputJson) });
    }
    apiMessages.push({ role: 'assistant', content: assistantContent });

    const toolResults = [];
    for (const tu of effectiveToolUseBlocks) {
      const args = safeParseJson(tu.inputJson);
      webContents.send('chat:stream:tool-call', { streamId, tool: tu.name, args, toolCallId: tu.id });
      const result = await executeTool(tu.name, args, activeWorkspacePath, toolContext, {
        requestPermission: createChatPermissionRequester({ webContents, streamId, toolCallId: tu.id }),
      });
      if (signal.aborted) return;
      const output = result.output || (result.success ? '' : `Error: ${result.error}${result.stderr ? '\n' + result.stderr : ''}`);
      webContents.send('chat:stream:tool-result', { streamId, toolCallId: tu.id, result: output.slice(0, 4000) });
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: output });
    }
    apiMessages.push({ role: 'user', content: toolResults });
  }

  webContents.send('chat:stream:done', { streamId, usage });
}

function consumeAnthropicStreamLine(line, state, webContents, streamId) {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('data: ')) return;
  try {
    const parsed = JSON.parse(trimmed.slice(6));
    if (parsed.type === 'content_block_start') {
      if (parsed.content_block?.type === 'tool_use') {
        state.currentToolIndex = state.toolUseBlocks.length;
        state.toolUseBlocks.push({ id: parsed.content_block.id, name: parsed.content_block.name, inputJson: '' });
      } else {
        state.currentToolIndex = -1;
      }
    } else if (parsed.type === 'content_block_delta') {
      if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
        state.textContent += parsed.delta.text;
        webContents.send('chat:stream:delta', { streamId, content: parsed.delta.text });
      } else if (parsed.delta?.type === 'input_json_delta' && state.currentToolIndex >= 0) {
        state.toolUseBlocks[state.currentToolIndex].inputJson += parsed.delta.partial_json;
      }
    } else if (parsed.type === 'message_delta') {
      if (parsed.delta?.stop_reason) state.stopReason = parsed.delta.stop_reason;
      if (parsed.usage) {
        state.usage = { ...(state.usage || {}), outputTokens: parsed.usage.output_tokens ?? 0 };
        webContents.send('chat:stream:usage', { streamId, usage: state.usage });
      }
    } else if (parsed.type === 'message_start' && parsed.message?.usage) {
      const u = parsed.message.usage;
      state.usage = {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
      };
      webContents.send('chat:stream:usage', { streamId, usage: state.usage });
    }
  } catch {
    /* skip malformed stream frame */
  }
}

async function consumeAnthropicStream(res, webContents, streamId) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const state = {
    textContent: '',
    toolUseBlocks: [],
    currentToolIndex: -1,
    stopReason: null,
    usage: null,
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      consumeAnthropicStreamLine(line, state, webContents, streamId);
    }
  }
  if (buffer.trim()) consumeAnthropicStreamLine(buffer, state, webContents, streamId);

  return {
    textContent: state.textContent,
    toolUseBlocks: state.toolUseBlocks,
    stopReason: state.stopReason,
    streamUsage: state.usage,
  };
}

function safeParseJson(str) {
  try { return JSON.parse(str); } catch { return {}; }
}
