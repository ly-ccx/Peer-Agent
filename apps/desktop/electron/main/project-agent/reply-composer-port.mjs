/**
 * 把 post_reply 交给 ReplyComposer，并用当前设置覆盖档位和安静时段。
 * 模型参数里没有送达事实；没有这些设置时按标准档、不在安静时段计算。
 */
import { composeReply } from '@peer-agent/runtime-node';

export function createDesktopReplyComposer({ readDelivery = null } = {}) {
  return {
    postReply(input, view) {
      const delivery = typeof readDelivery === 'function' ? (readDelivery(view) || {}) : {};
      const replyTo = Array.isArray(input?.replyTo) ? input.replyTo : [];
      const proactive = input?.proactive === true;
      const composed = composeReply({
        messageId: `reply:${view?.turnId || 'turn'}:${view?.toolCallOrdinal ?? 0}`,
        kind: replyTo.length > 0 ? 'user' : 'wake',
        text: typeof input?.text === 'string' ? input.text : '',
        replyTo,
        proactive,
        sources: input?.sources,
        question: input?.question,
        ...(typeof view?.turnId === 'string' && view.turnId ? { turnId: view.turnId } : {}),
        userMessages: Array.isArray(view?.messages) ? view.messages : [],
        projectSessionIds: Array.isArray(delivery.sessionIds) ? delivery.sessionIds : [],
        surfacing: {
          proactivity: typeof delivery.proactivity === 'string' ? delivery.proactivity : 'standard',
          ...(typeof delivery.botLevel === 'string' ? { botLevel: delivery.botLevel } : {}),
          quietHours: delivery.quietHours === true,
          needsYou: delivery.needsYou === true,
          foreground: false,
        },
      });
      if (!composed.ok) return { error: composed.error, message: composed.message };
      return {
        messageId: composed.message.id,
        meta: composed.meta,
        surfacing: composed.meta.surfacing,
      };
    },
  };
}
