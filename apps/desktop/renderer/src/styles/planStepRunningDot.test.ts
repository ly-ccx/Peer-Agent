import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const CSS_PATH = new URL('./task-overview.css', import.meta.url);

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing ${selector}`);
  const bodyStart = css.indexOf('{', start) + 1;
  const bodyEnd = css.indexOf('}', bodyStart);
  assert.notEqual(bodyEnd, -1, `unterminated rule for ${selector}`);
  return css.slice(bodyStart, bodyEnd);
}

// 进行中/当前子任务圆点必须"活着"：复用 motion.css 的 motion-ripple 基元，
// 动画挂在 ::after 上（transform/opacity 走合成层），圆点本体保持静止。
test('running plan-step dot animates via the shared motion-ripple primitive', async () => {
  const css = await readFile(CSS_PATH, 'utf8');

  const ring = ruleBody(
    css,
    '.task-overview-plan-step.is-running .task-overview-plan-step-marker::after,\n' +
      '  .task-overview-plan-step.is-current .task-overview-plan-step-marker::after',
  );
  assert.match(ring, /animation:\s*motion-ripple/);
  assert.match(ring, /content:\s*''/);

  const host = ruleBody(
    css,
    '.task-overview-plan-step.is-running .task-overview-plan-step-marker,\n' +
      '  .task-overview-plan-step.is-current .task-overview-plan-step-marker',
  );
  // ::after 需要相对定位宿主，且不能被裁掉
  assert.match(host, /position:\s*relative/);
  assert.match(host, /overflow:\s*visible/);
  assert.match(host, /--motion-ripple-color:/);
  // 本体自身不跑动画，避免持续 box-shadow 重绘
  assert.doesNotMatch(host, /animation:/);
});

test('running plan-step dot ring is disabled under prefers-reduced-motion', async () => {
  const css = await readFile(CSS_PATH, 'utf8');

  const reduceStart = css.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.notEqual(reduceStart, -1, 'missing prefers-reduced-motion block');
  const reduceBlock = css.slice(reduceStart);

  const markerRule = reduceBlock.lastIndexOf('.task-overview-plan-step.is-current .task-overview-plan-step-marker::after');
  assert.notEqual(markerRule, -1, 'reduced-motion block must silence the plan-step ring');

  const bodyStart = reduceBlock.indexOf('{', markerRule) + 1;
  const bodyEnd = reduceBlock.indexOf('}', bodyStart);
  const body = reduceBlock.slice(bodyStart, bodyEnd);
  assert.match(body, /animation:\s*none/);
});
