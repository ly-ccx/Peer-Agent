// Pixel assay in the smoke test's isolated Electron window (never the user's webview).
// Calibration patterns are test-only, saved separately from ordinary UI screenshots.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function checkMonitorGlassPixels(page, root, theme) {
  const samples = [];
  const saved = await page.locator('.task-monitor-card').evaluate((card) => {
    const rail = card.closest('.task-monitor-rail');
    const pattern = document.createElement('div');
    pattern.id = 'glass-calibration';
    pattern.style.cssText = 'position:absolute;inset:0;z-index:24;pointer-events:none';
    rail.before(pattern);
    const style = document.createElement('style');
    style.id = 'glass-calibration-style';
    style.textContent = '.task-monitor-card > * { visibility: hidden !important; }';
    document.head.append(style);
    return { style: card.getAttribute('style') };
  });
  try {
    for (const phase of ['entering', 'settled']) {
      const state = await page.locator('.task-monitor-card').evaluate((card, phase) => {
        const rail = card.closest('.task-monitor-rail');
        // Restart the actual CSS animation: a backwards-filled finished animation
        // is otherwise absent from getAnimations(), giving a false entering pass.
        rail.classList.remove('motion-enter-slide-inline');
        void card.offsetWidth;
        rail.classList.add('motion-enter-slide-inline');
        void card.offsetWidth;
        const animation = [...rail.getAnimations(), ...card.getAnimations()]
          .find((animation) => animation.animationName === 'motion-enter-slide-inline');
        if (!animation) throw new Error('expected real CSS entry animation');
        animation.pause();
        animation.currentTime = Number(animation.effect.getTiming().duration) * (phase === 'entering' ? 0.55 : 1);
        const ancestors = [];
        for (let node = card.parentElement; node; node = node.parentElement) {
          const s = getComputedStyle(node);
          ancestors.push({ node: node.className, opacity: s.opacity, transform: s.transform, filter: s.filter,
            backdropFilter: s.backdropFilter, animation: s.animationName, fill: s.animationFillMode });
        }
        return { ancestors, background: getComputedStyle(card).backgroundColor, filter: getComputedStyle(card).backdropFilter };
      }, phase);
      const box = await page.locator('.task-monitor-card').boundingBox();
      const clip = { x: Math.ceil(box.x + 32), y: Math.ceil(box.y + 48), width: Math.floor(box.width - 64), height: Math.floor(box.height - 96) };
      assert.ok(clip.width > 40 && clip.height > 40, 'calibration crop fits actual card');
      const capture = async (pattern, filter, label) => {
        await page.evaluate(({ pattern, filter, style }) => {
          const card = document.querySelector('.task-monitor-card');
          if (style === null) card.removeAttribute('style'); else card.setAttribute('style', style);
          if (!filter) {
            card.style.setProperty('backdrop-filter', 'none', 'important');
            card.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
          }
          document.querySelector('#glass-calibration').style.background = pattern;
        }, { pattern, filter, style: saved.style });
        await page.waitForTimeout(80);
        const filename = path.join(root, `calibration-${theme}-${phase}-${label}.png`);
        const bytes = await page.screenshot({ path: filename, clip });
        return bytes.toString('base64');
      };
      const stripes = 'repeating-linear-gradient(90deg, #101010 0px 12px, #f0f0f0 12px 24px)';
      const blurred = await capture(stripes, true, 'blur');
      const unblurred = await capture(stripes, false, 'no-filter-control');
      const cool = await capture('#306fd2', true, 'cool-background');
      const warm = await capture('#e3a04b', true, 'warm-background');
      const pixels = await page.evaluate(async ({ blurred, unblurred, cool, warm }) => {
        const decode = async (base64) => {
          const image = new Image(); image.src = 'data:image/png;base64,' + base64; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
          return { width: image.width, data: context.getImageData(0, 0, image.width, image.height).data };
        };
        const [b, u, c, w] = await Promise.all([blurred, unblurred, cool, warm].map(decode));
        const difference = (a, b) => {
          let sum = 0;
          for (let i = 0; i < a.data.length; i += 4) for (let j = 0; j < 3; j++) sum += Math.abs(a.data[i + j] - b.data[i + j]);
          return sum / (a.data.length / 4 * 3);
        };
        const horizontalEdges = ({ width, data }) => {
          let sum = 0, count = 0;
          for (let i = 4; i < data.length; i += 4) {
            if ((i / 4) % width === 0) continue;
            for (let j = 0; j < 3; j++) sum += Math.abs(data[i + j] - data[i - 4 + j]);
            count += 3;
          }
          return sum / count;
        };
        return { blurDifference: difference(b, u), blurredEdges: horizontalEdges(b), sharpEdges: horizontalEdges(u), backgroundResponse: difference(c, w) };
      }, { blurred, unblurred, cool, warm });
      const sample = { theme, phase, state, pixels };
      samples.push(sample);
      console.log('GLASS_PIXELS', JSON.stringify(sample));
    }
  } finally {
    await page.evaluate(({ style }) => {
      const card = document.querySelector('.task-monitor-card');
      if (card) { if (style === null) card.removeAttribute('style'); else card.setAttribute('style', style); }
      document.querySelector('#glass-calibration')?.remove();
      document.querySelector('#glass-calibration-style')?.remove();
    }, saved);
    await writeFile(path.join(root, `glass-pixels-${theme}.json`), JSON.stringify(samples, null, 2));
  }
  for (const { phase, pixels: p } of samples) {
    assert.ok(p.blurDifference > 2, `${theme}/${phase}: filter must change pixels, got ${p.blurDifference}`);
    // During fade-in, the transparent animated surface also exposes unfiltered
    // background. Require attenuation then, and stronger diffusion at full opacity.
    const edgeRatioLimit = phase === 'entering' ? 0.65 : 0.45;
    assert.ok(p.sharpEdges > 0.5 && p.blurredEdges < p.sharpEdges * edgeRatioLimit,
      `${theme}/${phase}: blur must suppress sharp edges: ${JSON.stringify(p)}`);
    assert.ok(p.backgroundResponse > 12, `${theme}/${phase}: underlying colors must transmit: ${p.backgroundResponse}`);
  }
  return samples;
}
