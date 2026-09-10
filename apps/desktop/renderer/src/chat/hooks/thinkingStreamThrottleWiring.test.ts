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
});
