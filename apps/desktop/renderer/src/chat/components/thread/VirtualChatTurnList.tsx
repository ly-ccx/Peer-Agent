import type { I18nRuntime } from '@peer-agent/i18n';
import { forwardRef, memo, useImperativeHandle } from 'react';
import type { RefObject } from 'react';
import {
  useVirtualChatTurns,
  type ScrollToTurnOptions,
} from '../../hooks/useVirtualChatTurns';
import {
  isLiveChatTurn,
  type ChatTurn as ChatTurnModel,
} from '../../state/chatTurns';
import type { ChatAttachment, ChatMsg } from '../../state/types';
import { ChatTurn } from './ChatTurn';
import type { MessageActionId } from './MessageActionBar';

export interface VirtualChatTurnListHandle {
  readonly scrollToTurn: (index: number, options?: ScrollToTurnOptions) => void;
  readonly updateViewport: () => void;
  readonly resetMeasurements: () => void;
}

interface VirtualChatTurnListProps {
  readonly conversationId: string | null;
  readonly turns: readonly ChatTurnModel[];
  readonly liveTurn: ChatTurnModel | null;
  readonly lastMessage: ChatMsg | undefined;
  readonly isStreaming: boolean;
  readonly streamStartedAt: number | null;
  readonly isZh: boolean;
  readonly i18n: I18nRuntime;
  readonly enabled: boolean;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly onMessageAction: (messageIndex: number, action: MessageActionId) => void;
  readonly onEditMessage: (
    messageId: string,
    text: string,
    attachments: readonly ChatAttachment[],
  ) => Promise<boolean>;
  readonly onRegenerate: (messageIndex: number) => void;
  readonly onPreviewImage: (attachment: ChatAttachment) => void;
}

const VirtualChatTurnListImpl = forwardRef<VirtualChatTurnListHandle, VirtualChatTurnListProps>(
  function VirtualChatTurnList({
    conversationId,
    turns,
    liveTurn,
    lastMessage,
    isStreaming,
    streamStartedAt,
    isZh,
    i18n,
    enabled,
    scrollRef,
    onMessageAction,
    onEditMessage,
    onRegenerate,
    onPreviewImage,
  }, ref) {
    const {
      range,
      measureElement,
      scrollToTurn,
      updateViewport,
      resetMeasurements,
    } = useVirtualChatTurns({
      ownerKey: conversationId,
      count: turns.length,
      scrollRef,
      enabled,
    });

    useImperativeHandle(ref, () => ({
      scrollToTurn,
      updateViewport,
      resetMeasurements,
    }), [resetMeasurements, scrollToTurn, updateViewport]);

    return (
      <div
        className="chat-turn-virtual-list"
        role="list"
        data-virtualized={enabled ? 'true' : 'false'}
      >
        {range.paddingStart > 0 ? (
          <div aria-hidden="true" style={{ height: range.paddingStart }} />
        ) : null}
        {range.items.map(({ index: turnIndex }) => {
          const turn = turnIndex === turns.length - 1 && liveTurn
            ? liveTurn
            : turns[turnIndex];
          if (!turn) return null;
          const live = isLiveChatTurn(turn, lastMessage, isStreaming);
          return (
            <ChatTurn
              key={turn.id}
              conversationId={conversationId}
              turn={turn}
              isLive={live}
              streamStartedAt={live ? streamStartedAt : null}
              isZh={isZh}
              i18n={i18n}
              onMessageAction={onMessageAction}
              onEditMessage={onEditMessage}
              onRegenerate={onRegenerate}
              onPreviewImage={onPreviewImage}
              turnIndex={turnIndex}
              onMeasure={measureElement}
            />
          );
        })}
        {range.paddingEnd > 0 ? (
          <div aria-hidden="true" style={{ height: range.paddingEnd }} />
        ) : null}
      </div>
    );
  },
);

/**
 * 虚拟窗口状态必须止于消息列表边界。滚动导致 range 变化时只重渲染可见 turn，
 * 不得把 Goal 面板、header、composer 和消息轨一并拖入 React render。
 */
export const VirtualChatTurnList = memo(VirtualChatTurnListImpl);
