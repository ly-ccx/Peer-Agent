import type { I18nRuntime } from '@peer-agent/i18n';
import type {
  ClientToolCall,
  ConfigInstructionContextItem,
  ContextAttachmentItem,
  ContinuityContextItem,
  LlmProviderConfigView,
  LocalAccessLevel,
} from '@peer-agent/protocol';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Dropdown, type DropdownOption } from '../../app/components/Dropdown';
import { clientApi } from '../../clientApi';
import { formatHistoricalLocalRecordForApi, sanitizeAssistantHistoryTextForApi } from '../state/historicalLocalRecord';
import { MarkdownMessage } from './markdown/MarkdownMessage';
import { PermissionGateStrip } from './thread/PermissionGateStrip';
import { MessageActionBar, type MessageActionId } from './thread/MessageActionBar';
import { MessageRail, type MessageRailItem } from './thread/MessageRail';
import { useTypewriterStream } from '../hooks/useTypewriterStream';

const MAX_ATTACHMENTS = 8;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 512 * 1024;
const SCROLL_BOTTOM_THRESHOLD_PX = 64;

interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'text' | 'unsupported';
  dataUrl?: string;
  text?: string;
}

type EffortLevel = 'off' | 'low' | 'default' | 'high' | 'xhigh';

const BASE_EFFORT_LEVELS: readonly EffortLevel[] = ['off', 'low', 'default', 'high'];
const OPENAI_EFFORT_LEVELS: readonly EffortLevel[] = ['off', 'low', 'default', 'high', 'xhigh'];
const ACCESS_LEVELS: readonly LocalAccessLevel[] = ['ask_before_local', 'session_local', 'full_local'];

function isEffortLevel(value: unknown): value is EffortLevel {
  return value === 'off' || value === 'low' || value === 'default' || value === 'high' || value === 'xhigh';
}

function isLocalAccessLevel(value: unknown): value is LocalAccessLevel {
  return value === 'ask_before_local'
    || value === 'session_local'
    || value === 'restricted_local'
    || value === 'full_local';
}

function accessLevelLabel(level: LocalAccessLevel, isZh: boolean): string {
  if (level === 'full_local') return isZh ? '完全访问' : 'Full access';
  if (level === 'session_local') return isZh ? '帮我批准' : 'Approve for me';
  if (level === 'restricted_local') return isZh ? '受限' : 'Restricted';
  return isZh ? '每次询问' : 'Ask';
}

function accessLevelTitle(level: LocalAccessLevel, isZh: boolean): string {
  if (level === 'full_local') {
    return isZh ? '自动批准所有本地工具调用；请只在信任当前任务时使用' : 'Auto-approve all local tool calls; use only when you trust the current task';
  }
  if (level === 'session_local') {
    return isZh ? '自动批准低/中风险命令；高风险动作仍会询问' : 'Auto-approve low/medium-risk commands; high-risk actions still ask';
  }
  if (level === 'restricted_local') {
    return isZh ? '使用受限本地访问' : 'Use restricted local access';
  }
  return isZh ? '所有本地动作都先询问' : 'Ask before local actions';
}

function effortLabel(level: EffortLevel, isZh: boolean): string {
  if (level === 'off') return isZh ? '关闭思考' : 'Reasoning off';
  if (level === 'low') return isZh ? '简洁思考' : 'Low reasoning';
  if (level === 'high') return isZh ? '深度思考' : 'High reasoning';
  if (level === 'xhigh') return isZh ? '超深度思考' : 'Extra-high reasoning';
  return isZh ? '标准思考' : 'Default reasoning';
}

type ChatApiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type ChatApiMessage = { role: string; content: string | ChatApiContentPart[] };

type ContentSegment =
  | { type: 'text'; content?: string }
  | { type: 'thinking'; content?: string }
  | {
      type: 'tool-call';
      tool?: string;
      args?: Record<string, unknown>;
      result?: string;
      synthetic?: boolean;
    };

interface ToolCallLegacy {
  tool: string;
  args: Record<string, unknown>;
  result?: string;
  synthetic?: boolean;
}

interface CompactionMeta {
  method: string;
  originalMessageCount: number;
  deltaMessageCount?: number;
  previousMessageCount?: number;
  beforeTokens: number;
  afterTokens: number;
  summary?: string;
}

interface ChatMsg {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  segments?: ContentSegment[];
  timestamp?: number;
  usage?: { input: number; output: number; cacheWrite?: number; cacheRead?: number };
  compaction?: CompactionMeta;
  attachments?: ChatAttachment[];
}

function isEmptyAssistantPlaceholder(message: Pick<ChatMsg, 'role' | 'content' | 'segments'>): boolean {
  return (
    message.role === 'assistant' &&
    message.content.trim() === '' &&
    (!Array.isArray(message.segments) || message.segments.length === 0)
  );
}

function getApiContent(message: ChatMsg): string {
  if (!message.segments?.length) {
    return message.role === 'assistant'
      ? sanitizeAssistantHistoryTextForApi(message.content)
      : message.content;
  }
  return message.segments
    .map((segment) => {
      if (segment.type === 'thinking') return '';
      if (segment.type !== 'text') return formatHistoricalLocalRecordForApi(segment);
      const content = segment.content || '';
      return message.role === 'assistant' ? sanitizeAssistantHistoryTextForApi(content) : content;
    })
    .filter(Boolean)
    .join('\n\n');
}

function buildAttachmentText(attachments: readonly ChatAttachment[]): string {
  const blocks: string[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === 'text') {
      blocks.push([
        `Attached file: ${attachment.name}`,
        `MIME: ${attachment.mimeType || 'text/plain'}`,
        `Size: ${formatBytes(attachment.size)}`,
        'Content:',
        '```',
        attachment.text || '',
        '```',
      ].join('\n'));
    } else if (attachment.kind === 'unsupported') {
      blocks.push([
        `Attached file: ${attachment.name}`,
        `MIME: ${attachment.mimeType || 'application/octet-stream'}`,
        `Size: ${formatBytes(attachment.size)}`,
        'Content is not included because this file type is not supported yet.',
      ].join('\n'));
    }
  }
  return blocks.join('\n\n');
}

function buildAttachmentContext(attachments: readonly ChatAttachment[]): ContextAttachmentItem[] {
  return attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    kind: attachment.kind,
    contentIncluded: attachment.kind !== 'unsupported',
    transport: attachment.kind === 'image'
      ? 'provider_image_part'
      : attachment.kind === 'text'
        ? 'user_text_part'
        : 'metadata_only',
    sourceKind: 'user_upload',
    scope: 'conversation',
    lifecycle: 'ephemeral',
  }));
}

function buildConversationAttachmentContext(messages: readonly ChatMsg[]): ContextAttachmentItem[] {
  return messages.flatMap((message) => (
    message.role === 'user' && message.attachments?.length
      ? buildAttachmentContext(message.attachments)
      : []
  ));
}

function getApiMessageContent(message: ChatMsg): string | ChatApiContentPart[] {
  const text = getApiContent(message);
  const attachments = message.attachments ?? [];
  if (!attachments.length) return text;

  const parts: ChatApiContentPart[] = [];
  const attachmentText = buildAttachmentText(attachments);
  const combinedText = [text, attachmentText].filter((value) => value.trim()).join('\n\n');
  if (combinedText) parts.push({ type: 'text', text: combinedText });

  for (const attachment of attachments) {
    if (attachment.kind === 'image' && attachment.dataUrl) {
      parts.push({ type: 'image_url', image_url: { url: attachment.dataUrl } });
    }
  }

  return parts.length ? parts : text;
}

function hasApiMessageContent(content: string | ChatApiContentPart[]): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  return content.some((part) => {
    if (part.type === 'image_url') return Boolean(part.image_url.url);
    return part.text.trim().length > 0;
  });
}

function toApiMessages(messages: readonly ChatMsg[]): ChatApiMessage[] {
  const apiMessages: ChatApiMessage[] = [];
  for (const message of messages) {
    if (message.compaction) continue;
    const content = getApiMessageContent(message);
    if (message.role === 'assistant' && !hasApiMessageContent(content)) continue;
    apiMessages.push({ role: message.role, content });
  }
  return apiMessages;
}

function buildConversationContinuityContext(messages: readonly ChatMsg[]): ContinuityContextItem[] {
  return messages
    .filter((message) => Boolean(message.compaction))
    .map((message) => ({
      id: message.id,
      method: message.compaction?.method ?? 'unknown',
      originalMessageCount: message.compaction?.originalMessageCount ?? 0,
      beforeTokens: message.compaction?.beforeTokens ?? 0,
      afterTokens: message.compaction?.afterTokens ?? 0,
      summary: message.compaction?.summary || message.content,
      content: message.content,
    }));
}

function buildConfigInstructionContext(systemInstructions: string | null | undefined): ConfigInstructionContextItem[] {
  const content = typeof systemInstructions === 'string' ? systemInstructions.trim() : '';
  if (!content) return [];
  return [{
    id: 'settings.systemInstructions',
    title: 'System Instructions',
    content,
    priority: 0,
    source: 'settings.systemInstructions',
  }];
}

interface TokenUsageState {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
}

interface SlashCommand {
  id: string;
  value: string;
  labelZh: string;
  labelEn: string;
  descriptionZh: string;
  descriptionEn: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'compact',
    value: '/compact',
    labelZh: '/compact',
    labelEn: '/compact',
    descriptionZh: '压缩当前对话历史',
    descriptionEn: 'Compact conversation history',
  },
];

let msgSeq = 0;
function nextId() { return `msg-${++msgSeq}-${Date.now()}`; }

function formatTime(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isTextLikeFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true;
  const lower = file.name.toLowerCase();
  return [
    '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml',
    '.xml', '.html', '.css', '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.go',
    '.rs', '.c', '.cpp', '.h', '.hpp', '.sh', '.zsh', '.sql', '.log',
  ].some((suffix) => lower.endsWith(suffix));
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('failed to read file'));
    reader.readAsDataURL(file);
  });
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('failed to read file'));
    reader.readAsText(file);
  });
}

interface TextGroup { type: 'text'; content: string }
interface ThinkingGroup { type: 'thinking'; content: string }
interface ToolCallGroup { type: 'tool-call-group'; calls: ToolCallLegacy[] }
type SegmentGroup = TextGroup | ThinkingGroup | ToolCallGroup;

function groupSegments(segments: ContentSegment[]): SegmentGroup[] {
  const groups: SegmentGroup[] = [];
  for (const seg of segments) {
    if (seg.type === 'text') {
      groups.push({ type: 'text', content: seg.content || '' });
    } else if (seg.type === 'thinking') {
      const last = groups[groups.length - 1];
      if (last && last.type === 'thinking') {
        last.content += seg.content || '';
      } else {
        groups.push({ type: 'thinking', content: seg.content || '' });
      }
    } else {
      const last = groups[groups.length - 1];
      if (last && last.type === 'tool-call-group') {
        last.calls.push({ tool: seg.tool!, args: seg.args || {}, result: seg.result, synthetic: seg.synthetic });
      } else {
        groups.push({ type: 'tool-call-group', calls: [{ tool: seg.tool!, args: seg.args || {}, result: seg.result, synthetic: seg.synthetic }] });
      }
    }
  }
  return groups;
}

function getTextContent(segments: ContentSegment[]): string {
  return segments.filter((s) => s.type === 'text').map((s) => s.content || '').join('');
}

function migrateToSegments(content: string, toolCalls?: ToolCallLegacy[]): ContentSegment[] | undefined {
  if (!toolCalls?.length && !content) return undefined;
  const segs: ContentSegment[] = [];
  if (toolCalls?.length) {
    for (const tc of toolCalls) {
      segs.push({ type: 'tool-call', tool: tc.tool, args: tc.args, result: tc.result });
    }
  }
  if (content) segs.push({ type: 'text', content });
  return segs.length ? segs : undefined;
}

function findNextSerializedToolCall(content: string, fromIndex: number): number {
  const match = content.slice(fromIndex).match(/\n\[Tool call:/);
  return match?.index === undefined ? content.length : fromIndex + match.index + 1;
}

function parseSerializedToolSegments(content: string): ContentSegment[] | undefined {
  if (!content.includes('[Tool call:')) return undefined;

  const segments: ContentSegment[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const start = content.indexOf('[Tool call:', cursor);
    if (start < 0) {
      const tail = content.slice(cursor);
      if (tail) segments.push({ type: 'text', content: tail });
      break;
    }

    const before = content.slice(cursor, start);
    if (before) segments.push({ type: 'text', content: before });

    const headerEnd = content.indexOf('\n', start);
    if (headerEnd < 0) {
      segments.push({ type: 'text', content: content.slice(start) });
      break;
    }

    const header = content.slice(start, headerEnd).trim();
    const headerMatch = header.match(/^\[Tool call:\s+(\S+)\s+(.+)\]$/);
    const resultMarker = '\n[Tool result]\n';
    const resultMarkerIndex = content.indexOf(resultMarker, headerEnd);
    if (!headerMatch) {
      segments.push({ type: 'text', content: content.slice(start) });
      break;
    }

    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(headerMatch[2]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
    } catch {
      args = { raw: headerMatch[2] };
    }

    if (resultMarkerIndex < 0) {
      segments.push({
        type: 'tool-call',
        tool: headerMatch[1],
        args,
        result: undefined,
        synthetic: true,
      });
      const rest = content.slice(headerEnd).trim();
      if (rest) segments.push({ type: 'text', content: rest });
      break;
    }

    const resultStart = resultMarkerIndex + resultMarker.length;
    const nextStart = findNextSerializedToolCall(content, resultStart);
    segments.push({
      type: 'tool-call',
      tool: headerMatch[1],
      args,
      result: content.slice(resultStart, nextStart).trim(),
    });
    cursor = nextStart;
  }

  return segments.some((segment) => segment.type === 'tool-call') ? segments : undefined;
}

function estimateTextTokens(value: unknown): number {
  return Math.ceil(String(value ?? '').length / 4);
}

function estimateMessageTokens(message: ChatMsg): number {
  let tokens = 10;
  tokens += estimateTextTokens(message.content);
  if (message.attachments?.length) {
    for (const attachment of message.attachments) {
      tokens += estimateTextTokens(attachment.name);
      tokens += estimateTextTokens(attachment.text);
      if (attachment.kind === 'image') tokens += 800;
    }
  }
  if (message.segments?.length) {
    for (const segment of message.segments) {
      if (segment.type === 'tool-call') {
        tokens += estimateTextTokens(segment.tool);
        tokens += estimateTextTokens(JSON.stringify(segment.args ?? {}));
        tokens += estimateTextTokens(segment.result);
      } else if (segment.type === 'text') {
        tokens += estimateTextTokens(segment.content);
      }
    }
  }
  return tokens;
}

function estimateAttachmentTokens(attachments: readonly ChatAttachment[]): number {
  return attachments.reduce((sum, attachment) => {
    return sum + estimateTextTokens(attachment.name) + estimateTextTokens(attachment.text) + (attachment.kind === 'image' ? 800 : 0);
  }, 0);
}

function estimateConversationTokens(messages: readonly ChatMsg[], draft: string, draftAttachments: readonly ChatAttachment[]): number {
  const messageTokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  return Math.max(0, messageTokens + estimateTextTokens(draft) + estimateAttachmentTokens(draftAttachments));
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(1)}k`;
}

// 流式工具参数进度的展示文案。仅描述“正在接收/准备调用”这一过程,
// 不声称工具已执行或文件已落地——真正的结果由后续 tool-call 段与本地能力 Evidence 接管。
type ToolProgress = { tool: string; path: string | null; receivedLines: number };

function toolProgressLabel(
  progress: ToolProgress,
  isZh: boolean,
): string {
  const file = progress.path ? progress.path.split('/').pop() || progress.path : null;
  const verbZh =
    progress.tool === 'edit_file' ? '编辑'
      : progress.tool === 'write_file' ? '写入'
        : progress.tool === 'read_file' ? '读取'
          : '准备';
  const verbEn =
    progress.tool === 'edit_file' ? 'Editing'
      : progress.tool === 'write_file' ? 'Writing'
        : progress.tool === 'read_file' ? 'Reading'
          : 'Preparing';
  const lines = progress.receivedLines;
  if (isZh) {
    const target = file ? ` ${file}` : ` ${progress.tool}`;
    return lines > 0 ? `正在${verbZh}${target} · 已接收 ${lines} 行` : `正在${verbZh}${target}…`;
  }
  const target = file ? ` ${file}` : ` ${progress.tool}`;
  return lines > 0 ? `${verbEn}${target} · ${lines} lines received` : `${verbEn}${target}…`;
}

function usageFromLifetime(lifetime: {
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}): { input: number; output: number; cacheWrite: number; cacheRead: number } {
  return {
    input: lifetime.inputTokens ?? 0,
    output: lifetime.outputTokens ?? 0,
    cacheWrite: lifetime.cacheWriteTokens ?? 0,
    cacheRead: lifetime.cacheReadTokens ?? 0,
  };
}

async function loadConversationMessages(conversationId: string): Promise<{
  messages: ChatMsg[];
  tokenUsage: { input: number; output: number; cacheWrite: number; cacheRead: number } | null;
}> {
  const conv = await clientApi.conversationsGet({ id: conversationId });
  if (!conv?.messages) return { messages: [], tokenUsage: null };
  let totalInput = 0, totalOutput = 0, totalCacheWrite = 0, totalCacheRead = 0;
  const loaded = conv.messages.map((m: Record<string, unknown>) => {
    const msg: ChatMsg = {
      id: (m.id as string) || nextId(),
      role: (m.role as ChatMsg['role']) || 'user',
      content: (m.content as string) || '',
      timestamp: m.timestamp as number | undefined,
    };
    if (m.segments) {
      msg.segments = m.segments as ContentSegment[];
    } else if (Array.isArray(m.toolCalls) && (m.toolCalls as unknown[]).length) {
      msg.segments = migrateToSegments(msg.content, m.toolCalls as ToolCallLegacy[]);
    } else if (msg.role === 'assistant') {
      msg.segments = parseSerializedToolSegments(msg.content);
    }
    if (m.usage && typeof m.usage === 'object') {
      const u = m.usage as { input?: number; output?: number; cacheWrite?: number; cacheRead?: number };
      msg.usage = { input: u.input ?? 0, output: u.output ?? 0, cacheWrite: u.cacheWrite ?? 0, cacheRead: u.cacheRead ?? 0 };
      totalInput += msg.usage.input;
      totalOutput += msg.usage.output;
      totalCacheWrite += msg.usage.cacheWrite ?? 0;
      totalCacheRead += msg.usage.cacheRead ?? 0;
    }
    if (m._compaction && typeof m._compaction === 'object') {
      const c = m._compaction as unknown as CompactionMeta;
      msg.compaction = c;
    }
    if (Array.isArray(m.attachments)) {
      msg.attachments = m.attachments as ChatAttachment[];
    }
    return msg;
  }).filter((message) => !isEmptyAssistantPlaceholder(message));
  // ADR 23: 计费优先读 index meta 的权威累计 lifetimeUsage(不受压缩影响)。
  // 仅当老会话尚无该字段时,才回退到遍历消息累加(此路径会被压缩低估,属兼容降级)。
  const lifetime = conv.lifetimeUsage as
    | { inputTokens?: number; outputTokens?: number; cacheWriteTokens?: number; cacheReadTokens?: number }
    | undefined;
  if (
    lifetime &&
    ((lifetime.inputTokens ?? 0) > 0 ||
      (lifetime.outputTokens ?? 0) > 0 ||
      (lifetime.cacheWriteTokens ?? 0) > 0 ||
      (lifetime.cacheReadTokens ?? 0) > 0)
  ) {
    return {
      messages: loaded,
      tokenUsage: usageFromLifetime(lifetime),
    };
  }
  return {
    messages: loaded,
    tokenUsage: totalInput > 0 || totalOutput > 0 || totalCacheWrite > 0 || totalCacheRead > 0
      ? { input: totalInput, output: totalOutput, cacheWrite: totalCacheWrite, cacheRead: totalCacheRead }
      : null,
  };
}

export function ChatSurface({
  i18n,
  providers,
  conversationId,
  systemInstructions,
  resumeTask,
  onResumeConsumed,
  onOpenSettings,
  onConversationUpdated,
  onStreamingChange,
  onBranch,
}: {
  readonly i18n: I18nRuntime;
  readonly providers: readonly LlmProviderConfigView[];
  readonly conversationId: string | null;
  readonly systemInstructions?: string;
  readonly resumeTask?: { sessionId: string; task: string; effort?: string } | null;
  readonly onResumeConsumed?: () => void;
  readonly onOpenSettings: () => void;
  readonly onConversationUpdated?: () => void;
  // 把当前会话的流式运行状态上报给上层(App),供左侧列表显示 Loading 图标。
  readonly onStreamingChange?: (conversationId: string | null, isStreaming: boolean) => void;
  readonly onBranch?: (newConversationId: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  // 把流式运行状态(含会话坐标)上报给上层,供左侧列表显示 Loading 图标。
  // 表达层只反映 isStreaming 真值,不引入新的执行真值。
  useEffect(() => {
    onStreamingChange?.(conversationId, isStreaming);
  }, [isStreaming, conversationId, onStreamingChange]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [effort, setEffort] = useState<EffortLevel>(() => {
    // 思考强度是全局偏好,持久化在 settings-store(扁平 key),启动时同步注入到 initialSettings。
    // 表达层只读取/回写这一个偏好字段,不引入新的执行真值。
    // 五档: off(关闭) / low / default / high / xhigh(Extra High, OpenAI).
    const stored = (clientApi.initialSettings as Record<string, unknown>)?.effort;
    return isEffortLevel(stored)
      ? stored
      : 'default';
  });
  // 切换思考强度时回写全局设置,使其跨会话/重启保持一致。
  const changeEffort = useCallback((level: EffortLevel) => {
    setEffort(level);
    void clientApi.updateSettings({ effort: level });
  }, []);
  const [localAccessLevel, setLocalAccessLevel] = useState<LocalAccessLevel>(() => {
    const stored = (clientApi.initialSettings as Record<string, unknown>)?.localAccessLevel;
    return isLocalAccessLevel(stored) ? stored : 'ask_before_local';
  });
  const changeLocalAccessLevel = useCallback((level: LocalAccessLevel) => {
    setLocalAccessLevel(level);
    void clientApi.updateSettings({ localAccessLevel: level }).then((nextSettings) => {
      const normalized = (nextSettings as Record<string, unknown>)?.localAccessLevel;
      if (isLocalAccessLevel(normalized)) setLocalAccessLevel(normalized);
    });
  }, []);
  const [tokenUsage, setTokenUsage] = useState<TokenUsageState | null>(null);
  const [activeUsage, setActiveUsage] = useState<TokenUsageState | null>(null);
  const [compactionNotice, setCompactionNotice] = useState<{ method: string; beforeTokens: number; afterTokens: number; oldMessageCount: number; keptMessageCount: number } | null>(null);
  const [providerRecoveryNotice, setProviderRecoveryNotice] = useState<{
    fromProvider?: string;
    toProvider?: string;
    reason?: string;
  } | null>(null);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<ChatAttachment | null>(null);
  const [pendingPermissionCalls, setPendingPermissionCalls] = useState<ClientToolCall[]>([]);
  const [isThreadAtBottom, setIsThreadAtBottom] = useState(true);
  // 流式工具参数进度(Codex 式实时体感):工具调用参数(如 edit_file 的整文件内容)
  // 在落地为正式 tool-call 段之前会先以增量形式抵达,这里保存最近一次进度用于展示。
  // 仅为过程提示,不替代 Tool Result / Evidence。
  const [toolProgress, setToolProgress] = useState<ToolProgress | null>(null);

  useEffect(() => {
    if (!imagePreview) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setImagePreview(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [imagePreview]);

  // 任务续传(ADR 21):防止同一 resumeTask 被自动发送多次的一次性闸门。
  const resumeFiredRef = useRef<string | null>(null);
  const streamIdRef = useRef<string | null>(null);

  // 把流式文本追加到最后一条 assistant 消息的尾部文本段。
  const appendStreamText = useCallback((chunk: string) => {
    if (!chunk) return;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== 'assistant') return prev;
      const segments = [...(last.segments || [])];
      const lastSeg = segments[segments.length - 1];
      if (lastSeg && lastSeg.type === 'text') {
        segments[segments.length - 1] = { ...lastSeg, content: (lastSeg.content || '') + chunk };
      } else {
        segments.push({ type: 'text', content: chunk });
      }
      return [...prev.slice(0, -1), { ...last, content: getTextContent(segments), segments }];
    });
  }, []);

  const appendStreamThinking = useCallback((chunk: string) => {
    if (!chunk) return;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== 'assistant') return prev;
      const segments = [...(last.segments || [])];
      let thinkingIndex = -1;
      for (let index = segments.length - 1; index >= 0; index -= 1) {
        if (segments[index]?.type === 'thinking') {
          thinkingIndex = index;
          break;
        }
      }
      const thinkingSeg = thinkingIndex >= 0 ? segments[thinkingIndex] : null;
      if (thinkingSeg?.type === 'thinking') {
        segments[thinkingIndex] = { type: 'thinking', content: (thinkingSeg.content || '') + chunk };
      } else {
        segments.push({ type: 'thinking', content: chunk });
      }
      return [...prev.slice(0, -1), { ...last, segments }];
    });
  }, []);

  // 平滑打字机：网络 delta 进 buffer，rAF 泵匀速吐字，告别"一坨一坨"的生硬感。
  // 正文和深度思考分别用独立 buffer，避免两类 delta 在显示层互相串流。
  const textTypewriter = useTypewriterStream(appendStreamText);
  const thinkingTypewriter = useTypewriterStream(appendStreamThinking);
  const threadRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const updateThreadBottomState = useCallback((container: HTMLDivElement | null) => {
    if (!container) return true;
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const atBottom = distanceToBottom <= SCROLL_BOTTOM_THRESHOLD_PX;
    shouldAutoScrollRef.current = atBottom;
    setIsThreadAtBottom(atBottom);
    return atBottom;
  }, []);

  const scrollThreadToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const container = threadRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior });
    shouldAutoScrollRef.current = true;
    setIsThreadAtBottom(true);
  }, []);

  const handleThreadScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    updateThreadBottomState(event.currentTarget);
  }, [updateThreadBottomState]);

  // 表达层导航:点击右侧消息轨时,把对应用户消息滚动到视口并短暂高亮。
  // 仅操作已渲染的 DOM 锚点(data-msg-id),不触碰会话真值。
  const scrollToMessage = useCallback((id: string) => {
    const container = threadRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(id)}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('chat-msg-flash');
    // 强制重排以便重复点击同一条时动画可再次触发。
    void target.offsetWidth;
    target.classList.add('chat-msg-flash');
    window.setTimeout(() => target.classList.remove('chat-msg-flash'), 1600);
  }, []);

  const hasProvider = providers.some((p) => p.apiKeyConfigured);
  // 当前激活 provider(默认且已配置 Key,否则取首个已配置)是否勾选了原生推理(reasoning/thinking)。
  // 只有勾选时才显示思考强度选择器；OpenAI 暴露额外 xhigh 档。
  const activeProvider = providers.find((p) => p.isDefault && p.apiKeyConfigured)
    || providers.find((p) => p.apiKeyConfigured)
    || null;
  const activeProviderSupportsReasoning = Boolean(activeProvider?.supportsReasoning);
  const effortLevels = activeProvider?.provider === 'openai' ? OPENAI_EFFORT_LEVELS : BASE_EFFORT_LEVELS;
  const isZh = i18n.locale === 'zh-CN';
  const slashQuery = draft.startsWith('/') && !/\s/.test(draft) ? draft.toLowerCase() : null;
  const slashCommands = slashQuery
    ? SLASH_COMMANDS.filter((command) => command.value.startsWith(slashQuery))
    : [];

  // 右侧消息轨条目:仅取用户消息(排除压缩摘要),文本截断用于 hover 预览。
  const railItems: MessageRailItem[] = messages
    .filter((msg) => msg.role === 'user' && !msg.compaction)
    .map((msg) => {
      const raw = (msg.content ?? '').trim();
      const text = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
      return { id: msg.id, text };
    });
  const showSlashCommands = !isStreaming && !isCompacting && slashCommands.length > 0;
  const estimatedContextTokens = estimateConversationTokens(messages, draft, attachments);

  useEffect(() => {
    setAttachments([]);
    setAttachmentError(null);
    setPendingPermissionCalls([]);
    setProviderRecoveryNotice(null);
    shouldAutoScrollRef.current = true;
    setIsThreadAtBottom(true);
    // 切换会话时,先把流式表达状态按会话归零,避免上一会话的 isStreaming/streamId 残留:
    // 否则从"正在输出的 A"切到"未运行的 B",B 会误显示运行中(左侧列表 Loading、
    // 右下角停止按钮误亮),且旧会话的 delta 仍匹配旧 streamIdRef 污染新会话消息。
    // 归零后由下方 reattach 按"新会话是否确有活跃流"重新点亮,仅以真值为准。
    setIsStreaming(false);
    streamIdRef.current = null;
    textTypewriter.reset();
    thinkingTypewriter.reset();
    if (!conversationId) { setMessages([]); setTokenUsage(null); return; }
    setTokenUsage(null);
    let cancelled = false;
    void (async () => {
      const { messages: loaded, tokenUsage: usage } = await loadConversationMessages(conversationId);
      if (cancelled) return;
      setMessages(loaded);
      if (usage) setTokenUsage(usage);

      // ADR 22: HMR 重载/重新打开后,main 进程的流式推理可能仍在进行。
      // 询问后端是否有本会话的活跃流;若有,把已累积的思考/正文接回 UI,
      // 并恢复 streamIdRef,使现有 delta 监听重新匹配、无缝续上(不重发、不打断)。
      try {
        const live = await clientApi.chatStreamReattach({ conversationId });
        if (cancelled || !live || !live.isStreaming || !live.streamId) return;
        const segments: ContentSegment[] = [];
        if (live.accumulatedThinking) segments.push({ type: 'thinking', content: live.accumulatedThinking });
        if (live.accumulatedText) segments.push({ type: 'text', content: live.accumulatedText });
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'assistant',
            content: live.accumulatedText ?? '',
            segments,
          },
        ]);
        streamIdRef.current = live.streamId;
        setIsStreaming(true);
      } catch {
        // reattach 失败不影响正常加载;降级为无续接(用户可重新发送)。
      }
    })();
    return () => { cancelled = true; };
  }, [conversationId]);

  useEffect(() => {
    const persistMessages = (msgs: ChatMsg[]) => {
      if (!conversationId) return;
      void clientApi.conversationsReplaceMessages({
        id: conversationId,
        messages: msgs.map((m) => ({
          id: m.id, role: m.role, content: m.content, segments: m.segments, usage: m.usage, _compaction: m.compaction, attachments: m.attachments,
        })),
      });
    };

    const offDelta = clientApi.onChatStreamDelta(({ streamId, content }) => {
      if (streamId !== streamIdRef.current) return;
      textTypewriter.push(content);
    });

    const offThinking = clientApi.onChatStreamThinking(({ streamId, content }) => {
      if (streamId !== streamIdRef.current) return;
      thinkingTypewriter.push(content);
    });

    const offDone = clientApi.onChatStreamDone(({ streamId, usage, lifetimeUsage }) => {
      if (streamId !== streamIdRef.current) return;
      textTypewriter.flush();
      thinkingTypewriter.flush();
      setIsStreaming(false);
      setIsCompacting(false);
      setActiveUsage(null);
      setPendingPermissionCalls([]);
      setToolProgress(null);
      const hasUsage = usage?.inputTokens || usage?.outputTokens || usage?.cacheWriteTokens || usage?.cacheReadTokens;
      const msgUsage = hasUsage
        ? { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0, cacheWrite: usage.cacheWriteTokens ?? 0, cacheRead: usage.cacheReadTokens ?? 0 }
        : null;
      if (lifetimeUsage) {
        // Usage ledger is owned by main/runtime; renderer only reflects the
        // authoritative lifetimeUsage returned with the stream terminal event.
        setTokenUsage(usageFromLifetime(lifetimeUsage));
      } else if (msgUsage) {
        // Compatibility fallback for older runtimes/tests that do not enrich
        // terminal stream events with lifetimeUsage.
        setTokenUsage((prev) => ({
          input: (prev?.input ?? 0) + msgUsage.input,
          output: (prev?.output ?? 0) + msgUsage.output,
          cacheWrite: (prev?.cacheWrite ?? 0) + msgUsage.cacheWrite,
          cacheRead: (prev?.cacheRead ?? 0) + msgUsage.cacheRead,
        }));
      }
      if (conversationId) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && isEmptyAssistantPlaceholder(last)) {
            const next = prev.slice(0, -1);
            persistMessages(next);
            return next;
          }
          if (msgUsage) {
            if (last?.role === 'assistant') {
              const updated = [...prev.slice(0, -1), { ...last, usage: msgUsage }];
              persistMessages(updated);
              return updated;
            }
          }
          persistMessages(prev);
          return prev;
        });
        onConversationUpdated?.();
      }
      streamIdRef.current = null;
    });

    const offUsage = clientApi.onChatStreamUsage(({ streamId, usage }) => {
      if (streamId !== streamIdRef.current || !usage) return;
      setActiveUsage({
        input: usage.inputTokens ?? 0,
        output: usage.outputTokens ?? 0,
        cacheWrite: usage.cacheWriteTokens ?? 0,
        cacheRead: usage.cacheReadTokens ?? 0,
      });
    });

    const offAborted = clientApi.onChatStreamAborted(({ streamId }) => {
      if (streamId !== streamIdRef.current) return;
      textTypewriter.flush();
      thinkingTypewriter.flush();
      setIsStreaming(false);
      setIsCompacting(false);
      setActiveUsage(null);
      setPendingPermissionCalls([]);
      setToolProgress(null);
      if (conversationId) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          const next = last && isEmptyAssistantPlaceholder(last) ? prev.slice(0, -1) : prev;
          persistMessages(next);
          return next;
        });
        onConversationUpdated?.();
      }
      streamIdRef.current = null;
    });

    const offToolProgress = clientApi.onChatStreamToolProgress(({ streamId, tool, path, receivedLines }) => {
      if (streamId !== streamIdRef.current) return;
      setToolProgress({ tool, path, receivedLines });
    });

    const offToolCall = clientApi.onChatStreamToolCall(({ streamId, tool, args }) => {
      if (streamId !== streamIdRef.current) return;
      // Tool-call events can arrive while the typewriter still holds earlier text
      // deltas. Flush first so pre-call text is committed above the structured
      // tool-call segment instead of being appended below it later.
      textTypewriter.flush();
      thinkingTypewriter.flush();
      // 参数已落地为正式 tool-call 段,过程提示让位给结构化段。
      setToolProgress(null);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (!last || last.role !== 'assistant') return prev;
        const segments = [...(last.segments || [])];
        segments.push({ type: 'tool-call', tool, args, result: undefined });
        const next = [...prev.slice(0, -1), { ...last, segments }];
        persistMessages(next);
        return next;
      });
    });

    const offToolResult = clientApi.onChatStreamToolResult(({ streamId, result }) => {
      if (streamId !== streamIdRef.current) return;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (!last || last.role !== 'assistant') return prev;
        const segments = [...(last.segments || [])];
        for (let i = segments.length - 1; i >= 0; i--) {
          const segment = segments[i];
          if (segment.type === 'tool-call' && segment.result === undefined) {
            segments[i] = { ...segment, result };
            break;
          }
        }
        const next = [...prev.slice(0, -1), { ...last, segments }];
        persistMessages(next);
        return next;
      });
    });

    const offPermissionRequest = clientApi.onChatStreamPermissionRequest(({ streamId, call }) => {
      if (streamId !== streamIdRef.current) return;
      setPendingPermissionCalls((prev) => {
        if (prev.some((item) => item.toolCallId === call.toolCallId)) return prev;
        return [...prev, call];
      });
    });

    const offError = clientApi.onChatStreamError(({ streamId, error, usage, lifetimeUsage }) => {
      if (streamId !== streamIdRef.current) return;
      textTypewriter.flush();
      thinkingTypewriter.flush();
      setIsStreaming(false);
      setIsCompacting(false);
      setActiveUsage(null);
      setPendingPermissionCalls([]);
      setToolProgress(null);
      setStreamError(error);
      if (lifetimeUsage) {
        setTokenUsage(usageFromLifetime(lifetimeUsage));
      } else if (usage?.inputTokens || usage?.outputTokens || usage?.cacheWriteTokens || usage?.cacheReadTokens) {
        const msgUsage = {
          input: usage.inputTokens ?? 0,
          output: usage.outputTokens ?? 0,
          cacheWrite: usage.cacheWriteTokens ?? 0,
          cacheRead: usage.cacheReadTokens ?? 0,
        };
        setTokenUsage((prev) => ({
          input: (prev?.input ?? 0) + msgUsage.input,
          output: (prev?.output ?? 0) + msgUsage.output,
          cacheWrite: (prev?.cacheWrite ?? 0) + msgUsage.cacheWrite,
          cacheRead: (prev?.cacheRead ?? 0) + msgUsage.cacheRead,
        }));
      }
      if (conversationId) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          const next = last && isEmptyAssistantPlaceholder(last) ? prev.slice(0, -1) : prev;
          persistMessages(next);
          return next;
        });
      }
      streamIdRef.current = null;
    });

    const offProviderRecovery = clientApi.onChatStreamProviderRecovery(({
      streamId,
      fromProvider,
      toProvider,
      reason,
    }) => {
      if (streamId !== streamIdRef.current) return;
      setProviderRecoveryNotice({ fromProvider, toProvider, reason });
    });

    const offCompaction = clientApi.onChatCompaction(({ streamId, stage, method, beforeTokens, afterTokens, oldMessageCount, keptMessageCount }) => {
      if (streamId !== streamIdRef.current) return;
      if (stage === 'start') {
        setIsCompacting(true);
        return;
      }
      if (stage === 'idle') {
        setIsCompacting(false);
        return;
      }
      setIsCompacting(false);
      if (!method || beforeTokens === undefined || afterTokens === undefined || oldMessageCount === undefined || keptMessageCount === undefined) return;
      setCompactionNotice({ method, beforeTokens, afterTokens, oldMessageCount, keptMessageCount });
      if (conversationId) {
        void (async () => {
          const { messages: loaded, tokenUsage: usage } = await loadConversationMessages(conversationId);
          setMessages(loaded);
          if (usage) setTokenUsage(usage);
          onConversationUpdated?.();
        })();
      }
      // Auto-dismiss after 10s
      setTimeout(() => setCompactionNotice(null), 10000);
    });

    return () => { offDelta(); offThinking(); offDone(); offUsage(); offAborted(); offToolProgress(); offToolCall(); offToolResult(); offPermissionRequest(); offError(); offProviderRecovery(); offCompaction(); };
  }, [appendStreamThinking, conversationId, onConversationUpdated]);

  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      scrollThreadToBottom('auto');
      return;
    }
    updateThreadBottomState(threadRef.current);
  }, [messages, scrollThreadToBottom, updateThreadBottomState]);

  useEffect(() => {
    setActiveSlashIndex(0);
  }, [slashQuery]);

  const applySlashCommand = useCallback((command: SlashCommand) => {
    setDraft(command.value);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(command.value.length, command.value.length);
    });
  }, []);

  const removePendingPermissionCall = useCallback((toolCallId: string) => {
    setPendingPermissionCalls((prev) => prev.filter((call) => call.toolCallId !== toolCallId));
  }, []);

  const approvePendingPermissionCall = useCallback((call: ClientToolCall) => {
    removePendingPermissionCall(call.toolCallId);
    void clientApi.approveLocalAction(call.toolCallId);
  }, [removePendingPermissionCall]);

  const approveAlwaysPendingPermissionCall = useCallback((call: ClientToolCall) => {
    removePendingPermissionCall(call.toolCallId);
    void clientApi.approveLocalAction(call.toolCallId, {
      duration: 'scope',
      scope: call.capabilityId,
    });
  }, [removePendingPermissionCall]);

  const denyPendingPermissionCall = useCallback((call: ClientToolCall) => {
    removePendingPermissionCall(call.toolCallId);
    void clientApi.denyLocalAction(call.toolCallId);
  }, [removePendingPermissionCall]);

  const addFiles = useCallback(async (files: FileList | File[] | null | undefined) => {
    const incoming = Array.from(files ?? []);
    if (!incoming.length) return;

    setAttachmentError(null);
    const next: ChatAttachment[] = [];
    for (const file of incoming) {
      if (attachments.length + next.length >= MAX_ATTACHMENTS) {
        setAttachmentError(isZh ? `最多只能添加 ${MAX_ATTACHMENTS} 个附件` : `You can attach up to ${MAX_ATTACHMENTS} files`);
        break;
      }

      try {
        if (file.type.startsWith('image/')) {
          if (file.size > MAX_IMAGE_BYTES) {
            setAttachmentError(isZh ? `${file.name} 超过 8MB，未添加` : `${file.name} is larger than 8MB and was not attached`);
            continue;
          }
          next.push({
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name || 'image',
            mimeType: file.type || 'image/png',
            size: file.size,
            kind: 'image',
            dataUrl: await readAsDataUrl(file),
          });
        } else if (isTextLikeFile(file)) {
          if (file.size > MAX_TEXT_FILE_BYTES) {
            setAttachmentError(isZh ? `${file.name} 超过 512KB，未添加` : `${file.name} is larger than 512KB and was not attached`);
            continue;
          }
          next.push({
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name || 'file.txt',
            mimeType: file.type || 'text/plain',
            size: file.size,
            kind: 'text',
            text: await readAsText(file),
          });
        } else {
          next.push({
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name || 'file',
            mimeType: file.type || 'application/octet-stream',
            size: file.size,
            kind: 'unsupported',
          });
          setAttachmentError(isZh ? `${file.name || '文件'} 暂不支持读取内容，仅附带文件信息` : `${file.name || 'File'} content is not supported yet; only file metadata was attached`);
        }
      } catch (error) {
        setAttachmentError(error instanceof Error ? error.message : (isZh ? '读取附件失败' : 'Failed to read attachment'));
      }
    }

    if (next.length) setAttachments((prev) => [...prev, ...next]);
  }, [attachments.length, isZh]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
    setAttachmentError(null);
  }, []);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const fileItems = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!fileItems.length) return;
    event.preventDefault();
    void addFiles(fileItems);
  }, [addFiles]);

  // 核心发送路径:给定文本(+ 可选附件)就执行一次 agent turn。
  // handleSend(用户输入)与 pending-task 续传(跨重启)都复用它,避免另造发送路径。
  const submitMessage = useCallback(async (text: string, sentAttachments: ChatAttachment[], submitEffort?: string) => {
    if ((!text && sentAttachments.length === 0) || isStreaming || !hasProvider || !conversationId) return;
    setStreamError(null);
    setActiveUsage(null);
    setProviderRecoveryNotice(null);
    const turnEffort = submitEffort ?? effort;

    // /compact: run compaction in-place without an agent turn
    if (text === '/compact' && sentAttachments.length === 0) {
      const streamId = `compact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      streamIdRef.current = streamId;
      setIsCompacting(true);
      try {
        const result = await clientApi.chatCompact({ conversationId, streamId });
        if (result.compacted) {
          const { messages: loaded, tokenUsage: usage } = await loadConversationMessages(conversationId);
          setMessages(loaded);
          if (usage) setTokenUsage(usage);
          onConversationUpdated?.();
        }
      } finally {
        streamIdRef.current = null;
        setIsCompacting(false);
      }
      return;
    }

    const now = Date.now();
    const userMsg: ChatMsg = { id: nextId(), role: 'user', content: text, timestamp: now, attachments: sentAttachments.length ? sentAttachments : undefined };
    const assistantMsg: ChatMsg = { id: nextId(), role: 'assistant', content: '', segments: [], timestamp: now };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    await clientApi.conversationsAppendMessage({ id: conversationId, message: { id: userMsg.id, role: 'user', content: text, timestamp: now, attachments: userMsg.attachments } });
    await clientApi.conversationsAppendMessage({ id: conversationId, message: { id: assistantMsg.id, role: 'assistant', content: '', timestamp: now } });
    onConversationUpdated?.();

    const streamId = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    streamIdRef.current = streamId;
    setIsStreaming(true);

    const contextMessages = [...messages, userMsg];
    const apiMessages = toApiMessages(contextMessages);
    const contextAttachments = buildConversationAttachmentContext(contextMessages);
    const continuityContext = buildConversationContinuityContext(contextMessages);
    const configInstructions = buildConfigInstructionContext(systemInstructions);
    void clientApi.chatSend({ messages: apiMessages, streamId, effort: turnEffort, conversationId, contextAttachments, continuityContext, configInstructions });
  }, [isStreaming, hasProvider, conversationId, messages, onConversationUpdated, effort, systemInstructions]);

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || isStreaming || !hasProvider || !conversationId) return;
    const sentAttachments = attachments;
    setDraft('');
    setAttachments([]);
    setAttachmentError(null);
    await submitMessage(text, sentAttachments);
  }, [draft, attachments, isStreaming, hasProvider, conversationId, submitMessage]);

  // 任务续传(ADR 21):就绪后在「正确的会话内」自动发送。
  // App.tsx 已 peek 到会话锚定的待办、切到 resumeTask.sessionId 并经 prop 传入;这里要求
  // 当前 conversationId 已切到该 sessionId(回到中断现场)、provider 就绪、无流式进行中,
  // 才自动发出一次。resumeFiredRef 作一次性闸门防重发;发送成功后回调 onResumeConsumed,
  // 由 App.tsx 清空内存 resumeTask 并清除磁盘文件(成功后才删,确保失败不丢)。
  useEffect(() => {
    if (!resumeTask || !conversationId || !hasProvider || isStreaming) return;
    // 必须落到续传记录指定的那个会话,避免把任务发进错误/新建的会话。
    if (conversationId !== resumeTask.sessionId) return;
    if (resumeFiredRef.current === resumeTask.sessionId) return;
    resumeFiredRef.current = resumeTask.sessionId;
    const taskEffort =
      isEffortLevel(resumeTask.effort)
        ? resumeTask.effort
        : undefined;
    if (taskEffort) setEffort(taskEffort);
    void (async () => {
      await submitMessage(resumeTask.task, [], taskEffort);
      onResumeConsumed?.();
    })();
  }, [resumeTask, conversationId, hasProvider, isStreaming, submitMessage, onResumeConsumed]);

  const handleStop = useCallback(() => {
    if (streamIdRef.current) void clientApi.chatAbort({ streamId: streamIdRef.current });
  }, []);

  const handleRegenerate = useCallback(async (msgIndex: number) => {
    if (isStreaming || !hasProvider || !conversationId) return;
    const target = messages[msgIndex];
    if (!target || target.role !== 'assistant') return;

    const contextMessages = messages.slice(0, msgIndex);
    const newAssistant: ChatMsg = { id: nextId(), role: 'assistant', content: '', segments: [] };
    setMessages([...contextMessages, newAssistant]);
    setStreamError(null);
    setActiveUsage(null);
    setProviderRecoveryNotice(null);

    await clientApi.conversationsUpdateLastMessage({ id: conversationId, content: '' });

    const streamId = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    streamIdRef.current = streamId;
    setIsStreaming(true);

    const apiMessages = toApiMessages(contextMessages);
    const contextAttachments = buildConversationAttachmentContext(contextMessages);
    const continuityContext = buildConversationContinuityContext(contextMessages);
    const configInstructions = buildConfigInstructionContext(systemInstructions);
    void clientApi.chatSend({ messages: apiMessages, streamId, effort, conversationId, contextAttachments, continuityContext, configInstructions });
  }, [isStreaming, hasProvider, conversationId, messages, effort, systemInstructions]);

  const handleBranch = useCallback(async (msgIndex: number) => {
    if (!conversationId || isStreaming) return;
    const contextMessages = messages.slice(0, msgIndex + 1);
    const branchTitle = contextMessages.find((m) => m.role === 'user')?.content.slice(0, 50) || 'Branch';
    const conv = await clientApi.conversationsCreate({ title: branchTitle }) as { id: string };
    for (const m of contextMessages) {
      await clientApi.conversationsAppendMessage({ id: conv.id, message: { id: m.id, role: m.role, content: m.content, segments: m.segments, usage: m.usage, timestamp: m.timestamp, _compaction: m.compaction, attachments: m.attachments } });
    }
    onConversationUpdated?.();
    onBranch?.(conv.id);
  }, [conversationId, isStreaming, messages, onConversationUpdated, onBranch]);

  const handleDeleteMessage = useCallback(async (msgIndex: number) => {
    if (!conversationId || isStreaming) return;
    const updated = messages.filter((_, i) => i !== msgIndex);
    setMessages(updated);
    await clientApi.conversationsReplaceMessages({
      id: conversationId,
      messages: updated.map((m) => ({ id: m.id, role: m.role, content: m.content, segments: m.segments, usage: m.usage, timestamp: m.timestamp, _compaction: m.compaction, attachments: m.attachments })),
    });
    onConversationUpdated?.();
  }, [conversationId, isStreaming, messages, onConversationUpdated]);

  const handleMessageAction = useCallback((msgIndex: number, action: MessageActionId) => {
    if (action === 'regenerate') void handleRegenerate(msgIndex);
    else if (action === 'branch') void handleBranch(msgIndex);
    else if (action === 'delete') void handleDeleteMessage(msgIndex);
  }, [handleRegenerate, handleBranch, handleDeleteMessage]);

  const showScrollToBottom = messages.length > 0 && !isThreadAtBottom;

  if (!conversationId) {
    return (
      <div className="chat-surface">
        <div className="chat-thread" ref={threadRef} onScroll={handleThreadScroll}>
          <div className="chat-empty-state">
            <h2>{isZh ? '有什么可以帮你的？' : 'How can I help you?'}</h2>
            {!hasProvider ? (
              <p>
                {isZh ? '请先' : 'Please '}
                <button type="button" className="chat-link-btn" onClick={onOpenSettings}>
                  {isZh ? '配置模型' : 'configure a model'}
                </button>
                {isZh ? '后开始对话' : ' to start chatting'}
              </p>
            ) : (
              <p>{isZh ? '点击左侧「新对话」开始' : 'Click "New Chat" to start'}</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-surface">
      <div className="chat-thread" ref={threadRef} onScroll={handleThreadScroll}>
        {messages.length === 0 ? (
          <div className="chat-empty-state">
            <p>{isZh ? '输入消息开始对话' : 'Type a message to start'}</p>
          </div>
        ) : messages.map((msg, idx) => (
          <div key={msg.id} data-msg-id={msg.id} className={`chat-msg chat-msg-${msg.role}`}>
            {msg.compaction ? (
              <CompactionSummaryCard compaction={msg.compaction} isZh={isZh} />
            ) : (
              <>
            {msg.timestamp ? <time className="chat-msg-time">{formatTime(msg.timestamp)}</time> : null}
            <span className="chat-msg-role-label">{msg.role === 'user' ? (isZh ? '你' : 'You') : 'Peer Agent'}</span>
            <div className="chat-msg-body">
              {msg.role === 'user' ? (
                <>
                  {msg.content ? <p>{msg.content}</p> : null}
                  {msg.attachments?.length ? (
                    <AttachmentStrip attachments={msg.attachments} readOnly isZh={isZh} onPreviewImage={setImagePreview} />
                  ) : null}
                </>
              ) : (
                <AssistantContent
                  segments={msg.segments}
                  content={msg.content}
                  isStreaming={isStreaming && msg === messages[messages.length - 1]}
                  toolProgress={isStreaming && msg === messages[messages.length - 1] ? toolProgress : null}
                  isZh={isZh}
                />
              )}
            </div>
            <MessageActionBar
              role={msg.role}
              content={msg.content}
              canEdit={true}
              isStreaming={isStreaming}
              onAction={(action) => handleMessageAction(idx, action)}
              i18n={i18n}
            />
              </>
            )}
          </div>
        ))}
        {providerRecoveryNotice ? (
          <div className="provider-recovery-notice">
            <div className="provider-recovery-body">
              {isZh
                ? `主模型连接失败，已切换到 ${providerRecoveryNotice.toProvider || '备用模型'}`
                : `Primary provider failed; switched to ${providerRecoveryNotice.toProvider || 'fallback provider'}`}
            </div>
            {providerRecoveryNotice.reason ? (
              <span className="provider-recovery-meta">
                {providerRecoveryNotice.fromProvider ? `${providerRecoveryNotice.fromProvider}: ` : ''}{providerRecoveryNotice.reason}
              </span>
            ) : null}
          </div>
        ) : null}
        {isCompacting || compactionNotice ? (
          <div className={`compaction-notice ${isCompacting ? 'compaction-notice-active' : ''}`}>
            {isCompacting ? <span className="compaction-spinner" aria-hidden="true" /> : <span className="compaction-notice-icon">📦</span>}
            <div className="compaction-notice-body">
              {isCompacting
                ? (isZh ? '压缩上下文中' : 'Compacting context')
                : (isZh ? '对话历史已自动压缩' : 'Conversation history compacted')}
            </div>
            {!isCompacting && compactionNotice ? (
              <span className="compaction-notice-meta">
                {compactionNotice.oldMessageCount} msgs, {(compactionNotice.beforeTokens / 1000).toFixed(0)}k → {(compactionNotice.afterTokens / 1000).toFixed(0)}k tokens
              </span>
            ) : null}
          </div>
        ) : null}
        {streamError ? (
          <div className="chat-stream-error"><span>⚠ {streamError}</span></div>
        ) : null}
      </div>

      <MessageRail items={railItems} onSelect={scrollToMessage} i18n={i18n} />

      {showScrollToBottom ? (
        <button
          type="button"
          className="chat-scroll-bottom-btn"
          onClick={() => scrollThreadToBottom('smooth')}
          aria-label={isZh ? '滚动到底部' : 'Scroll to bottom'}
          title={isZh ? '滚动到底部' : 'Scroll to bottom'}
        >
          <span aria-hidden="true">↓</span>
        </button>
      ) : null}

      <div className="chat-composer-wrap">
        <PermissionGateStrip
          pendingCalls={pendingPermissionCalls}
          onApprove={approvePendingPermissionCall}
          onApproveAlways={approveAlwaysPendingPermissionCall}
          onReject={denyPendingPermissionCall}
          i18n={i18n}
        />
        <form
          className="chat-composer"
          onSubmit={(e) => { e.preventDefault(); isStreaming ? handleStop() : void handleSend(); }}
        >
          {showSlashCommands ? (
            <div className="slash-command-menu" role="listbox" aria-label={isZh ? '命令' : 'Commands'}>
              {slashCommands.map((command, index) => (
                <button
                  key={command.id}
                  type="button"
                  role="option"
                  aria-selected={index === activeSlashIndex}
                  className={`slash-command-item ${index === activeSlashIndex ? 'active' : ''}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    applySlashCommand(command);
                  }}
                >
                  <span className="slash-command-badge">/</span>
                  <span className="slash-command-main">
                    <span className="slash-command-label">{isZh ? command.labelZh : command.labelEn}</span>
                    <span className="slash-command-desc">{isZh ? command.descriptionZh : command.descriptionEn}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          {attachments.length ? (
            <AttachmentStrip
              attachments={attachments}
              onRemove={removeAttachment}
              onPreviewImage={setImagePreview}
              isZh={isZh}
            />
          ) : null}
          {attachmentError ? <div className="attachment-error">{attachmentError}</div> : null}
          <textarea
            ref={textareaRef}
            value={draft}
            disabled={!hasProvider}
            placeholder={hasProvider ? (isZh ? '输入消息...' : 'Type a message...') : (isZh ? '请先配置模型' : 'Configure a model first')}
            rows={1}
            onPaste={handlePaste}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (showSlashCommands) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActiveSlashIndex((index) => (index + 1) % slashCommands.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActiveSlashIndex((index) => (index - 1 + slashCommands.length) % slashCommands.length);
                  return;
                }
                if ((e.key === 'Tab' || e.key === 'Enter') && draft !== slashCommands[activeSlashIndex]?.value) {
                  e.preventDefault();
                  applySlashCommand(slashCommands[activeSlashIndex]);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setDraft('');
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                isStreaming ? handleStop() : void handleSend();
              }
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="chat-file-input"
            onChange={(event) => {
              void addFiles(event.currentTarget.files);
              event.currentTarget.value = '';
            }}
          />
          <button
            type="button"
            className="composer-attach-btn"
            disabled={!hasProvider || isStreaming}
            title={isZh ? '添加附件' : 'Attach files'}
            aria-label={isZh ? '添加附件' : 'Attach files'}
            onClick={() => fileInputRef.current?.click()}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 1 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <button
            type="submit"
            className={isStreaming ? 'streaming' : undefined}
            disabled={!hasProvider || (!isStreaming && !draft.trim() && attachments.length === 0)}
          >
            {isStreaming ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5" /><path d="m5 12 7-7 7 7" />
              </svg>
            )}
          </button>
        </form>
        <div className="chat-composer-toolbar">
          <div className="chat-composer-toolbar-left">
            <Dropdown
              className="composer-dropdown composer-access-dropdown"
              value={localAccessLevel}
              options={ACCESS_LEVELS.map((level) => ({
                value: level,
                label: accessLevelLabel(level, isZh),
                tone: level === 'full_local' ? 'danger' : undefined,
              }))}
              onChange={(next) => {
                if (isLocalAccessLevel(next)) changeLocalAccessLevel(next);
              }}
              ariaLabel={isZh ? '本地访问模式' : 'Local access mode'}
              title={accessLevelTitle(localAccessLevel, isZh)}
              menuPlacement="up"
            />
          </div>
          <TokenUsageDisplay
            providers={providers}
            tokenUsage={tokenUsage}
            activeUsage={activeUsage}
            contextTokens={estimatedContextTokens}
            isStreaming={isStreaming}
            isZh={isZh}
            effort={effort}
            effortLevels={activeProviderSupportsReasoning ? effortLevels : []}
            onEffortChange={changeEffort}
          />
        </div>
      </div>
      {imagePreview?.kind === 'image' && imagePreview.dataUrl ? (
        <ImagePreviewOverlay attachment={imagePreview} isZh={isZh} onClose={() => setImagePreview(null)} />
      ) : null}
    </div>
  );
}

function AttachmentStrip({
  attachments,
  onRemove,
  onPreviewImage,
  readOnly = false,
  isZh,
}: {
  readonly attachments: readonly ChatAttachment[];
  readonly onRemove?: (id: string) => void;
  readonly onPreviewImage?: (attachment: ChatAttachment) => void;
  readonly readOnly?: boolean;
  readonly isZh: boolean;
}) {
  if (!attachments.length) return null;
  return (
    <div className={`attachment-strip ${readOnly ? 'readonly' : ''}`}>
      {attachments.map((attachment) => (
        <div key={attachment.id} className={`attachment-chip ${attachment.kind}`}>
          {attachment.kind === 'image' && attachment.dataUrl ? (
            <button
              type="button"
              className="attachment-thumb-btn"
              onClick={() => onPreviewImage?.(attachment)}
              title={isZh ? '预览图片' : 'Preview image'}
              aria-label={isZh ? `预览图片 ${attachment.name}` : `Preview image ${attachment.name}`}
            >
              <img src={attachment.dataUrl} alt="" className="attachment-thumb" />
            </button>
          ) : (
            <span className="attachment-file-icon" aria-hidden="true">
              {attachment.kind === 'text' ? 'TXT' : 'FILE'}
            </span>
          )}
          <span className="attachment-meta">
            <span className="attachment-name" title={attachment.name}>{attachment.name}</span>
            <span className="attachment-size">
              {attachment.kind === 'image'
                ? (isZh ? '图片' : 'Image')
                : attachment.kind === 'text'
                  ? (isZh ? '文本' : 'Text')
                  : (isZh ? '未读取' : 'Metadata only')}
              {' · '}
              {formatBytes(attachment.size)}
            </span>
          </span>
          {!readOnly && onRemove ? (
            <button
              type="button"
              className="attachment-remove"
              onClick={() => onRemove(attachment.id)}
              aria-label={isZh ? `移除 ${attachment.name}` : `Remove ${attachment.name}`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ImagePreviewOverlay({
  attachment,
  isZh,
  onClose,
}: {
  readonly attachment: ChatAttachment;
  readonly isZh: boolean;
  readonly onClose: () => void;
}) {
  return (
    <div className="image-preview-overlay" role="dialog" aria-modal="true" aria-label={attachment.name} onClick={onClose}>
      <figure className="image-preview-card" onClick={(event) => event.stopPropagation()}>
        <img src={attachment.dataUrl ?? ''} alt={attachment.name} className="image-preview-img" />
        <figcaption className="image-preview-caption">
          <span className="image-preview-name">{attachment.name}</span>
          <span className="image-preview-size">{formatBytes(attachment.size)}</span>
          <button type="button" className="image-preview-close" onClick={onClose} aria-label={isZh ? '关闭预览' : 'Close preview'}>
            ×
          </button>
        </figcaption>
      </figure>
    </div>
  );
}

function ToolProgressInline({ progress, isZh }: { readonly progress: ToolProgress; readonly isZh: boolean }) {
  return (
    <div className="tool-progress-inline">
      <span className="tool-progress-spinner" aria-hidden="true" />
      <div className="tool-progress-body">
        {toolProgressLabel(progress, isZh)}
      </div>
    </div>
  );
}

function AssistantContent({ segments, content, isStreaming, toolProgress, isZh }: {
  readonly segments?: ContentSegment[];
  readonly content: string;
  readonly isStreaming: boolean;
  readonly toolProgress?: ToolProgress | null;
  readonly isZh: boolean;
}) {
  if (!segments?.length) {
    if (content || toolProgress || isStreaming) {
      return (
        <div className="assistant-segments">
          {content ? <MarkdownMessage content={content} /> : null}
          {toolProgress ? <ToolProgressInline progress={toolProgress} isZh={isZh} /> : null}
          {!toolProgress && isStreaming ? <span className="streaming-cursor">▍</span> : null}
        </div>
      );
    }
    return null;
  }

  const groups = groupSegments(segments);
  const lastGroup = groups[groups.length - 1];
  // 流式期间始终保留一个“还在运行”的指示，避免工具执行间隙/文本结束等待下一步时
  // 光标消失造成“卡住”的错觉。仅当末尾组本身已有 active 视觉（工具执行中的工具组、
  // active 的思考文本组）时才省略底部光标，避免重复闪烁。
  const lastGroupHasActiveIndicator = Boolean(
    lastGroup &&
    ((lastGroup.type === 'tool-call-group' && lastGroup.calls.some((c) => c.result === undefined)) ||
      lastGroup.type === 'thinking'),
  );
  const showCursor = isStreaming && !toolProgress && !lastGroupHasActiveIndicator;

  return (
    <div className="assistant-segments">
      {groups.map((group, i) => {
        if (group.type === 'text') {
          const afterTools = i > 0 && groups[i - 1].type === 'tool-call-group';
          return (
            <div key={i} className={afterTools ? 'segment-text-after-tools' : undefined}>
              <MarkdownMessage content={group.content} />
            </div>
          );
        }
        if (group.type === 'thinking') {
          return (
            <ThinkingTextSection
              key={i}
              content={group.content}
              isActive={isStreaming && i === groups.length - 1}
              isZh={isZh}
            />
          );
        }
        return (
          <ThinkingSection
            key={i}
            toolCalls={group.calls}
            isActive={isStreaming && group.calls.some((c) => c.result === undefined)}
            isZh={isZh}
          />
        );
      })}
      {toolProgress ? <ToolProgressInline progress={toolProgress} isZh={isZh} /> : null}
      {showCursor ? <span className="streaming-cursor">▍</span> : null}
    </div>
  );
}

function ThinkingTextSection({ content, isActive, isZh }: { readonly content: string; readonly isActive: boolean; readonly isZh: boolean }) {
  const [expanded, setExpanded] = useState(isActive);
  const label = isActive
    ? (isZh ? '深度思考中...' : 'Thinking...')
    : (isZh ? '深度思考' : 'Thinking');

  return (
    <div className={`thinking-section ${isActive ? 'active' : 'done'}`}>
      <button type="button" className="thinking-toggle" onClick={() => setExpanded(!expanded)}>
        <span className="thinking-indicator" aria-hidden="true">
          {isActive ? (
            <svg className="thinking-indicator-svg" width="13" height="13" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.3" />
              <path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" fill="currentColor" />
            </svg>
          )}
        </span>
        <span className="thinking-label">{label}</span>
        <svg className="thinking-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={expanded ? undefined : { transform: 'rotate(-90deg)' }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {expanded ? (
        <div className="thinking-body thinking-text">
          <MarkdownMessage content={content} />
        </div>
      ) : null}
    </div>
  );
}

function ThinkingSection({ toolCalls, isActive, isZh }: { readonly toolCalls: ToolCallLegacy[]; readonly isActive: boolean; readonly isZh: boolean }) {
  const [expanded, setExpanded] = useState(isActive);
  const doneCount = toolCalls.filter((tc) => tc.result !== undefined).length;
  const total = toolCalls.length;
  const label = isActive
    ? (isZh ? `思考中... (${doneCount}/${total})` : `Thinking... (${doneCount}/${total})`)
    : (isZh ? `${total} 次工具调用` : `${total} tool call${total > 1 ? 's' : ''}`);

  return (
    <div className={`thinking-section ${isActive ? 'active' : 'done'}`}>
      <button type="button" className="thinking-toggle" onClick={() => setExpanded(!expanded)}>
        <span className="thinking-indicator" aria-hidden="true">
          {isActive ? (
            <svg className="thinking-indicator-svg" width="13" height="13" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.3" />
              <path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" fill="currentColor" />
            </svg>
          )}
        </span>
        <span className="thinking-label">{label}</span>
        <svg className="thinking-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={expanded ? undefined : { transform: 'rotate(-90deg)' }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {expanded ? (
        <div className="thinking-body">
          {toolCalls.map((tc, i) => (
            <ToolCallCard key={i} tc={tc} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ToolCallCard({ tc }: { readonly tc: ToolCallLegacy }) {
  const [expanded, setExpanded] = useState(false);
  const label = tc.tool === 'bash'
    ? (tc.args.command as string)
    : tc.tool === 'read_file'
      ? `read ${tc.args.path}`
      : tc.tool === 'edit_file'
        ? `edit ${tc.args.path}`
        : tc.tool === 'write_file'
          ? `write ${tc.args.path}`
          : tc.tool;
  const isSynthetic = tc.synthetic === true;
  const isDone = tc.result !== undefined && !isSynthetic;

  return (
    <div className={`tool-call-card ${isSynthetic ? 'synthetic' : isDone ? 'done' : 'running'}`} onClick={() => setExpanded(!expanded)}>
      <div className="tool-call-header">
        <span className="tool-call-icon" aria-hidden="true">
          {isSynthetic ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="8" x2="12" y2="13" />
              <circle cx="12" cy="16.6" r="0.9" fill="currentColor" stroke="none" />
            </svg>
          ) : isDone ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 12.5 4.5 4.5L19 7" />
            </svg>
          ) : (
            <svg className="tool-call-spinner-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M12 3a9 9 0 1 0 9 9" />
            </svg>
          )}
        </span>
        <span className="tool-call-label">{label}</span>
        <svg className="tool-call-expand" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={expanded ? undefined : { transform: 'rotate(-90deg)' }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>
      {isSynthetic && expanded ? (
        <pre className="tool-call-output">这不是一次真实工具调用记录，而是历史 assistant 文本中出现的伪 Tool Call 标记；没有收到对应的工具结果。</pre>
      ) : null}
      {expanded && tc.result ? (
        <pre className="tool-call-output">{tc.result}</pre>
      ) : null}
    </div>
  );
}

function CompactionSummaryCard({ compaction, isZh }: { readonly compaction: CompactionMeta; readonly isZh: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const methodLabel =
    compaction.method === 'llm' ? 'LLM'
    : compaction.method === 'structural' ? (isZh ? '结构' : 'Structural')
    : (isZh ? '截断' : 'Truncated');
  const countLabel = compaction.deltaMessageCount !== undefined
    && compaction.deltaMessageCount !== compaction.originalMessageCount
    ? (isZh
      ? `本次 ${compaction.deltaMessageCount} / 累计 ${compaction.originalMessageCount} 条`
      : `${compaction.deltaMessageCount} this run / ${compaction.originalMessageCount} total`)
    : `${compaction.originalMessageCount} msgs`;

  return (
    <div className="compaction-summary-card">
      <button type="button" className="compaction-summary-toggle" onClick={() => setExpanded(!expanded)}>
        <span className="compaction-summary-icon">📦</span>
        <span className="compaction-summary-label">
          {isZh ? '更早的对话（已压缩为摘要）' : 'Earlier conversation (compacted)'}
        </span>
        <span className="compaction-summary-count">
          {countLabel} · {methodLabel}
        </span>
        <svg className="tool-call-expand" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={expanded ? undefined : { transform: 'rotate(-90deg)' }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {expanded ? (
        <div className="compaction-summary-body">
          {(compaction as unknown as Record<string, unknown>).summary
            ? (compaction as unknown as Record<string, unknown>).summary as string
            : (isZh
              ? `${compaction.originalMessageCount} 条早期消息已被压缩。\n\n压缩前: ${(compaction.beforeTokens / 1000).toFixed(0)}k tokens\n压缩后: ${(compaction.afterTokens / 1000).toFixed(0)}k tokens\n方法: ${methodLabel}`
              : `${compaction.originalMessageCount} earlier messages compacted.\n\nBefore: ${(compaction.beforeTokens / 1000).toFixed(0)}k tokens\nAfter: ${(compaction.afterTokens / 1000).toFixed(0)}k tokens\nMethod: ${methodLabel}`)}
        </div>
      ) : null}
    </div>
  );
}

function TokenUsageDisplay({ providers, tokenUsage, activeUsage, contextTokens, isStreaming, isZh, effort, effortLevels, onEffortChange }: {
  readonly providers: readonly LlmProviderConfigView[];
  readonly tokenUsage: TokenUsageState | null;
  readonly activeUsage?: TokenUsageState | null;
  readonly contextTokens?: number;
  readonly isStreaming?: boolean;
  readonly isZh: boolean;
  readonly effort: EffortLevel;
  readonly effortLevels: readonly EffortLevel[];
  readonly onEffortChange: (level: EffortLevel) => void;
}) {
  const defaultProvider = providers.find((p) => p.isDefault && p.apiKeyConfigured) || providers.find((p) => p.apiKeyConfigured);
  const hasInfo = tokenUsage || activeUsage || contextTokens || defaultProvider?.contextWindow || defaultProvider?.inputPrice != null;
  if (!hasInfo) return null;

  const input = (tokenUsage?.input ?? 0) + (activeUsage?.input ?? 0);
  const output = (tokenUsage?.output ?? 0) + (activeUsage?.output ?? 0);
  const cacheWrite = (tokenUsage?.cacheWrite ?? 0) + (activeUsage?.cacheWrite ?? 0);
  const cacheRead = (tokenUsage?.cacheRead ?? 0) + (activeUsage?.cacheRead ?? 0);
  const billedTokens = input + output;
  const currentContextTokens = contextTokens ?? billedTokens;

  const isSubscriptionProvider = defaultProvider?.authMethod === 'oauth_chatgpt';
  let costStr: string | null = null;
  if (!isSubscriptionProvider && defaultProvider?.inputPrice != null && defaultProvider?.outputPrice != null) {
    const p = defaultProvider;
    const inputCost = (input / 1_000_000) * (p.inputPrice ?? 0);
    const outputCost = (output / 1_000_000) * (p.outputPrice ?? 0);
    const cwCost = cacheWrite && p.cacheWritePrice != null ? (cacheWrite / 1_000_000) * p.cacheWritePrice : 0;
    const crCost = cacheRead && p.cacheReadPrice != null ? (cacheRead / 1_000_000) * p.cacheReadPrice : 0;
    const cost = inputCost + outputCost + cwCost + crCost;
    costStr = cost === 0 ? '$0.00' : cost < 0.001 ? '<$0.001' : cost < 0.01 ? '$' + cost.toFixed(4) : '$' + cost.toFixed(2);
  }

  const ctxWindow = defaultProvider?.contextWindow;
  const ctxPercent = ctxWindow ? Math.min((currentContextTokens / ctxWindow) * 100, 100) : null;
  const effortOptions: readonly DropdownOption[] = effortLevels.map((level) => ({ value: level, label: effortLabel(level, isZh) }));

  return (
    <div className="token-usage-wrap">
      <span className="token-usage">
        {defaultProvider?.model ? (
          <span className="token-usage-model" title={isZh ? '当前会话使用的模型' : 'Model used for this conversation'}>{defaultProvider.model}</span>
        ) : null}
        {effortOptions.length > 0 ? (
          <Dropdown
            className="composer-dropdown composer-effort-dropdown"
            value={effort}
            options={effortOptions}
            onChange={(next) => {
              if (isEffortLevel(next)) onEffortChange(next);
            }}
            ariaLabel={isZh ? '思考深度' : 'Reasoning effort'}
            title={isZh ? '思考深度' : 'Reasoning effort'}
            menuPlacement="up"
          />
        ) : null}
        {ctxWindow ? (
          <>{isZh ? '上下文' : 'Ctx'} {formatTokenCount(currentContextTokens)}<span className="token-usage-detail"> / {formatTokenCount(ctxWindow)}</span></>
        ) : currentContextTokens > 0 ? (
          <>{formatTokenCount(currentContextTokens)} tokens</>
        ) : null}
        {costStr ? (
          <span
            className="token-usage-cost"
            title={
              isZh
                ? '按 API 单价估算的等价用量价值。'
                : 'Estimated equivalent API value.'
            }
          >
            {costStr}
          </span>
        ) : null}
        {isStreaming && !activeUsage ? <span className="token-usage-detail">{isZh ? '计费待返回' : 'usage pending'}</span> : null}
      </span>
      {ctxPercent != null ? (
        <div className="ctx-bar">
          <div className="ctx-bar-fill" style={{ width: `${ctxPercent}%` }} />
        </div>
      ) : null}
    </div>
  );
}
