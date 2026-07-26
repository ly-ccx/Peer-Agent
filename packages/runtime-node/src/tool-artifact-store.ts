// 通用工具结果材料化(17 号文档 §3.1 / 23 号治理文档阶段 E)。
//
// shell / file / batch_search 等本地能力已有结构化 local_*_ref 落盘体系;
// 本模块是「其余大输出」(MCP 工具、无结构 capability 输出等)的兜底材料化:
// 超阈值输出落盘 artifact,provider 消息里只保留 `local_tool_result_ref` 骨架
// (预览 + 关键发现 + 检索命令),共享 microcompact 天然认识该 kind,不会二次哑截断。
//
// 原则:It moves evidence out of prompt and keeps the route back.

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 与共享 microcompact triggerChars 同阈值:小结果 inline,大结果材料化。 */
export const TOOL_RESULT_MATERIALIZE_CONFIG = Object.freeze({
  inlineMaxChars: 6_000,
  previewHeadChars: 700,
  previewTailChars: 500,
  /** 错误结果保留双倍预览(17 号文档:错误结果多留上下文)。 */
  errorPreviewMultiplier: 2,
  maxKeyFindings: 5,
  /** 单会话 artifact 目录体积上限;超出按 mtime LRU 逐出最旧文件。 */
  maxConversationBytes: 256 * 1024 * 1024,
});

export interface ToolResultArtifact {
  readonly artifactPath: string;
  readonly byteCount: number;
  readonly lineCount: number;
}

export interface MaterializedToolResult {
  readonly content: string;
  readonly materialized: boolean;
  readonly artifactPath?: string;
}

function sanitizeSegment(value: string | null | undefined, fallback: string): string {
  const cleaned = String(value ?? '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return cleaned || fallback;
}

export function resolveToolArtifactDir(options: { baseDir?: string; conversationId?: string | null } = {}): string {
  const base = options.baseDir || join(homedir(), '.peer-agent', 'artifacts');
  return join(base, sanitizeSegment(options.conversationId, 'unscoped'));
}

/**
 * 体积治理(LRU):目录总体积超预算时按 mtime 从旧到新逐出,直到回到预算内。
 * 治理失败不阻断主链路(材料化本体仍成功);被逐出的 ref 悬空属已知取舍,
 * ref 模板已注明 artifact 缺失时才允许重新执行原命令。
 */
export function enforceConversationArtifactBudget(options: {
  readonly conversationId?: string | null;
  readonly baseDir?: string;
  readonly maxBytes?: number;
}): void {
  const dir = resolveToolArtifactDir(options);
  const maxBytes = options.maxBytes ?? TOOL_RESULT_MATERIALIZE_CONFIG.maxConversationBytes;
  let entries: Array<{ path: string; size: number; mtimeMs: number }>;
  try {
    entries = readdirSync(dir)
      .map((name) => {
        const path = join(dir, name);
        const stat = statSync(path);
        return stat.isFile() ? { path, size: stat.size, mtimeMs: stat.mtimeMs } : null;
      })
      .filter((entry): entry is { path: string; size: number; mtimeMs: number } => entry !== null);
  } catch {
    return;
  }
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= maxBytes) return;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of entries) {
    if (total <= maxBytes) break;
    try {
      rmSync(entry.path, { force: true });
      total -= entry.size;
    } catch {
      // 单文件逐出失败跳过,继续尝试更新的文件。
    }
  }
}

export function writeToolResultArtifact(options: {
  readonly conversationId?: string | null;
  readonly toolCallId?: string | null;
  readonly tool?: string | null;
  readonly content: string;
  readonly baseDir?: string;
  readonly maxConversationBytes?: number;
}): ToolResultArtifact {
  const dir = resolveToolArtifactDir(options);
  mkdirSync(dir, { recursive: true });
  const name = `${sanitizeSegment(options.tool, 'tool')}-${sanitizeSegment(options.toolCallId, String(Date.now()))}.txt`;
  const artifactPath = join(dir, name);
  writeFileSync(artifactPath, options.content, 'utf8');
  // 写后执行体积治理:刚写入的文件 mtime 最新,LRU 不会误逐出它。
  try {
    enforceConversationArtifactBudget({
      conversationId: options.conversationId,
      baseDir: options.baseDir,
      maxBytes: options.maxConversationBytes,
    });
  } catch {
    // 体积治理失败不阻断材料化。
  }
  return {
    artifactPath,
    byteCount: Buffer.byteLength(options.content, 'utf8'),
    lineCount: options.content.split('\n').length,
  };
}

/** 会话删除级联清理(对齐 ADR 34):删掉该会话的兜底 artifact 目录。 */
export function removeConversationToolArtifacts(options: {
  readonly conversationId: string;
  readonly baseDir?: string;
}): void {
  const dir = resolveToolArtifactDir(options);
  rmSync(dir, { recursive: true, force: true });
}

function extractKeyFindings(text: string, limit: number): string[] {
  const findings: string[] = [];
  const pattern = /^.*(?:error|fail(?:ed|ure)?|exception|panic|fatal|refused|denied|timeout)[^\n]*$/gim;
  for (const match of text.matchAll(pattern)) {
    const line = match[0].trim().slice(0, 200);
    if (line && !findings.includes(line)) findings.push(line);
    if (findings.length >= limit) break;
  }
  return findings;
}

/**
 * 超阈值工具输出 → 落盘 + `local_tool_result_ref` 骨架;
 * 小输出原样返回;写盘失败原样返回(降级交给共享 microcompact 兜底,绝不静默丢证据)。
 */
export function materializeToolResultContent(options: {
  readonly conversationId?: string | null;
  readonly toolCallId?: string | null;
  readonly tool?: string | null;
  readonly content: string;
  readonly isError?: boolean;
  readonly baseDir?: string;
  readonly inlineMaxChars?: number;
}): MaterializedToolResult {
  const content = String(options.content ?? '');
  const inlineMax = options.inlineMaxChars ?? TOOL_RESULT_MATERIALIZE_CONFIG.inlineMaxChars;
  if (content.length <= inlineMax) {
    return { content, materialized: false };
  }
  // 已是结构化 ref(shell/file/capability 自带落盘)则不重复材料化。
  const trimmed = content.trim();
  if (trimmed.startsWith('{') && /"kind"\s*:\s*"local_(?:tool_result|file|capability_result)_ref"/.test(trimmed.slice(0, 400))) {
    return { content, materialized: false };
  }

  let artifact: ToolResultArtifact;
  try {
    artifact = writeToolResultArtifact(options);
  } catch {
    return { content, materialized: false };
  }

  const multiplier = options.isError ? TOOL_RESULT_MATERIALIZE_CONFIG.errorPreviewMultiplier : 1;
  const headChars = TOOL_RESULT_MATERIALIZE_CONFIG.previewHeadChars * multiplier;
  const tailChars = TOOL_RESULT_MATERIALIZE_CONFIG.previewTailChars * multiplier;
  const ref = {
    kind: 'local_tool_result_ref',
    tool: options.tool ?? undefined,
    status: options.isError ? 'error' : 'ok',
    artifactRef: artifact.artifactPath,
    originalChars: content.length,
    originalLines: artifact.lineCount,
    stdoutPreview: `${content.slice(0, headChars)}\n...[full output preserved at artifact; middle omitted]...\n${content.slice(-tailChars)}`,
    ...(extractKeyFindings(content, TOOL_RESULT_MATERIALIZE_CONFIG.maxKeyFindings).length > 0
      ? { keyFindings: extractKeyFindings(content, TOOL_RESULT_MATERIALIZE_CONFIG.maxKeyFindings) }
      : {}),
    suggestedRetrieval: [
      `rg -n "error|fail|Error" "${artifact.artifactPath}"`,
      `sed -n '1,120p' "${artifact.artifactPath}"`,
      `tail -n 120 "${artifact.artifactPath}"`,
    ],
    note: 'Full tool output preserved on disk. Read the artifact (rg/sed/tail or read_file) when you need the omitted middle. Do NOT re-run the original command to recover it.',
  };
  return {
    content: JSON.stringify(ref, null, 2),
    materialized: true,
    artifactPath: artifact.artifactPath,
  };
}
