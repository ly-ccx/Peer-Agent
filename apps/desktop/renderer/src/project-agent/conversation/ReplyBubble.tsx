import type { I18nRuntime } from '@peer-agent/i18n';
import { useRef, useState } from 'react';
import { MarkdownMessage } from '../../chat/components/markdown/MarkdownMessage';
import { PeerIcon } from '../../ui/icons';
import type { BotChatMessage, BotToolRound } from '../state/botConversationState';
import type { ProjectAgentActivity } from '@peer-agent/protocol';
import { BotProcess, type ProcessDisclosure } from './BotProcess';
import { ReplyContext } from './ReplyContext';
import { DelegatedWork } from './DelegatedWork';
import { replyWork, type BotWorkIndex } from '../state/botWorkState';
import { CardView } from './CardView';
import { ReplyAnchors } from './ReplyAnchors';
import type { ReplyAnchor } from '../state/replyReferenceState';

export function ReplyBubble({
  workspaceId,
  workIndex,
  message,
  referenceIds,
  anchors,
  highlighted,
  i18n,
  onJump,
  onQuote,
  onLocateSession,
  onOpenEvidence,
  onOpenProcess,
  activity,
  processRounds,
  disclosure,
}: {
  readonly workspaceId: string;
  readonly workIndex: BotWorkIndex;
  readonly message: BotChatMessage;
  readonly referenceIds: readonly string[];
  readonly anchors: ReadonlyMap<string, ReplyAnchor>;
  readonly highlighted: boolean;
  readonly i18n: I18nRuntime;
  readonly onJump: (messageId: string) => void;
  readonly onQuote: (excerpt: string) => void;
  readonly onLocateSession: (sessionId: string) => void;
  readonly onOpenEvidence?: (evidenceRef: string) => void;
  readonly onOpenProcess?: () => void;
  readonly activity?: ProjectAgentActivity;
  readonly processRounds?: readonly BotToolRound[];
  readonly disclosure?: ProcessDisclosure;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [excerpt, setExcerpt] = useState('');
  return (
    <article
      className={`bot-reply${highlighted ? ' is-anchored' : ''}`}
      id={`bot-msg-${message.id}`}
      data-kind="agent_reply"
    >
      <ReplyAnchors ids={referenceIds} anchors={anchors} i18n={i18n} onJump={onJump} />
      <BotProcess activity={activity} rounds={processRounds} i18n={i18n} disclosure={disclosure} />
      <div
        className="bot-reply-body"
        ref={bodyRef}
        onMouseUp={() => {
          const selection = window.getSelection();
          const text = selection?.toString().replace(/\s+/g, ' ').trim() ?? '';
          const node = bodyRef.current;
          const inside = Boolean(node && selection?.anchorNode && node.contains(selection.anchorNode));
          setExcerpt(inside ? text : '');
        }}
      >
        <MarkdownMessage content={message.content} />
      </div>
      <DelegatedWork rows={replyWork(message, workIndex)} i18n={i18n} onOpen={onLocateSession} disclosure={disclosure} />
      <CardView workspaceId={workspaceId} cards={message.cards} i18n={i18n} />
      {excerpt ? <div className="bot-reply-marks">
          <button type="button" className="bot-quote-action" onClick={() => onQuote(excerpt)}>
            <PeerIcon name="back" size={14} />
            {i18n.t('projectAgent.chat.quote')}
          </button>
      </div> : null}
      <ReplyContext workspaceId={workspaceId} message={message} i18n={i18n} onOpenEvidence={onOpenEvidence} onOpenProcess={onOpenProcess} />
    </article>
  );
}
