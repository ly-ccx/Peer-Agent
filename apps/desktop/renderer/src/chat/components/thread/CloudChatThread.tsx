import type { I18nRuntime } from '@zeus-atlas/i18n';
import type { AuthState } from '@zeus-atlas/protocol';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatAuthIdentity } from '../../../app/runtimeLabels';
import { MarkdownMessage } from '../markdown/MarkdownMessage';
import type { CloudChatRuntime } from '../../state/cloudChatRuntimeTypes';
import {
  needsThinkingHydration,
  useThinkingHistoryLoader,
} from '../../state/useThinkingHistoryLoader';
import type { AgentSummary } from '../../state/useAgentList';
import { clientApi } from '../../../clientApi';
import { chatClient } from '../../api/chatClient';
import { ChatComposer } from './ChatComposer';
import { EmptyChatCommandSurface } from './EmptyChatCommandSurface';
import { MessageRichParts } from './MessageRichParts';
import { MessageActionBar } from './MessageActionBar';
import { ShareDialog } from './ShareDialog';
import type { ShareConfirmPayload } from './ShareDialog';
import type { MessageActionId } from './MessageActionBar';
import { PermissionGateStrip } from './PermissionGateStrip';
import { ThinkingTimeline } from './ThinkingTimeline';

const ZEUS_AGENT_NAME = '宙斯Agent';

/**
 * 消息角色标签 — 不再使用静态 i18n 文案"用户/Agent"。
 * user 使用真实登录名（如"槿柏"），assistant 使用产品身份"宙斯Agent"。
 * 这样每条消息的发送方都明确指向具体身份，不是抽象角色。
 */
function roleLabel(
  role: 'user' | 'assistant' | 'system' | 'tool',
  i18n: I18nRuntime,
  authState: AuthState | null,
) {
  if (role === 'user') return formatAuthIdentity(authState, i18n);
  if (role === 'assistant') return ZEUS_AGENT_NAME;
  return i18n.t(`chat.role.${role}`);
}

function ThreadLoadingState({ i18n }: { readonly i18n: I18nRuntime }) {
  const [showLabel, setShowLabel] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setShowLabel(true), 600);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="thread-loading-state" role="status" aria-live="polite" aria-label={i18n.t('chat.thread.loading')}>
      <span className="thread-loading-skeleton wide" />
      <span className="thread-loading-skeleton short" />
      {showLabel ? (
        <p>
          <span>{i18n.t('chat.thread.loading')}</span>
          <i />
          <i />
          <i />
        </p>
      ) : null}
    </div>
  );
}

export function CloudChatThread({
  activeAgent,
  agents,
  authState,
  draft,
  i18n,
  onSelectAgent,
  runtime,
  setDraft,
}: {
  readonly activeAgent: AgentSummary | null;
  readonly agents: readonly AgentSummary[];
  readonly authState: AuthState | null;
  readonly draft: string;
  readonly i18n: I18nRuntime;
  readonly onSelectAgent: (agent: AgentSummary) => void;
  readonly runtime: CloudChatRuntime;
  readonly setDraft: (draft: string) => void;
}) {
  const messagesRef = useRef<HTMLDivElement>(null);
  const thinkingLoader = useThinkingHistoryLoader();
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareSaving, setShareSaving] = useState(false);
  const [shareSelectionMode, setShareSelectionMode] = useState(false);
  const [shareSelectedIds, setShareSelectedIds] = useState<Set<number>>(new Set());
  const isEmptyThread = runtime.state.messages.length === 0;
  const isConversationLoading = Boolean(
    runtime.loadingConversationId &&
    runtime.loadingConversationId === runtime.state.conversation?.id,
  );
  const lastMessage = runtime.state.messages.at(-1);
  const scrollSignature = useMemo(() => [
    runtime.state.conversation?.id ?? 'new',
    runtime.state.messages.length,
    lastMessage?.id ?? '',
    lastMessage?.content.length ?? 0,
    lastMessage?.status ?? '',
    runtime.state.isStreaming ? 'streaming' : 'idle',
  ].join(':'), [
    lastMessage?.content.length,
    lastMessage?.id,
    lastMessage?.status,
    runtime.state.conversation?.id,
    runtime.state.isStreaming,
    runtime.state.messages.length,
  ]);

  useLayoutEffect(() => {
    if (isConversationLoading) return;
    const node = messagesRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [isConversationLoading, scrollSignature]);

  const threadMode = isEmptyThread && !isConversationLoading ? 'empty' : 'active';

  return (
    <section className={`cloud-chat-thread ${threadMode}`}>
      {runtime.error ? <p className="runtime-note">{runtime.error}</p> : null}
      {isEmptyThread ? (
        isConversationLoading ? (
          <>
            <div className="section-heading">
              <h2>{runtime.state.conversation?.title || i18n.t('chat.thread.newTitle')}</h2>
            </div>
            <div ref={messagesRef} className="cloud-chat-messages loading">
              <ThreadLoadingState i18n={i18n} />
            </div>
            <PermissionGateStrip
              pendingCalls={runtime.pendingClientToolCalls}
              onApprove={(call) => void runtime.executeClientToolCall(call)}
              onApproveAlways={(call) => {
                runtime.markAlwaysAllowed();
                void runtime.executeClientToolCall(call);
              }}
              onReject={(call) => void runtime.rejectClientToolCall(call)}
              i18n={i18n}
            />
            <ChatComposer activeAgent={activeAgent} agents={agents} draft={draft} i18n={i18n} onSelectAgent={onSelectAgent} runtime={runtime} setDraft={setDraft} />
          </>
        ) : (
          <EmptyChatCommandSurface activeAgent={activeAgent} agents={agents} draft={draft} i18n={i18n} onSelectAgent={onSelectAgent} runtime={runtime} setDraft={setDraft} />
        )
      ) : (
        <>
          <div className="section-heading">
            <h2>{runtime.state.conversation?.title || i18n.t('chat.thread.newTitle')}</h2>
          </div>
          <div ref={messagesRef} className={`cloud-chat-messages${isConversationLoading ? ' transitioning' : ''}`}>
            {runtime.state.messages.map((message) => (
              <article
                key={message.id}
                className={[
                  'cloud-chat-message',
                  message.role,
                  shareSelectionMode ? 'selection-mode' : '',
                  shareSelectionMode && message.rawMessageId && shareSelectedIds.has(message.rawMessageId) ? 'selected' : '',
                ].filter(Boolean).join(' ')}
                onClick={shareSelectionMode && message.rawMessageId ? () => {
                  setShareSelectedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(message.rawMessageId!)) next.delete(message.rawMessageId!);
                    else next.add(message.rawMessageId!);
                    return next;
                  });
                } : undefined}
              >
                {shareSelectionMode && message.rawMessageId ? (
                  <span className="share-select-checkbox">
                    <input
                      type="checkbox"
                      checked={shareSelectedIds.has(message.rawMessageId)}
                      readOnly
                    />
                  </span>
                ) : null}
                <header className="message-sender">
                  <span className="role-label">{roleLabel(message.role, i18n, authState)}</span>
                </header>
                {/* 思维链置于答案之前：先思考、后给结论的自然时序。
                    历史消息的 thinkingProcess 由后端 list 接口轻量返回（无
                    iterations），首次展开 details 时按需 hydrate 完整 stepsData。 */}
                {message.thinkingProcess && !shareSelectionMode ? (() => {
                  const cached = thinkingLoader.getCached(message.rawMessageId);
                  const renderThinking = cached ?? message.thinkingProcess;
                  const hydrating = thinkingLoader.isLoading(message.rawMessageId);
                  const shouldHydrate =
                    !cached && needsThinkingHydration(message) && Boolean(message.rawMessageId);
                  const isActivelyStreaming = message.status === 'streaming';
                  return (
                    <details
                      open={isActivelyStreaming || undefined}
                      onToggle={(event) => {
                        if (
                          event.currentTarget.open &&
                          shouldHydrate &&
                          message.rawMessageId
                        ) {
                          void thinkingLoader.hydrate(message.rawMessageId);
                        }
                      }}
                    >
                      <summary>
                        {isActivelyStreaming
                          ? <span className="za-streaming-text">{i18n.t('chat.message.timelineThinking')}</span>
                          : i18n.t('chat.message.timelineDone')}
                      </summary>
                      {hydrating ? (
                        <p className="thinking-hydrating">
                          {i18n.t('chat.timeline.hydrating')}
                        </p>
                      ) : null}
                      <ThinkingTimeline thinking={renderThinking} i18n={i18n} />
                    </details>
                  );
                })() : null}
                {message.content || message.status !== 'streaming' ? (
                  <div className={message.thinkingProcess && message.status !== 'streaming' ? 'message-content-reveal' : undefined}>
                    <MarkdownMessage content={message.content || ''} />
                  </div>
                ) : (
                  <span className="streaming-placeholder">
                    <span className="za-streaming-text">{i18n.t('chat.message.streaming')}</span>
                  </span>
                )}
                <MessageRichParts message={message} setDraft={setDraft} i18n={i18n} />
                <MessageActionBar
                  role={message.role}
                  content={message.content}
                  canEdit={!runtime.state.isStreaming}
                  isStreaming={runtime.state.isStreaming}
                  i18n={i18n}
                  onAction={(action: MessageActionId) => {
                    const conversationId = runtime.state.conversation?.id;
                    const msgUuid = message.messageUuid;
                    const msgId = message.rawMessageId;
                    console.log('[MessageAction]', action, { conversationId, msgUuid, msgId, role: message.role });
                    if (action === 'copy') {
                      void navigator.clipboard.writeText(message.content);
                    } else if (action === 'delete') {
                      if (!conversationId) return;
                      if (!window.confirm(i18n.t('chat.message.confirmDelete'))) return;
                      const deleteParams: any = { conversationId };
                      if (msgUuid) deleteParams.messageUuid = msgUuid;
                      else if (msgId) deleteParams.messageId = msgId;
                      else { console.warn('[MessageAction] delete: no message id'); return; }
                      // 删除后必须重载当前对话:state.messages 只有 reloadActiveConversation
                      // 才会更新,否则被删消息会留在屏幕上;refreshConversations 仅刷新左侧列表预览。
                      void chatClient.deleteMessage(deleteParams)
                        .then(() => Promise.all([
                          runtime.reloadActiveConversation(),
                          runtime.refreshConversations(),
                        ]))
                        .catch((e) => console.error('[MessageAction] delete failed', e));
                    } else if (action === 'regenerate' && conversationId) {
                      if (!window.confirm(i18n.t('chat.message.confirmRegenerate'))) return;
                      const messages = runtime.state.messages;
                      const idx = messages.findIndex((m) => m.id === message.id);
                      const prevUser = idx > 0 ? messages.slice(0, idx).reverse().find((m) => m.role === 'user') : null;
                      console.log('[MessageAction] regenerate', { idx, prevUser: prevUser?.id, prevContent: prevUser?.content?.slice(0, 30) });
                      if (prevUser?.content) {
                        const truncateParams: any = { conversationId };
                        if (prevUser.rawMessageId) truncateParams.fromMessageId = prevUser.rawMessageId;
                        else if (prevUser.messageUuid) truncateParams.fromMessageUuid = prevUser.messageUuid;
                        else { console.warn('[MessageAction] regenerate: no prev user id'); return; }
                        void chatClient.truncateAfterMessage(truncateParams)
                          .then(() => void runtime.sendMessage(prevUser.content))
                          .catch((e) => console.error('[MessageAction] regenerate failed', e));
                      }
                    } else if (action === 'share') {
                      setShareDialogOpen(true);
                    } else if (action === 'branch' && conversationId) {
                      if (!window.confirm(i18n.t('chat.message.confirmBranch'))) return;
                      const branchParams: any = { sourceConversationId: conversationId };
                      if (msgUuid) branchParams.upToMessageUuid = msgUuid;
                      else if (msgId) branchParams.upToMessageId = msgId;
                      else { console.warn('[MessageAction] branch: no message id'); return; }
                      void chatClient.branchFromMessage(branchParams)
                        .then((result: any) => {
                          console.log('[MessageAction] branch result', result);
                          if (result?.conversation) {
                            void runtime.selectConversation(result.conversation);
                          }
                        })
                        .catch((e) => console.error('[MessageAction] branch failed', e));
                    }
                  }}
                />
                {message.pendingHumanConfirmation ? (
                  <div className="confirmation-inline">
                    <span>
                      {i18n.t('chat.message.confirmationPending', {
                        title: message.pendingHumanConfirmation.title || message.pendingHumanConfirmation.confirmationId,
                      })}
                    </span>
                    <div>
                      <button
                        type="button"
                        onClick={() => void runtime.resolveConfirmation(message.pendingHumanConfirmation!, 'approve')}
                      >
                        {i18n.t('chat.confirm.approve')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void runtime.resolveConfirmation(message.pendingHumanConfirmation!, 'reject')}
                      >
                        {i18n.t('chat.confirm.reject')}
                      </button>
                    </div>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
          <PermissionGateStrip
            pendingCalls={runtime.pendingClientToolCalls}
            onApprove={(call) => void runtime.executeClientToolCall(call)}
            onApproveAlways={(call) => {
              runtime.markAlwaysAllowed();
              void runtime.executeClientToolCall(call);
            }}
            onReject={(call) => void runtime.rejectClientToolCall(call)}
            i18n={i18n}
          />
          <ChatComposer activeAgent={activeAgent} agents={agents} draft={draft} i18n={i18n} onSelectAgent={onSelectAgent} runtime={runtime} setDraft={setDraft} />
        </>
      )}
      <ShareDialog
        open={shareDialogOpen}
        saving={shareSaving}
        selectedCount={shareSelectedIds.size}
        i18n={i18n}
        onCancel={() => {
          setShareDialogOpen(false);
          setShareSelectionMode(false);
          setShareSelectedIds(new Set());
        }}
        onStartSelection={() => {
          setShareDialogOpen(false);
          setShareSelectionMode(true);
          setShareSelectedIds(new Set());
        }}
        onConfirm={async (payload: ShareConfirmPayload) => {
          const conversationId = runtime.state.conversation?.id;
          if (!conversationId) return;
          setShareSaving(true);
          try {
            const createResult: any = await chatClient.createShare({
              conversationId,
              mode: payload.mode,
              includeOptions: { includeThinking: true },
              ...(payload.mode === 'message_selection' && shareSelectedIds.size > 0
                ? { selectedMessageIds: Array.from(shareSelectedIds) }
                : {}),
            });
            const shareUuid = createResult?.shareUuid;
            if (!shareUuid) throw new Error('no shareUuid');

            if (payload.accessKind === 'acl' && payload.aclWhitelist.trim()) {
              const authResult: any = await clientApi.chat.createShareAuth({ shareUuid });
              if (authResult?.data?.aclKey || authResult?.aclKey) {
                await clientApi.chat.updateShareAuthMembers({
                  shareUuid,
                  white: payload.aclWhitelist.trim(),
                  black: '',
                });
              }
            }

            const link = `https://cbu-xiaoer.alibaba-inc.com/ai-chat/share?shareUuid=${shareUuid}`;
            await navigator.clipboard.writeText(link);
            setShareDialogOpen(false);
            setShareSelectionMode(false);
            setShareSelectedIds(new Set());
          } catch (e) {
            console.error('[ShareDialog] failed', e);
          } finally {
            setShareSaving(false);
          }
        }}
      />
      {shareSelectionMode ? (
        <div className="share-selection-bar">
          <span>{i18n.t('share.selectionHint', { count: shareSelectedIds.size })}</span>
          <button type="button" onClick={() => { setShareSelectionMode(false); setShareSelectedIds(new Set()); }}>
            {i18n.t('share.cancel')}
          </button>
          <button type="button" className="share-btn-confirm" disabled={shareSelectedIds.size === 0} onClick={() => setShareDialogOpen(true)}>
            {i18n.t('share.confirmSelection')}
          </button>
        </div>
      ) : null}
    </section>
  );
}
