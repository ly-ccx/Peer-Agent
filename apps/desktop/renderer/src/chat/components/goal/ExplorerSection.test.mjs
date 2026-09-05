import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../GoalPlanPanel.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../styles/goal-panel.css', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('<details className="goal-runner-explorers"'), source.indexOf('</details>', source.indexOf('<details className="goal-runner-explorers"')));

test('background investigation keeps native details/summary semantics with a decorative SVG', () => {
  assert.match(section, /<summary>/);
  assert.match(section, /<svg[^>]+className="goal-runner-explorer-chevron"[^>]+aria-hidden="true"[^>]+focusable="false"/);
  assert.match(section, /<path[^>]+stroke="currentColor"/);
  assert.doesNotMatch(section, /[▶▼▸▾]/);
  assert.match(css, /\.goal-runner-explorers > summary\s*\{[^}]*list-style: none/s);
  assert.match(css, /summary::-webkit-details-marker\s*\{\s*display: none/);
});

for (const [selector, angle] of [
  ['.goal-runner-explorer-chevron', 0],
  ['.goal-runner-explorers[open] > summary .goal-runner-explorer-chevron', 90],
]) {
  test(`SVG direction follows native open state: ${angle} degrees`, () => {
    const rule = css.slice(css.indexOf(`${selector} {`)).split('}')[0];
    assert.ok(rule.includes(`transform: rotate(${angle}deg)`));
  });
}

test('queued and running remain distinct localized states', () => {
  const labels = source.slice(source.indexOf('function explorerStatusLabel'), source.indexOf('function verifierStatusLabel'));
  assert.match(labels, /queued: '排队中'/);
  assert.match(labels, /running: '调查中'/);
  assert.match(labels, /completed: '已完成'/);
});
