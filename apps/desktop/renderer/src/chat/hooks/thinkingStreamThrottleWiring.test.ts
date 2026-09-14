import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * 接线守卫：节流只有真正挂在思考泵上才有意义。
 *
 * 这是「思考流式输出时整面界面卡住」的直接回归点——如果将来有人把思考泵改回默认
 * 逐帧写入，界面会重新以 60 次/秒整面重渲染，而纯函数层的测试仍然全绿。
 */
const routerSource = readFileSync(new URL('./useConversationStreamRouter.ts', import.meta.url), 'utf8');

describe('stream router typewriter wiring', () => {
  it('throttles the thinking pump so it stops writing on every frame', () => {
    assert.match(
      routerSource,
      /useTypewriterStream\(\s*appendActiveThinking,\s*THINKING_TYPEWRITER_OPTIONS,?\s*\)/,
    );
  });

  it('keeps the visible text pump on per-frame pacing', () => {
    assert.match(routerSource, /useTypewriterStream\(\s*appendActiveText,?\s*\)/);
  });

  it('uses handoff (not flush) for per-delta ordering so the throttle survives', () => {
    // 逐 delta 的跨泵排序必须走 handoff：flush 会停泵并把节奏退回「首字立即写」，
    // 于是每个 delta 都触发一次整面重渲染，节流形同虚设。
    assert.match(routerSource, /handoffThinkingTypewriter\(\)/);
    assert.match(routerSource, /handoffTextTypewriter\(\)/);

    // 正文/思考 delta 的处理分支里不允许再出现跨泵 flush()。
    const deltaHandlers = routerSource.slice(
      routerSource.indexOf('const offDelta = clientApi.onChatStreamDelta'),
      routerSource.indexOf('const offThinking = clientApi.onChatStreamThinking'),
    );
    assert.doesNotMatch(
      deltaHandlers,
      /(text|thinking)Typewriter\.flush\(\)/,
      'text-delta handler must not force-flush the other pump',
    );
  });

  it('still flushes on real closure boundaries (session switch / stream end)', () => {
    // flush() 仍用于「结束/切会话」这类真收口：这些点必须真的写并把泵停掉。
    assert.match(routerSource, /flushTextTypewriter\(\)/);
    assert.match(routerSource, /flushThinkingTypewriter\(\)/);
  });
});
