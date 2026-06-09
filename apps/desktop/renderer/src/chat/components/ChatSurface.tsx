import type { I18nRuntime } from '@peer-agent/i18n';
import type { LlmProviderConfigView } from '@peer-agent/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';
import { MarkdownMessage } from './markdown/MarkdownMessage';
import { MessageActionBar, type MessageActionId } from './thread/MessageActionBar';
import { useTypewriterStream } from '../hooks/useTypewriterStream';

interface ContentSegment {
  type: 'text' | 'tool-call';
  content?: string;
  tool?: string;
  args?: Record<string, unknown>;
  result?: string;
}

interface ToolCallLegacy {
  tool: string;
  args: Record<string, unknown>;
  result?: string;
}

interface CompactionMeta {
  method: string;
  originalMessageCount: number;
  beforeTokens: number;
  afterTokens: number;
}

interface ChatMsg {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  segments?: ContentSegment[];
  timestamp?: number;
  usage?: { input: number; output: number; cacheWrite?: number; cacheRead?: number };
  compaction?: CompactionMeta;
}

function isEmptyAssistantPlaceholder(message: Pick<ChatMsg, 'role' | 'content' | 'segments'>): boolean {
  return (
    message.role === 'assistant' &&
    message.content.trim() === '' &&
    (!Array.isArray(message.segments) || message.segments.length === 0)
  );
}

function toApiMessages(messages: readonly ChatMsg[]): { role: string; content: string }[] {
  return messages
    .filter((message) => !isEmptyAssistantPlaceholder(message))
    .map((message) => ({ role: message.role, content: message.content }));
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

interface TextGroup { type: 'text'; content: string }
interface ToolCallGroup { type: 'tool-call-group'; calls: ToolCallLegacy[] }
type SegmentGroup = TextGroup | ToolCallGroup;

function groupSegments(segments: ContentSegment[]): SegmentGroup[] {
  const groups: SegmentGroup[] = [];
  for (const seg of segments) {
    if (seg.type === 'text') {
      groups.push({ type: 'text', content: seg.content || '' });
    } else {
      const last = groups[groups.length - 1];
      if (last && last.type === 'tool-call-group') {
        last.calls.push({ tool: seg.tool!, args: seg.args || {}, result: seg.result });
      } else {
        groups.push({ type: 'tool-call-group', calls: [{ tool: seg.tool!, args: seg.args || {}, result: seg.result }] });
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

function estimateTextTokens(value: unknown): number {
  return Math.ceil(String(value ?? '').length / 4);
}

function estimateMessageTokens(message: ChatMsg): number {
  let tokens = 10;
  tokens += estimateTextTokens(message.content);
  if (message.segments?.length) {
    for (const segment of message.segments) {
      tokens += estimateTextTokens(segment.content);
      tokens += estimateTextTokens(segment.tool);
      tokens += estimateTextTokens(JSON.stringify(segment.args ?? {}));
      tokens += estimateTextTokens(segment.result);
    }
  }
  return tokens;
}

function estimateConversationTokens(messages: readonly ChatMsg[], draft: string): number {
  const messageTokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  return Math.max(0, messageTokens + estimateTextTokens(draft));
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(1)}k`;
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
    return msg;
  }).filter((message) => !isEmptyAssistantPlaceholder(message));
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
  onOpenSettings,
  onConversationUpdated,
  onBranch,
}: {
  readonly i18n: I18nRuntime;
  readonly providers: readonly LlmProviderConfigView[];
  readonly conversationId: string | null;
  readonly onOpenSettings: () => void;
  readonly onConversationUpdated?: () => void;
  readonly onBranch?: (newConversationId: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [effort, setEffort] = useState<'low' | 'default' | 'high'>('default');
  const [tokenUsage, setTokenUsage] = useState<TokenUsageState | null>(null);
  const [activeUsage, setActiveUsage] = useState<TokenUsageState | null>(null);
  const [compactionNotice, setCompactionNotice] = useState<{ method: string; beforeTokens: number; afterTokens: number; oldMessageCount: number; keptMessageCount: number } | null>(null);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
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

  // 平滑打字机：网络 delta 进 buffer，rAF 泵匀速吐字，告别"一坨一坨"的生硬感。
  const typewriter = useTypewriterStream(appendStreamText);
  const threadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const hasProvider = providers.some((p) => p.apiKeyConfigured);
  const slashQuery = draft.startsWith('/') && !/\s/.test(draft) ? draft.toLowerCase() : null;
  const slashCommands = slashQuery
    ? SLASH_COMMANDS.filter((command) => command.value.startsWith(slashQuery))
    : [];
  const showSlashCommands = !isStreaming && !isCompacting && slashCommands.length > 0;
  const estimatedContextTokens = estimateConversationTokens(messages, draft);

  useEffect(() => {
    if (!conversationId) { typewriter.reset(); setMessages([]); setTokenUsage(null); return; }
    setTokenUsage(null);
    void (async () => {
      const { messages: loaded, tokenUsage: usage } = await loadConversationMessages(conversationId);
      setMessages(loaded);
      if (usage) setTokenUsage(usage);
    })();
  }, [conversationId]);

  useEffect(() => {
    const persistMessages = (msgs: ChatMsg[]) => {
      if (!conversationId) return;
      void clientApi.conversationsReplaceMessages({
        id: conversationId,
        messages: msgs.map((m) => ({
          id: m.id, role: m.role, content: m.content, segments: m.segments, usage: m.usage,
        })),
      });
    };

    const offDelta = clientApi.onChatStreamDelta(({ streamId, content }) => {
      if (streamId !== streamIdRef.current) return;
      typewriter.push(content);
    });

    const offDone = clientApi.onChatStreamDone(({ streamId, usage }) => {
      if (streamId !== streamIdRef.current) return;
      typewriter.flush();
      setIsStreaming(false);
      setIsCompacting(false);
      setActiveUsage(null);
      const hasUsage = usage?.inputTokens || usage?.outputTokens || usage?.cacheWriteTokens || usage?.cacheReadTokens;
      const msgUsage = hasUsage
        ? { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0, cacheWrite: usage.cacheWriteTokens ?? 0, cacheRead: usage.cacheReadTokens ?? 0 }
        : null;
      if (msgUsage) {
        setTokenUsage((prev) => ({
          input: (prev?.input ?? 0) + msgUsage.input,
          output: (prev?.output ?? 0) + msgUsage.output,
          cacheWrite: (prev?.cacheWrite ?? 0) + msgUsage.cacheWrite,
          cacheRead: (prev?.cacheRead ?? 0) + msgUsage.cacheRead,
        }));
      }
      if (conversationId) {
        setMessages((prev) => {
          if (msgUsage) {
            const last = prev[prev.length - 1];
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
      typewriter.flush();
      setIsStreaming(false);
      setIsCompacting(false);
      setActiveUsage(null);
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

    const offToolCall = clientApi.onChatStreamToolCall(({ streamId, tool, args }) => {
      if (streamId !== streamIdRef.current) return;
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
          if (segments[i].type === 'tool-call' && segments[i].result === undefined) {
            segments[i] = { ...segments[i], result };
            break;
          }
        }
        const next = [...prev.slice(0, -1), { ...last, segments }];
        persistMessages(next);
        return next;
      });
    });

    const offError = clientApi.onChatStreamError(({ streamId, error }) => {
      if (streamId !== streamIdRef.current) return;
      typewriter.flush();
      setIsStreaming(false);
      setIsCompacting(false);
      setActiveUsage(null);
      setStreamError(error);
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

    return () => { offDelta(); offDone(); offUsage(); offAborted(); offToolCall(); offToolResult(); offError(); offCompaction(); };
  }, [conversationId, onConversationUpdated]);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages]);

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

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || isStreaming || !hasProvider || !conversationId) return;
    setDraft('');
    setStreamError(null);
    setActiveUsage(null);

    // /compact: run compaction in-place without an agent turn
    if (text === '/compact') {
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
    const userMsg: ChatMsg = { id: nextId(), role: 'user', content: text, timestamp: now };
    const assistantMsg: ChatMsg = { id: nextId(), role: 'assistant', content: '', segments: [], timestamp: now };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    await clientApi.conversationsAppendMessage({ id: conversationId, message: { id: userMsg.id, role: 'user', content: text, timestamp: now } });
    await clientApi.conversationsAppendMessage({ id: conversationId, message: { id: assistantMsg.id, role: 'assistant', content: '', timestamp: now } });
    onConversationUpdated?.();

    const streamId = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    streamIdRef.current = streamId;
    setIsStreaming(true);

    const apiMessages = toApiMessages([...messages, userMsg]);
    void clientApi.chatSend({ messages: apiMessages, streamId, effort, conversationId });
  }, [draft, isStreaming, hasProvider, conversationId, messages, onConversationUpdated, effort]);

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

    await clientApi.conversationsUpdateLastMessage({ id: conversationId, content: '' });

    const streamId = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    streamIdRef.current = streamId;
    setIsStreaming(true);

    const apiMessages = toApiMessages(contextMessages);
    void clientApi.chatSend({ messages: apiMessages, streamId, effort, conversationId });
  }, [isStreaming, hasProvider, conversationId, messages, effort]);

  const handleBranch = useCallback(async (msgIndex: number) => {
    if (!conversationId || isStreaming) return;
    const contextMessages = messages.slice(0, msgIndex + 1);
    const branchTitle = contextMessages.find((m) => m.role === 'user')?.content.slice(0, 50) || 'Branch';
    const conv = await clientApi.conversationsCreate({ title: branchTitle }) as { id: string };
    for (const m of contextMessages) {
      await clientApi.conversationsAppendMessage({ id: conv.id, message: { id: m.id, role: m.role, content: m.content } });
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
      messages: updated.map((m) => ({ id: m.id, role: m.role, content: m.content, segments: m.segments })),
    });
    onConversationUpdated?.();
  }, [conversationId, isStreaming, messages, onConversationUpdated]);

  const handleMessageAction = useCallback((msgIndex: number, action: MessageActionId) => {
    if (action === 'regenerate') void handleRegenerate(msgIndex);
    else if (action === 'branch') void handleBranch(msgIndex);
    else if (action === 'delete') void handleDeleteMessage(msgIndex);
  }, [handleRegenerate, handleBranch, handleDeleteMessage]);

  const isZh = i18n.locale === 'zh-CN';

  if (!conversationId) {
    return (
      <div className="chat-surface">
        <div className="chat-thread" ref={threadRef}>
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
      <div className="chat-thread" ref={threadRef}>
        {messages.length === 0 ? (
          <div className="chat-empty-state">
            <p>{isZh ? '输入消息开始对话' : 'Type a message to start'}</p>
          </div>
        ) : messages.map((msg, idx) => (
          <div key={msg.id} className={`chat-msg chat-msg-${msg.role}`}>
            {msg.compaction ? (
              <CompactionSummaryCard compaction={msg.compaction} isZh={isZh} />
            ) : (
              <>
            {msg.timestamp ? <time className="chat-msg-time">{formatTime(msg.timestamp)}</time> : null}
            <span className="chat-msg-role-label">{msg.role === 'user' ? (isZh ? '你' : 'You') : 'Peer Agent'}</span>
            <div className="chat-msg-body">
              {msg.role === 'user' ? (
                <p>{msg.content}</p>
              ) : (
                <AssistantContent
                  segments={msg.segments}
                  content={msg.content}
                  isStreaming={isStreaming && msg === messages[messages.length - 1]}
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

      <div className="chat-composer-wrap">
        <div className="chat-composer-toolbar">
          <div className="effort-selector">
            {(['low', 'default', 'high'] as const).map((level) => (
              <button
                key={level}
                type="button"
                className={`effort-btn ${effort === level ? 'active' : ''}`}
                onClick={() => setEffort(level)}
                title={level}
              >
                {level === 'low' ? (isZh ? '简洁' : 'Low')
                  : level === 'high' ? (isZh ? '深度' : 'High')
                  : (isZh ? '标准' : 'Default')}
              </button>
            ))}
          </div>
          <TokenUsageDisplay providers={providers} tokenUsage={tokenUsage} activeUsage={activeUsage} contextTokens={estimatedContextTokens} isStreaming={isStreaming} isZh={isZh} />
        </div>
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
          <textarea
            ref={textareaRef}
            value={draft}
            disabled={!hasProvider}
            placeholder={hasProvider ? (isZh ? '输入消息...' : 'Type a message...') : (isZh ? '请先配置模型' : 'Configure a model first')}
            rows={1}
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
          <button
            type="submit"
            className={isStreaming ? 'streaming' : undefined}
            disabled={!hasProvider || (!isStreaming && !draft.trim())}
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
      </div>
    </div>
  );
}

function AssistantContent({ segments, content, isStreaming, isZh }: {
  readonly segments?: ContentSegment[];
  readonly content: string;
  readonly isStreaming: boolean;
  readonly isZh: boolean;
}) {
  if (!segments?.length) {
    if (content) return <MarkdownMessage content={content} />;
    if (isStreaming) return <span className="streaming-cursor">▍</span>;
    return null;
  }

  const groups = groupSegments(segments);
  const lastGroup = groups[groups.length - 1];
  const showCursor = isStreaming && (
    !groups.length ||
    (lastGroup.type === 'tool-call-group' && lastGroup.calls.every((c) => c.result !== undefined))
  );

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
        return (
          <ThinkingSection
            key={i}
            toolCalls={group.calls}
            isActive={isStreaming && group.calls.some((c) => c.result === undefined)}
            isZh={isZh}
          />
        );
      })}
      {showCursor ? <span className="streaming-cursor">▍</span> : null}
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
        <span className="thinking-indicator">{isActive ? '◐' : '●'}</span>
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
  const label = tc.tool === 'bash' ? (tc.args.command as string) : tc.tool === 'read_file' ? `read ${tc.args.path}` : tc.tool === 'write_file' ? `write ${tc.args.path}` : tc.tool;
  const isDone = tc.result !== undefined;

  return (
    <div className={`tool-call-card ${isDone ? 'done' : 'running'}`} onClick={() => setExpanded(!expanded)}>
      <div className="tool-call-header">
        <span className="tool-call-icon">{isDone ? '✓' : '⟳'}</span>
        <span className="tool-call-label">{label}</span>
        <svg className="tool-call-expand" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={expanded ? undefined : { transform: 'rotate(-90deg)' }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>
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

  return (
    <div className="compaction-summary-card">
      <button type="button" className="compaction-summary-toggle" onClick={() => setExpanded(!expanded)}>
        <span className="compaction-summary-icon">📦</span>
        <span className="compaction-summary-label">
          {isZh ? '更早的对话（已压缩为摘要）' : 'Earlier conversation (compacted)'}
        </span>
        <span className="compaction-summary-count">
          {compaction.originalMessageCount} msgs · {methodLabel}
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

function TokenUsageDisplay({ providers, tokenUsage, activeUsage, contextTokens, isStreaming, isZh }: {
  readonly providers: readonly LlmProviderConfigView[];
  readonly tokenUsage: TokenUsageState | null;
  readonly activeUsage?: TokenUsageState | null;
  readonly contextTokens?: number;
  readonly isStreaming?: boolean;
  readonly isZh: boolean;
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

  let costStr: string | null = null;
  if (defaultProvider?.inputPrice != null && defaultProvider?.outputPrice != null) {
    const p = defaultProvider;
    const inputCost = (input / 1_000_000) * (p.inputPrice ?? 0);
    const outputCost = (output / 1_000_000) * (p.outputPrice ?? 0);
    const cwCost = cacheWrite && p.cacheWritePrice != null ? (cacheWrite / 1_000_000) * p.cacheWritePrice : 0;
    const crCost = cacheRead && p.cacheReadPrice != null ? (cacheRead / 1_000_000) * p.cacheReadPrice : 0;
    const cost = inputCost + outputCost + cwCost + crCost;
    costStr = cost === 0 ? '$0.00' : cost < 0.001 ? '<$0.001' : cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
  }

  const ctxWindow = defaultProvider?.contextWindow;
  const ctxPercent = ctxWindow ? Math.min((currentContextTokens / ctxWindow) * 100, 100) : null;

  return (
    <div className="token-usage-wrap">
      <span className="token-usage">
        {ctxWindow ? (
          <>{isZh ? '上下文' : 'Ctx'} {formatTokenCount(currentContextTokens)}<span className="token-usage-detail"> / {formatTokenCount(ctxWindow)}</span></>
        ) : currentContextTokens > 0 ? (
          <>{formatTokenCount(currentContextTokens)} tokens</>
        ) : null}
        {billedTokens > 0 ? (
          <span className="token-usage-detail"> {isZh ? '入' : '↑'}{(input / 1000).toFixed(1)}k {isZh ? '出' : '↓'}{(output / 1000).toFixed(1)}k</span>
        ) : null}
        {costStr ? <span className="token-usage-cost">{costStr}</span> : null}
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
