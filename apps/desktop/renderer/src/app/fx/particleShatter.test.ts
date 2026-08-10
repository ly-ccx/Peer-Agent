import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PARTICLE_SHATTER_SWEEP_MS,
  sampleParticlesFromImageData,
} from './particleShatter.ts';

function makeOpaqueImageData(width: number, height: number, fill = [240, 244, 247, 255]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    data[o] = fill[0]!;
    data[o + 1] = fill[1]!;
    data[o + 2] = fill[2]!;
    data[o + 3] = fill[3]!;
  }
  return { data, width, height, colorSpace: 'srgb' } as ImageData;
}

test('sampleParticlesFromImageData detonates from right to left', () => {
  // 宽 20 高 4 的实心矩形；固定 random 让 delay 只由 x 决定
  const image = makeOpaqueImageData(20, 4);
  const particles = sampleParticlesFromImageData(image, 20, 4, {
    gapCss: 2,
    sweepMs: PARTICLE_SHATTER_SWEEP_MS,
    random: () => 0,
  });

  assert.ok(particles.length > 4, 'should sample multiple particles');

  const byX = [...particles].sort((a, b) => a.x - b.x);
  const leftmost = byX[0]!;
  const rightmost = byX[byX.length - 1]!;
  assert.ok(
    rightmost.delay < leftmost.delay,
    `right delay (${rightmost.delay}) should be smaller than left delay (${leftmost.delay})`,
  );

  // 栅格采样最右列不一定落在 x=width，故右侧 delay 只需明显早于左侧
  assert.ok(
    rightmost.delay <= PARTICLE_SHATTER_SWEEP_MS * 0.25,
    `rightmost delay should be early in the sweep, got ${rightmost.delay}`,
  );
  assert.ok(
    leftmost.delay >= PARTICLE_SHATTER_SWEEP_MS * 0.8,
    `leftmost delay should approach sweep window, got ${leftmost.delay}`,
  );
});

test('sampleParticlesFromImageData skips fully transparent pixels', () => {
  const image = makeOpaqueImageData(8, 8, [0, 0, 0, 0]);
  const particles = sampleParticlesFromImageData(image, 8, 8, {
    gapCss: 2,
    random: () => 0,
  });
  assert.equal(particles.length, 0);
});
