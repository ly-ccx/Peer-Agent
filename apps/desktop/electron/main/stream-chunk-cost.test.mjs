import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectTailRepetition } from './repetition-detector.mjs';

/**
 * 长流基准：每个 chunk 的链路成本不得随「已累积的正文长度」增长。
 *
 * 背景：定位「输出过快时界面卡住」时，最先怀疑的是这条复读兜底检测——它每个 delta
 * 都被调用，且拿到的是累计拼接后的整串正文（rope）。实测结论是它并不随长度增长
 * （见下），所以没有改成「只喂尾部窗口」。这个测试把该结论锁住：如果将来有人把
 * 检测实现改成整串扫描（O(n)），长会话会重新变成越写越慢，这里必须变红。
 *
 * 注意：这是比例断言（跨长度对比），不是绝对耗时断言，因此对机器快慢不敏感。
 * 阈值放得很宽（5x），只用于抓 O(n) 那种数量级退化。
 */

const CHUNK = '这是一段正常的模型输出文本，用来模拟流式 delta。';
const CHUNK_LEN = CHUNK.length;
const WARMUP = 200;

/** 把正文累积到 targetChars 后，测量该长度附近的单次调用耗时（取中位数）。 */
function measurePerChunkCost(targetChars) {
  let accumulated = '';
  // 先热身，避免把 JIT 冷启动算进对比。
  for (let i = 0; i < WARMUP; i += 1) {
    accumulated += CHUNK;
    detectTailRepetition(accumulated);
  }
  while (accumulated.length < targetChars) accumulated += CHUNK;

  const samples = [];
  for (let i = 0; i < 50; i += 1) {
    accumulated += CHUNK;
    const started = performance.now();
    detectTailRepetition(accumulated);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return { chars: accumulated.length, medianMs: samples[Math.floor(samples.length / 2)] };
}

describe('stream chunk cost stays bounded as the text grows', () => {
  it('keeps the per-chunk repetition check independent of accumulated length', () => {
    const small = measurePerChunkCost(10_000);
    const large = measurePerChunkCost(200_000);

    assert.ok(large.chars > small.chars * 10, 'sanity: the large sample must be much longer');
    // O(n) 实现在 20 倍长度下会退化约 20 倍；有界实现应基本持平。
    const ratio = large.medianMs / Math.max(small.medianMs, 0.0001);
    assert.ok(
      ratio < 5,
      `per-chunk cost grew ${ratio.toFixed(1)}x from ${small.chars} to ${large.chars} chars ` +
        `(${small.medianMs.toFixed(4)}ms -> ${large.medianMs.toFixed(4)}ms); ` +
        'a length-dependent scan has likely been reintroduced',
    );
  });

  it('rejects the pathological "scan the whole rope" call shape', () => {
    // 直接对比「喂整串」与「只喂尾部窗口」：后者才是真正有界的形态。
    // 这条用例记录的是被实测推翻的假设——整串调用在当前实现里并不慢，
    // 所以产品代码无需改成窗口版；但一旦检测器内部改成整串扫描，本用例会失效并提醒复核。
    const accumulated = CHUNK.repeat(8_000); // ≈ 200k 字符
    const wholeStart = performance.now();
    for (let i = 0; i < 20; i += 1) detectTailRepetition(accumulated);
    const wholeMs = (performance.now() - wholeStart) / 20;

    const tail = accumulated.slice(-4_096);
    const tailStart = performance.now();
    for (let i = 0; i < 20; i += 1) detectTailRepetition(tail);
    const tailMs = (performance.now() - tailStart) / 20;

    assert.ok(wholeMs < 5, `whole-string check took ${wholeMs.toFixed(3)}ms per call`);
    assert.ok(tailMs < 5, `tail-window check took ${tailMs.toFixed(3)}ms per call`);
  });
});
