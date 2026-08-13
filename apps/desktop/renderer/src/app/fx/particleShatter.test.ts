import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  PARTICLE_SHATTER_MAX_PARTICLES,
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

const readSource = () =>
  readFile(new URL('./particleShatter.ts', import.meta.url), 'utf8');

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

test('sampleParticlesFromImageData caps oversized captures by widening the grid', () => {
  const image = makeOpaqueImageData(800, 800);
  const particles = sampleParticlesFromImageData(image, 800, 800, {
    gapCss: 2.6,
    random: () => 0,
  });
  assert.ok(
    particles.length <= PARTICLE_SHATTER_MAX_PARTICLES,
    `expected <= ${PARTICLE_SHATTER_MAX_PARTICLES} particles, got ${particles.length}`,
  );
  assert.ok(particles.length > 200, `expected a visible shatter field, got ${particles.length}`);
});

test('capture path clips overflowing clone content to the visible viewport', async () => {
  const source = await readSource();
  assert.match(source, /clipCloneToVisibleViewport/);
  assert.match(source, /scrollHeight > live\.clientHeight/);
  assert.match(source, /cloned\.style\.height = `\$\{Math\.max\(1, live\.clientHeight\)\}px`/);
  assert.doesNotMatch(source, /ctx\.save\(\)/);
  assert.doesNotMatch(source, /ctx\.rotate\(p\.rot\)/);
});

test('capture path rehydrates document theme attrs into foreignObject wrapper', async () => {
  const source = await readSource();
  assert.match(source, /readDocumentThemeAttrs/);
  assert.match(source, /data-theme=\"\$\{themeAttrs\.theme\}\"/);
  assert.match(source, /data-theme-mode=\"\$\{themeAttrs\.themeMode\}\"/);
  assert.match(source, /data-palette=\"\$\{themeAttrs\.palette\}\"/);
  assert.match(
    source,
    /<div xmlns=\"http:\/\/www\.w3\.org\/1999\/xhtml\" \$\{themeAttrText\}/,
  );
});

test('fallback particles read theme tokens instead of hard-coded dark fill', async () => {
  const source = await readSource();
  assert.doesNotMatch(source, /#181f29/);
  assert.match(source, /getComputedStyle/);
  assert.match(source, /readThemeCssColor\('--za-surface-0'/);
  assert.match(source, /readThemeCssColor\(\s*'--za-line'/);
  assert.match(source, /isDark \? '#1E232C' : '#F7F9FC'/);
});
