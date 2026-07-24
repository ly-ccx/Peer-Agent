import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStreamSegment,
  segmentsSignature,
  mergeReattachedSegments,
  contentFromSegments,
  isEmptyAssistantPlaceholder,
  isEmptyUserMessage,
  groupSegments,
  splitFinalTextGroup,
  getTextContent,
  migrateToSegments,
  parseSerializedToolSegments,
  markDanglingToolCallsInterrupted,
} from './streamSegments.ts';
import type { ContentSegment } from './types.ts';

const txt = (content: string): ContentSegment => ({ type: 'text', content });
const think = (content: string): ContentSegment => ({ type: 'thinking', content });
const tool = (tool: string, over: Partial<Extract<ContentSegment, { type: 'tool-call' }>> = {}): ContentSegment => ({ type: 'tool-call', tool, args: {}, ...over });

describe('normalizeStreamSegment', () => {
  it('fills default args and keeps structured fields for tool-call', () => {
    const out = normalizeStreamSegment({ type: 'tool-call', tool: 't' } as ContentSegment);
    assert.deepEqual(out, { type: 'tool-call', tool: 't', displayName: undefined, args: {}, result: undefined, synthetic: undefined, toolCallId: undefined, startedAtMs: undefined, endedAtMs: undefined, durationMs: undefined });
  });
  it('preserves tool lifecycle timing metadata', () => {
    const out = normalizeStreamSegment(tool('timed', { startedAtMs: 100, endedAtMs: 350, durationMs: 250 }));
    assert.equal(out.type === 'tool-call' ? out.startedAtMs : undefined, 100);
    assert.equal(out.type === 'tool-call' ? out.endedAtMs : undefined, 350);
    assert.equal(out.type === 'tool-call' ? out.durationMs : undefined, 250);
  });
  it('defaults content to empty string for text/thinking', () => {
    assert.deepEqual(normalizeStreamSegment({ type: 'text' } as ContentSegment), { type: 'text', content: '' });
  });
});

describe('segmentsSignature', () => {
  it('is equal for structurally equal segments', () => {
    assert.equal(segmentsSignature([txt('a'), tool('t')]), segmentsSignature([txt('a'), tool('t')]));
  });
  it('differs when content differs', () => {
    assert.notEqual(segmentsSignature([txt('a')]), segmentsSignature([txt('b')]));
  });
});

describe('mergeReattachedSegments', () => {
  it('returns live when persisted is empty', () => {
    assert.deepEqual(mergeReattachedSegments([], [txt('x')]), [txt('x')]);
  });
  it('returns persisted when live is empty', () => {
    assert.deepEqual(mergeReattachedSegments([txt('x')], []), [txt('x')]);
  });
  it('prefers live when it extends persisted as a prefix', () => {
    const out = mergeReattachedSegments([txt('a')], [txt('a'), txt('b')]);
    assert.deepEqual(out, [txt('a'), txt('b')]);
  });
  it('merges a growing single text segment without repeating the visible prefix', () => {
    const out = mergeReattachedSegments(
      [txt('几处关键事实读到了。')],
      [txt('几处关键事实读到了。有一个架构冲突点必须先确认清楚。')]
    );

    assert.deepEqual(out, [txt('几处关键事实读到了。有一个架构冲突点必须先确认清楚。')]);
    assert.equal(contentFromSegments(out), '几处关键事实读到了。有一个架构冲突点必须先确认清楚。');
  });
  it('keeps the longer local text segment when the live snapshot is stale', () => {
    const out = mergeReattachedSegments([txt('partial answer')], [txt('partial')]);

    assert.deepEqual(out, [txt('partial answer')]);
  });
  it('merges a growing single thinking segment without repeating the visible prefix', () => {
    const out = mergeReattachedSegments([think('分析中')], [think('分析中，继续确认边界')]);

    assert.deepEqual(out, [think('分析中，继续确认边界')]);
  });
  it('never drops persisted evidence on divergence (keeps history + live suffix)', () => {
    const out = mergeReattachedSegments([txt('a'), txt('b')], [txt('a'), txt('c')]);
    // common prefix = [a]; append live suffix after index 1 => [a, b, c]
    assert.deepEqual(out, [txt('a'), txt('b'), txt('c')]);
  });
  it('settles a reattached pending tool call with the live result instead of duplicating it', () => {
    const pending = tool('read', { toolCallId: 'call_read', args: { path: '/tmp/a' } });
    const completed = tool('read', { toolCallId: 'call_read', args: { path: '/tmp/a' }, result: 'ok' });

    const out = mergeReattachedSegments([think('读取中'), pending], [think('读取中'), completed]);
    const calls = out.filter((seg): seg is Extract<ContentSegment, { type: 'tool-call' }> => seg.type === 'tool-call' && seg.toolCallId === 'call_read');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].result, 'ok');
  });
  it('keeps a persisted completed tool result when the live reattach snapshot is stale pending', () => {
    const completed = tool('read', { toolCallId: 'call_read', args: { path: '/tmp/a' }, result: 'ok' });
    const pending = tool('read', { toolCallId: 'call_read', args: { path: '/tmp/a' } });

    const out = mergeReattachedSegments([completed], [pending]);
    const calls = out.filter((seg): seg is Extract<ContentSegment, { type: 'tool-call' }> => seg.type === 'tool-call' && seg.toolCallId === 'call_read');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].result, 'ok');
  });
  it('deduplicates a same-id tool call even when earlier reattach content diverges', () => {
    const pending = tool('read', { toolCallId: 'call_read', args: { path: '/tmp/a' } });
    const completed = tool('read', { toolCallId: 'call_read', args: { path: '/tmp/a' }, result: 'ok' });

    const out = mergeReattachedSegments([think('旧进度'), pending], [think('新进度'), completed]);
    const calls = out.filter((seg): seg is Extract<ContentSegment, { type: 'tool-call' }> => seg.type === 'tool-call' && seg.toolCallId === 'call_read');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].result, 'ok');
  });
});

describe('contentFromSegments', () => {
  it('joins text segments, ignores others', () => {
    assert.equal(contentFromSegments([txt('a'), tool('t'), txt('b')]), 'ab');
  });
  it('returns fallback when no text', () => {
    assert.equal(contentFromSegments([tool('t')], 'fb'), 'fb');
  });
});

describe('isEmptyAssistantPlaceholder', () => {
  it('true for empty assistant message', () => {
    assert.equal(isEmptyAssistantPlaceholder({ role: 'assistant', content: '   ', segments: [] }), true);
  });
  it('false when there is content or segments or non-assistant', () => {
    assert.equal(isEmptyAssistantPlaceholder({ role: 'assistant', content: 'hi', segments: [] }), false);
    assert.equal(isEmptyAssistantPlaceholder({ role: 'assistant', content: '', segments: [txt('x')] }), false);
    assert.equal(isEmptyAssistantPlaceholder({ role: 'user', content: '', segments: [] }), false);
  });
});

describe('isEmptyUserMessage', () => {
  it('true for empty user without attachments', () => {
    assert.equal(isEmptyUserMessage({ role: 'user', content: '' }), true);
    assert.equal(isEmptyUserMessage({ role: 'user', content: '   ', attachments: [] }), true);
  });
  it('false when text or attachments present, or role is not user', () => {
    assert.equal(isEmptyUserMessage({ role: 'user', content: 'hi' }), false);
    assert.equal(isEmptyUserMessage({ role: 'user', content: '', attachments: [{ name: 'a.png' } as never] }), false);
    assert.equal(isEmptyUserMessage({ role: 'assistant', content: '' }), false);
  });
});


describe('groupSegments', () => {
  it('merges consecutive thinking and groups consecutive tool-calls', () => {
    const groups = groupSegments([think('a'), think('b'), tool('t1'), tool('t2'), txt('done')]);
    assert.equal(groups.length, 3);
    assert.deepEqual(groups[0], { type: 'thinking', content: 'ab' });
    assert.equal(groups[1].type, 'tool-call-group');
    assert.equal((groups[1] as { calls: unknown[] }).calls.length, 2);
    assert.deepEqual(groups[2], { type: 'text', content: 'done' });
  });
  it('keeps thinking and visible text in their original timeline order', () => {
    const groups = groupSegments([txt('请选择方案 A/B/C'), think('内部分析')]);

    assert.deepEqual(groups[0], { type: 'text', content: '请选择方案 A/B/C' });
    assert.deepEqual(groups[1], { type: 'thinking', content: '内部分析' });
  });
  it('preserves the full thinking / text / tool-call sequence without reordering', () => {
    const groups = groupSegments([tool('first'), think('a'), tool('second'), txt('done'), think('b')]);

    assert.equal(groups.length, 5);
    assert.equal(groups[0].type, 'tool-call-group');
    assert.equal((groups[0] as { calls: Array<{ tool: string }> }).calls[0].tool, 'first');
    assert.deepEqual(groups[1], { type: 'thinking', content: 'a' });
    assert.equal(groups[2].type, 'tool-call-group');
    assert.equal((groups[2] as { calls: Array<{ tool: string }> }).calls[0].tool, 'second');
    assert.deepEqual(groups[3], { type: 'text', content: 'done' });
    assert.deepEqual(groups[4], { type: 'thinking', content: 'b' });
  });
  it('does not merge thinking blocks across tool-call groups', () => {
    const groups = groupSegments([
      think('before tool'),
      tool('read_file', { toolCallId: 'call_read', result: 'ok' }),
      think('after tool'),
      txt('final answer'),
    ]);

    assert.equal(groups.length, 4);
    assert.deepEqual(groups[0], { type: 'thinking', content: 'before tool' });
    assert.equal(groups[1].type, 'tool-call-group');
    assert.deepEqual(groups[2], { type: 'thinking', content: 'after tool' });
    assert.deepEqual(groups[3], { type: 'text', content: 'final answer' });
  });
  it('carries displayName through to the grouped tool call (MCP title passthrough)', () => {
    // 回归：MCP 工具卡标题。后端注入的 displayName 必须经分组保留到 ToolCallLegacy，
    // 渲染层才能显示「服务名: 工具名」而不是裸 capability 名 mcp__server__tool。
    const groups = groupSegments([
      tool('mcp__dingtalk__create_document', { displayName: '钉钉文档: create_document' }),
    ]);
    assert.equal(groups[0].type, 'tool-call-group');
    const call = (groups[0] as { calls: Array<{ tool: string; displayName?: string | null }> }).calls[0];
    assert.equal(call.tool, 'mcp__dingtalk__create_document');
    assert.equal(call.displayName, '钉钉文档: create_document');
  });
  it('carries toolCallId through to grouped tool calls for fallback diagnostics', () => {
    const groups = groupSegments([
      tool('bash', { toolCallId: 'tool_call_empty_args', args: {}, result: 'ok' }),
    ]);
    assert.equal(groups[0].type, 'tool-call-group');
    const call = (groups[0] as { calls: Array<{ toolCallId?: string }> }).calls[0];
    assert.equal(call.toolCallId, 'tool_call_empty_args');
  });
});

describe('splitFinalTextGroup', () => {
  it('keeps only the final text outside and preserves all earlier groups in timeline order', () => {
    const groups = groupSegments([think('thinking-1'), txt('正文-1'), think('thinking-2'), txt('正文-2')]);
    const split = splitFinalTextGroup(groups);

    assert.deepEqual(split.historyGroups, [
      { type: 'thinking', content: 'thinking-1' },
      { type: 'text', content: '正文-1' },
      { type: 'thinking', content: 'thinking-2' },
    ]);
    assert.deepEqual(split.finalTextGroups, [{ type: 'text', content: '正文-2' }]);
  });

  it('keeps the whole timeline in history when there is no final text', () => {
    const groups = groupSegments([think('thinking'), tool('bash')]);
    const split = splitFinalTextGroup(groups);

    assert.equal(split.historyGroups, groups);
    assert.deepEqual(split.finalTextGroups, []);
  });

  it('keeps the last non-empty text outside when timeline ends with a tool call', () => {
    const groups = groupSegments([
      think('thinking'),
      txt('计划说明：将按三步修复折叠丢失'),
      tool('goal_create_plan'),
    ]);
    const split = splitFinalTextGroup(groups);

    assert.deepEqual(split.finalTextGroups, [
      { type: 'text', content: '计划说明：将按三步修复折叠丢失' },
    ]);
    assert.deepEqual(
      split.historyGroups.map((group) => group.type),
      ['thinking', 'tool-call-group'],
    );
  });

  it('skips trailing empty text and still exposes the last non-empty text before tools', () => {
    const groups = groupSegments([
      txt('最终说明'),
      txt(''),
      tool('goal_create_plan'),
      txt('   '),
    ]);
    const split = splitFinalTextGroup(groups);

    assert.deepEqual(split.finalTextGroups, [{ type: 'text', content: '最终说明' }]);
    assert.deepEqual(
      split.historyGroups.map((group) => group.type),
      ['text', 'tool-call-group', 'text'],
    );
  });

  it('keeps all non-empty text outside when keepAllTextOutside (pending interaction context)', () => {
    const groups = groupSegments([
      think('thinking'),
      tool('bash'),
      txt('布局结构约定…'),
      txt(''),
      tool('request_user_input'),
    ]);
    const split = splitFinalTextGroup(groups, { keepAllTextOutside: true });

    assert.deepEqual(
      split.historyGroups.map((group) => group.type),
      ['thinking', 'tool-call-group', 'tool-call-group'],
    );
    assert.deepEqual(split.finalTextGroups, [{ type: 'text', content: '布局结构约定…' }]);
  });

  it('keeps multiple text groups outside in order under keepAllTextOutside', () => {
    const groups = groupSegments([
      think('t'),
      txt('设计说明'),
      tool('bash'),
      txt('§1 是否同意？'),
      tool('request_user_input'),
    ]);
    const split = splitFinalTextGroup(groups, { keepAllTextOutside: true });

    assert.deepEqual(split.finalTextGroups, [
      { type: 'text', content: '设计说明' },
      { type: 'text', content: '§1 是否同意？' },
    ]);
    assert.ok(split.historyGroups.every((group) => group.type !== 'text'));
  });
});

describe('getTextContent', () => {
  it('concatenates only text segments', () => {
    assert.equal(getTextContent([txt('a'), think('z'), txt('b')]), 'ab');
  });
});

describe('migrateToSegments', () => {
  it('returns undefined for empty inputs', () => {
    assert.equal(migrateToSegments('', undefined), undefined);
  });
  it('emits tool-call then text', () => {
    const out = migrateToSegments('body', [{ tool: 't', args: { a: 1 }, result: 'r' }]);
    // displayName 随 tool-call 段透传；旧历史无此字段时为 undefined。
    assert.deepEqual(out, [
      { type: 'tool-call', tool: 't', displayName: undefined, args: { a: 1 }, result: 'r' },
      { type: 'text', content: 'body' },
    ]);
  });
  it('preserves legacy toolCallId when migrating old toolCalls', () => {
    const out = migrateToSegments('', [{ tool: 'bash', args: {}, result: 'ok', toolCallId: 'call_1' }]);
    assert.deepEqual(out, [
      { type: 'tool-call', tool: 'bash', displayName: undefined, args: {}, result: 'ok', toolCallId: 'call_1' },
    ]);
  });
});

describe('parseSerializedToolSegments', () => {
  it('returns undefined when no [Tool call:] marker', () => {
    assert.equal(parseSerializedToolSegments('plain text'), undefined);
  });
  it('parses a call with result and surrounding text', () => {
    const content = 'pre\n[Tool call: search {"q":"x"}]\n[Tool result]\nfound it';
    const out = parseSerializedToolSegments(content);
    assert.ok(out);
    const call = out!.find((s) => s.type === 'tool-call') as Extract<ContentSegment, { type: 'tool-call' }>;
    assert.equal(call.tool, 'search');
    assert.deepEqual(call.args, { q: 'x' });
    assert.equal(call.result, 'found it');
  });
  it('marks a call without result marker as synthetic', () => {
    const content = '[Tool call: run {"a":1}]\ntrailing';
    const out = parseSerializedToolSegments(content);
    const call = out!.find((s) => s.type === 'tool-call') as Extract<ContentSegment, { type: 'tool-call' }>;
    assert.equal(call.synthetic, true);
    assert.equal(call.result, undefined);
  });
  it('falls back to raw args when JSON is invalid', () => {
    const content = '[Tool call: run not-json]\n[Tool result]\nok';
    const out = parseSerializedToolSegments(content);
    const call = out!.find((s) => s.type === 'tool-call') as Extract<ContentSegment, { type: 'tool-call' }>;
    assert.deepEqual(call.args, { raw: 'not-json' });
  });
});

describe('markDanglingToolCallsInterrupted', () => {
  const toolOf = (segs: ContentSegment[], i: number) =>
    segs[i] as Extract<ContentSegment, { type: 'tool-call' }>;

  it('fills result on a tool-call still pending (result===undefined) so it leaves the spinner state', () => {
    const input: ContentSegment[] = [txt('hi'), tool('bash')];
    const out = markDanglingToolCallsInterrupted(input, 'INTERRUPTED');
    assert.equal(toolOf(out, 1).result, 'INTERRUPTED');
    // 文本段保持不变
    assert.deepEqual(out[0], txt('hi'));
  });

  it('does not touch tool-call segments that already have a result', () => {
    const input: ContentSegment[] = [tool('bash', { result: 'done' })];
    const out = markDanglingToolCallsInterrupted(input, 'INTERRUPTED');
    assert.equal(toolOf(out, 0).result, 'done');
  });

  it('skips synthetic tool-call segments (parsed from historical text, not live execution)', () => {
    const input: ContentSegment[] = [tool('run', { synthetic: true })];
    const out = markDanglingToolCallsInterrupted(input, 'INTERRUPTED');
    assert.equal(toolOf(out, 0).result, undefined);
  });

  it('returns the same array reference when nothing needs patching (lets caller skip setState)', () => {
    const input: ContentSegment[] = [txt('x'), tool('bash', { result: 'ok' })];
    const out = markDanglingToolCallsInterrupted(input, 'INTERRUPTED');
    assert.equal(out, input);
  });

  it('does not mutate the original segments (pure)', () => {
    const original = tool('bash');
    const input: ContentSegment[] = [original];
    markDanglingToolCallsInterrupted(input, 'INTERRUPTED');
    assert.equal((original as Extract<ContentSegment, { type: 'tool-call' }>).result, undefined);
  });

  it('handles undefined segments by returning an empty array', () => {
    const out = markDanglingToolCallsInterrupted(undefined, 'INTERRUPTED');
    assert.deepEqual(out, []);
  });

  it('patches multiple dangling tool-calls in one pass', () => {
    const input: ContentSegment[] = [tool('a'), tool('b', { result: 'ok' }), tool('c')];
    const out = markDanglingToolCallsInterrupted(input, 'X');
    assert.equal(toolOf(out, 0).result, 'X');
    assert.equal(toolOf(out, 1).result, 'ok');
    assert.equal(toolOf(out, 2).result, 'X');
  });
});
