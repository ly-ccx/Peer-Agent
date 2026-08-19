// Context Source 装配：把会话里的附件、压缩摘要、配置型系统指令，映射为协议定义的
// 受治理 Context item（ContextAttachmentItem / ContinuityContextItem /
// ConfigInstructionContextItem）。纯函数、无副作用、不依赖 React，从 ChatSurface.tsx
// 下沉而来，行为保持不变。
//
// 架构边界（System Context 治理）：
// - 这些函数只负责「把已有事实/配置整理成结构化 Context item」，由上层经既有 Context Source
//   通道纳入 System Context，而不是在组件里直接拼接系统提示词字符串。
// - 附件是 user/factual 上下文（lifecycle=ephemeral），不被提升为 system 指令。
//   sourceKind 按附件来源透传：上传默认 user_upload，@ 会话引用 session_reference，
//   @ 工作区文件 workspace_file。图片走 provider 多模态分片、文本走 user_text_part、
//   不支持类型 / 路径引用仅保留 metadata。
// - 压缩摘要是连续性上下文（continuity），不替代 Tool Result / Evidence。
// - ConfigInstructionContext 来自共享的宿主设置映射（systemInstructions / replyLanguage /
//   gitBranchPrefix），属于 instruction 层，Desktop 与 CLI 使用同一实现。

import type {
  ContextAttachmentItem,
  ContinuityContextItem,
} from '@peer-agent/protocol';
export {
  buildConfigInstructionContext,
  buildGitBranchPrefixContext,
  buildReplyLanguageContext,
} from '@peer-agent/system-context/host-config-instructions';
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
    sourceKind: attachment.sourceKind || 'user_upload',
    scope: attachment.sourceKind === 'session_reference' ? 'session' : 'conversation',
    lifecycle: 'ephemeral',
    ...(attachment.workspaceRelPath ? { contentRef: attachment.workspaceRelPath } : {}),
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

/**
 * 提取最新累计 compaction 作为连续性上下文。历史 handoff 继续留在 UI 时间线用于回看，
 * 但最新摘要已经 carry-forward 之前摘要，不能把所有历史摘要再次注入 runtime。
 */
export function buildConversationContinuityContext(messages: readonly ChatMsg[]): ContinuityContextItem[] {
  const message = [...messages].reverse().find((candidate) => Boolean(candidate.compaction));
  if (!message?.compaction) return [];
  return [{
    id: message.id,
    method: message.compaction.method ?? 'unknown',
    originalMessageCount: message.compaction.originalMessageCount ?? 0,
    beforeTokens: message.compaction.beforeTokens ?? 0,
    afterTokens: message.compaction.afterTokens ?? 0,
    summary: message.compaction.summary || message.content,
    content: message.content,
  }];
}
