// Context Source 装配：把会话里的附件、压缩摘要、配置型系统指令，映射为协议定义的
// 受治理 Context item（ContextAttachmentItem / ContinuityContextItem /
// ConfigInstructionContextItem）。纯函数、无副作用、不依赖 React，从 ChatSurface.tsx
// 下沉而来，行为保持不变。
//
// 架构边界（System Context 治理）：
// - 这些函数只负责「把已有事实/配置整理成结构化 Context item」，由上层经既有 Context Source
//   通道纳入 System Context，而不是在组件里直接拼接系统提示词字符串。
// - 附件是 user/factual 上下文（sourceKind=user_upload、lifecycle=ephemeral），
//   不被提升为 system 指令；图片走 provider 多模态分片、文本走 user_text_part、
//   不支持类型仅保留 metadata。
// - 压缩摘要是连续性上下文（continuity），不替代 Tool Result / Evidence。
// - 仅 ConfigInstructionContext 来自用户显式配置的 systemInstructions，属于 instruction 层。

import type {
  ConfigInstructionContextItem,
  ContextAttachmentItem,
  ContinuityContextItem,
} from '@peer-agent/protocol';
import type { ChatAttachment, ChatMsg } from './types';

/** 把一组附件映射为受治理的附件 Context item（标注传输方式/来源/生命周期）。 */
export function buildAttachmentContext(attachments: readonly ChatAttachment[]): ContextAttachmentItem[] {
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

/** 汇总整段会话里所有 user 消息携带的附件，作为会话级附件上下文。 */
export function buildConversationAttachmentContext(messages: readonly ChatMsg[]): ContextAttachmentItem[] {
  return messages.flatMap((message) => (
    message.role === 'user' && message.attachments?.length
      ? buildAttachmentContext(message.attachments)
      : []
  ));
}

/** 从带 compaction 的消息中提取连续性（continuity）上下文项。 */
export function buildConversationContinuityContext(messages: readonly ChatMsg[]): ContinuityContextItem[] {
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

/** 把用户配置的系统指令包装为 instruction 层 Context item（空则不产出）。 */
export function buildConfigInstructionContext(systemInstructions: string | null | undefined): ConfigInstructionContextItem[] {
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
