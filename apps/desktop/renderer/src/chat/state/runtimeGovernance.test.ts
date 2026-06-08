import assert from 'node:assert/strict';
import test from 'node:test';
import { createI18n } from '@zeus-atlas/i18n';
import type { AgentCronSessionRecord, Conversation } from '@zeus-atlas/protocol';
import {
  countConversationsByChannel,
  matchesChannelFilter,
  resolveConversationChannel,
} from './channelRuntime.ts';
import {
  cronSessionStatus,
  cronStatusBucket,
  cronStatusLabel,
  cronStatusTone,
} from '../components/automation/cronStatus.ts';
import { parseMarkdownBlocks } from '../components/markdown/markdownParser.ts';
import { normalizeChatMessage } from '../api/messageNormalizer.ts';
import {
  ATLAS_VELLUM_NAME,
  ATLAS_VELLUM_TOKENS,
  DEFAULT_APPEARANCE_SETTINGS,
} from '../../appearance/themePresets.ts';
import { sanitizeSettings } from '../../appearance/themeTokens.ts';

function conversation(overrides: Partial<Conversation>): Conversation {
  return {
    id: 1,
    conversationUuid: 'conversation-1',
    title: 'conversation',
    channel: 'web',
    messageCount: 0,
    metadata: {},
    ...overrides,
  } as Conversation;
}

test('resolveConversationChannel classifies cloud-side source metadata without UI assumptions', () => {
  assert.equal(resolveConversationChannel(conversation({
    metadata: { source: 'cron' },
  })), 'automation');

  assert.equal(resolveConversationChannel(conversation({
    channel: 'share',
  })), 'share');

  assert.equal(resolveConversationChannel(conversation({
    metadata: { sourcePlatform: 'dingtalk', dingtalk: { conversationType: '2' } },
  })), 'dingtalk-group');

  assert.equal(resolveConversationChannel(conversation({
    metadata: {
      roundtable: {
        participants: [{ id: 'a' }, { id: 'b' }],
      },
    } as unknown as Conversation['metadata'],
  })), 'roundtable');
});

test('countConversationsByChannel keeps aggregate dingtalk count in sync with direct and group buckets', () => {
  const counts = countConversationsByChannel([
    conversation({ id: 1 }),
    conversation({ id: 2, metadata: { sourcePlatform: 'dingtalk' } }),
    conversation({ id: 3, metadata: { sourcePlatform: 'dingtalk', dingtalk: { conversationType: '2' } } }),
    conversation({ id: 4, metadata: { channel: { type: 'cron' } } }),
  ]);

  assert.equal(counts.all, 4);
  assert.equal(counts.web, 1);
  assert.equal(counts.dingtalk, 2);
  assert.equal(counts['dingtalk-direct'], 1);
  assert.equal(counts['dingtalk-group'], 1);
  assert.equal(counts.automation, 1);
});

test('matchesChannelFilter treats dingtalk as a parent filter', () => {
  const direct = conversation({ metadata: { sourcePlatform: 'dingtalk' } });
  const group = conversation({ metadata: { sourcePlatform: 'dingtalk', dingtalk: { conversationType: '2' } } });

  assert.equal(matchesChannelFilter(direct, 'dingtalk'), true);
  assert.equal(matchesChannelFilter(group, 'dingtalk'), true);
  assert.equal(matchesChannelFilter(direct, 'dingtalk-group'), false);
});

test('cron status helpers separate session bucket, tone, and display label', () => {
  const active = { status: 'active' } as AgentCronSessionRecord;
  const blocked = { status: 'blocked' } as AgentCronSessionRecord;
  const fallback = {
    schedule: { status: 'paused' },
  } as AgentCronSessionRecord;

  assert.equal(cronSessionStatus(fallback), 'paused');
  assert.equal(cronStatusBucket(active), 'running');
  assert.equal(cronStatusBucket(fallback), 'paused');
  assert.equal(cronStatusBucket(blocked), 'all');
  assert.equal(cronStatusTone('blocked'), 'danger');
  assert.equal(cronStatusLabel('waiting_prerequisite'), '等待条件');
});

test('product design language keeps appearance and loading copy out of engineering wording', () => {
  const zh = createI18n('zh-CN');
  const en = createI18n('en-US');

  assert.equal(zh.t('appearance.mode.system'), '跟随系统');
  assert.equal(zh.t('appearance.quick.black'), '黑');
  assert.equal(zh.t('appearance.quick.white'), '白');
  assert.equal(zh.t('appearance.previewComposer'), '继续交代任务或补充信息...');
  assert.equal(zh.t('chat.thread.loading'), '正在载入这段会话');
  assert.equal(en.t('chat.thread.loading'), 'Opening this thread');
  assert.notEqual(zh.t('chat.thread.loading'), '正在加载会话');
  assert.notEqual(en.t('chat.thread.loading'), 'Loading conversation');
});

test('atlas vellum is the canonical design language with pinned color anchors', () => {
  // Vellum 是 Zeus Atlas 客户端钦定语言，三色锚点在 tokens.css 与 themePresets 中固化
  assert.equal(ATLAS_VELLUM_NAME, 'Atlas Vellum');
  assert.equal(ATLAS_VELLUM_TOKENS.light.accent, '#9B3A2A');     // cinnabar-seal
  assert.equal(ATLAS_VELLUM_TOKENS.light.background, '#F1ECE0'); // vellum-base
  assert.equal(ATLAS_VELLUM_TOKENS.light.foreground, '#1A1612'); // ink-base
  assert.equal(ATLAS_VELLUM_TOKENS.dark.accent, '#D26450');
  assert.equal(ATLAS_VELLUM_TOKENS.dark.background, '#1A1612');
  assert.equal(ATLAS_VELLUM_TOKENS.dark.foreground, '#F1ECE0');

  // 默认 settings：跟随系统 + 宽松密度
  assert.equal(DEFAULT_APPEARANCE_SETTINGS.mode, 'system');
  assert.equal(DEFAULT_APPEARANCE_SETTINGS.density, 'comfortable');
});

test('appearance settings sanitization rejects garbage and migrates legacy v1 payloads', () => {
  // 未知字段被丢弃，保留合法的 mode / density
  const sanitized = sanitizeSettings({ mode: 'dark', density: 'compact', accent: 'rogue' });
  assert.equal(sanitized.mode, 'dark');
  assert.equal(sanitized.density, 'compact');

  // 非法值回退到默认
  const fallback = sanitizeSettings({ mode: 'rainbow', density: 'cosy' });
  assert.equal(fallback.mode, DEFAULT_APPEARANCE_SETTINGS.mode);
  assert.equal(fallback.density, DEFAULT_APPEARANCE_SETTINGS.density);

  // null / undefined / 非对象一律回退
  assert.deepEqual(sanitizeSettings(null), DEFAULT_APPEARANCE_SETTINGS);
  assert.deepEqual(sanitizeSettings('atlas'), DEFAULT_APPEARANCE_SETTINGS);
});

test('parseMarkdownBlocks preserves common assistant answer structure', () => {
  const blocks = parseMarkdownBlocks([
    '# 标题',
    '',
    '正文第一行',
    '正文第二行',
    '',
    '- A',
    '- B',
    '',
    '> 引用',
    '',
    '```ts',
    'const ok = true;',
    '```',
    '',
    '---',
  ].join('\n'));

  assert.deepEqual(blocks.map((block) => block.type), ['heading', 'paragraph', 'list', 'quote', 'code', 'rule']);
  assert.equal(blocks[0].type, 'heading');
  assert.equal(blocks[0].content, '标题');
  assert.equal(blocks[1].type, 'paragraph');
  assert.equal(blocks[1].content, '正文第一行\n正文第二行');
  assert.equal(blocks[2].type, 'list');
  assert.deepEqual(blocks[2].items, ['A', 'B']);
  assert.equal(blocks[4].type, 'code');
  assert.equal(blocks[4].language, 'ts');
});

test('parseMarkdownBlocks renders markdown tables as structured blocks', () => {
  const blocks = parseMarkdownBlocks([
    '三件事',
    '',
    '| # | 问题 | 为什么重要 |',
    '|---|------|------------|',
    '| 1 | <font colorTokenV2=common_red1_color>决策域有哪些？</font> | 没有边界就没有速度 |',
    '| 2 | 执行指令如何下达？ | 需要对接项目管理 |',
  ].join('\n'));

  assert.deepEqual(blocks.map((block) => block.type), ['paragraph', 'table']);
  assert.equal(blocks[1].type, 'table');
  assert.deepEqual(blocks[1].headers, ['#', '问题', '为什么重要']);
  assert.deepEqual(blocks[1].rows[0], [
    '1',
    '<font colorTokenV2=common_red1_color>决策域有哪些？</font>',
    '没有边界就没有速度',
  ]);
});

test('normalizeChatMessage recovers completed answer content from thinking timeline fallback', () => {
  const message = normalizeChatMessage({
    id: 1,
    role: 'assistant',
    content: '',
    thinkingProcess: {
      expanded: true,
      maxIterations: 3,
      toolCount: 0,
      status: 'completed',
      iterations: [
        {
          iteration: 1,
          thinkingContent: '我可以帮你查日程',
          toolCards: [],
          status: 'completed',
        },
      ],
    },
  });

  assert.equal(message.content, '我可以帮你查日程');
});
