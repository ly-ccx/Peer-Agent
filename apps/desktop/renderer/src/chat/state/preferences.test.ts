import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_EFFORT_LEVELS,
  OPENAI_EFFORT_LEVELS,
  normalizeEffortLevels,
} from './preferences.ts';

describe('normalizeEffortLevels', () => {
  it('falls back to BASE_EFFORT_LEVELS when input is undefined / null / empty', () => {
    assert.deepEqual(normalizeEffortLevels(undefined), BASE_EFFORT_LEVELS);
    assert.deepEqual(normalizeEffortLevels(null), BASE_EFFORT_LEVELS);
    assert.deepEqual(normalizeEffortLevels([]), BASE_EFFORT_LEVELS);
  });

  it('keeps Anthropic/OpenAI native five levels and prepends off (channel omits off)', () => {
    // channel 的 effortLevels 不含 off，归一化后应补齐 off 并置顶，得到完整五档。
    const result = normalizeEffortLevels(['low', 'default', 'high', 'xhigh']);
    assert.deepEqual(result, OPENAI_EFFORT_LEVELS);
    assert.equal(result[0], 'off');
  });

  it('keeps four levels for a channel without xhigh', () => {
    const result = normalizeEffortLevels(['low', 'default', 'high']);
    assert.deepEqual(result, ['off', 'low', 'default', 'high']);
  });

  it('dedupes off when channel already includes it (e.g. Google off/default)', () => {
    const result = normalizeEffortLevels(['off', 'default']);
    assert.deepEqual(result, ['off', 'default']);
  });

  it('always sorts to canonical order off→low→default→high→xhigh', () => {
    const result = normalizeEffortLevels(['xhigh', 'high', 'low', 'default']);
    assert.deepEqual(result, ['off', 'low', 'default', 'high', 'xhigh']);
  });

  it('drops invalid values; falls back to BASE when only off would remain', () => {
    // 全部非法 → 仅剩补齐的 off（length<=1）→ 回退四档，避免渲染出只有"关闭思考"的无意义菜单。
    assert.deepEqual(normalizeEffortLevels(['bogus', 'nope']), BASE_EFFORT_LEVELS);
  });

  it('drops invalid values but keeps valid ones', () => {
    const result = normalizeEffortLevels(['low', 'bogus', 'high']);
    assert.deepEqual(result, ['off', 'low', 'high']);
  });
});
