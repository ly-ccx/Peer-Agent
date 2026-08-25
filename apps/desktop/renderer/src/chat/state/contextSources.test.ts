import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAttachmentContext,
  buildConversationAttachmentContext,
  buildConversationContinuityContext,
  buildConfigInstructionContext,
  buildGitBranchPrefixContext,
  buildReplyLanguageContext,
} from './contextSources.ts';
import { DEFAULT_GIT_BRANCH_PREFIX } from '../../app/gitBranchPrefix.ts';
import type { ChatAttachment, ChatMsg } from './types.ts';

function att(over: Partial<ChatAttachment> = {}): ChatAttachment {
  return { id: 'a', name: 'n', mimeType: 'text/plain', size: 1, kind: 'text', ...over };
}
function msg(over: Partial<ChatMsg> = {}): ChatMsg {
  return { id: 'm', role: 'user', content: '', ...over };
}

describe('buildAttachmentContext', () => {
  it('maps transport per kind and marks content inclusion', () => {
    const [img, text, un] = buildAttachmentContext([
      att({ kind: 'image' }),
      att({ kind: 'text' }),
      att({ kind: 'unsupported' }),
    ]);
    assert.equal(img.transport, 'provider_image_part');
    assert.equal(text.transport, 'user_text_part');
    assert.equal(un.transport, 'metadata_only');
    assert.equal(img.contentIncluded, true);
    assert.equal(un.contentIncluded, false);
    assert.equal(text.sourceKind, 'user_upload');
    assert.equal(text.lifecycle, 'ephemeral');
    assert.equal(text.scope, 'conversation');
  });

  it('preserves session_reference and workspace_file sourceKind', () => {
    const [session, file] = buildAttachmentContext([
      att({ id: 's', sourceKind: 'session_reference' }),
      att({
        id: 'f',
        kind: 'unsupported',
        sourceKind: 'workspace_file',
        workspaceRelPath: 'apps/desktop/renderer/src/chat/state/types.ts',
      }),
    ]);
    assert.equal(session.sourceKind, 'session_reference');
    assert.equal(session.scope, 'session');
    assert.equal(file.sourceKind, 'workspace_file');
    assert.equal(file.contentRef, 'apps/desktop/renderer/src/chat/state/types.ts');
    assert.equal(file.transport, 'metadata_only');
    assert.equal(file.contentIncluded, false);
  });
});

describe('buildConversationAttachmentContext', () => {
  it('collects attachments only from user messages', () => {
    const out = buildConversationAttachmentContext([
      msg({ role: 'user', attachments: [att({ id: 'x' })] }),
      msg({ role: 'assistant', attachments: [att({ id: 'y' })] }),
      msg({ role: 'user' }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'x');
  });
});

describe('buildConversationContinuityContext', () => {
  it('uses only the latest cumulative compaction handoff for runtime continuity', () => {
    const out = buildConversationContinuityContext([
      msg({ id: 'plain', content: 'hi' }),
      msg({
        id: 'c-old',
        content: 'old summary',
        compaction: { method: 'rolling', originalMessageCount: 3, beforeTokens: 80, afterTokens: 30 },
      }),
      msg({
        id: 'c',
        content: 'raw body',
        compaction: { method: 'rolling', originalMessageCount: 5, beforeTokens: 100, afterTokens: 20 },
      }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'c');
    assert.equal(out[0].method, 'rolling');
    assert.equal(out[0].summary, 'raw body'); // no explicit summary => falls back to content
  });
});

describe('buildConfigInstructionContext', () => {
  it('returns empty for blank/nullish input', () => {
    assert.deepEqual(buildConfigInstructionContext(''), []);
    assert.deepEqual(buildConfigInstructionContext('   '), []);
    assert.deepEqual(buildConfigInstructionContext(null), []);
    assert.deepEqual(buildConfigInstructionContext(undefined), []);
  });
  it('wraps trimmed instructions as a single instruction item', () => {
    const out = buildConfigInstructionContext('  be concise  ');
    assert.equal(out.length, 1);
    assert.equal(out[0].content, 'be concise');
    assert.equal(out[0].id, 'settings.systemInstructions');
    assert.equal(out[0].source, 'settings.systemInstructions');
  });
});

describe('buildReplyLanguageContext', () => {
  it('returns empty when unset, blank, or auto (follow the question)', () => {
    assert.deepEqual(buildReplyLanguageContext(''), []);
    assert.deepEqual(buildReplyLanguageContext('   '), []);
    assert.deepEqual(buildReplyLanguageContext(null), []);
    assert.deepEqual(buildReplyLanguageContext(undefined), []);
    assert.deepEqual(buildReplyLanguageContext('auto'), []);
  });
  it('returns empty for an unknown language code', () => {
    assert.deepEqual(buildReplyLanguageContext('xx-YY'), []);
  });
  it('produces a stable reply-language instruction for a known code', () => {
    const out = buildReplyLanguageContext('zh-CN');
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'settings.replyLanguage');
    assert.equal(out[0].source, 'settings.replyLanguage');
    assert.match(out[0].content, /Simplified Chinese/);
  });
  it('trims surrounding whitespace before matching', () => {
    const out = buildReplyLanguageContext('  ja-JP  ');
    assert.equal(out.length, 1);
    assert.match(out[0].content, /Japanese/);
  });
});

describe('buildGitBranchPrefixContext', () => {
  it('injects the default prefix when unset, blank, or whitespace-only', () => {
    for (const input of [null, undefined, '', '   '] as const) {
      const out = buildGitBranchPrefixContext(input);
      assert.equal(out.length, 1);
      assert.equal(out[0].id, 'settings.gitBranchPrefix');
      assert.equal(out[0].source, 'settings.gitBranchPrefix');
      assert.match(out[0].content, new RegExp(`prefix "${DEFAULT_GIT_BRANCH_PREFIX}"`));
      assert.match(out[0].content, /Do not apply this prefix to existing branches/);
      assert.match(out[0].content, /ASCII/);
      assert.match(out[0].content, /Never use Chinese or other non-ASCII/);
    }
  });

  it('injects a custom non-empty prefix (trimmed)', () => {
    const out = buildGitBranchPrefixContext('  team/  ');
    assert.equal(out.length, 1);
    assert.match(out[0].content, /prefix "team\/"/);
    assert.match(out[0].content, /team\/my-feature/);
    assert.match(out[0].content, /ASCII/);
    assert.match(out[0].content, /Never use Chinese or other non-ASCII/);
  });
});
