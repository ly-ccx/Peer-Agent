import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { checkUiSource, checkUiTree } from './check-ui-conventions.mjs';

test('rejects hardcoded CSS, Tailwind and inline radii and legacy aliases', () => {
  for (const source of ['.button { border-radius: 9px; }', '.x { @apply rounded-lg; }', '.x { border-radius: var(--za-radius); }'])
    assert.ok(checkUiSource('view.css', source).length);
  assert.ok(checkUiSource('View.tsx', '<button style={{ borderRadius: 10 }} className="rounded-[12px]" />').length);
});
test('permits semantic geometry, joined edges and nested borders', () => {
  assert.deepEqual(checkUiSource('view.css', '.panel { border-radius: var(--ui-radius-panel); } .x { border-radius: calc(var(--ui-radius-panel) - 1px) calc(var(--ui-radius-panel) - 1px) 0 0; } .edge { border-radius: 0; }'), []);
  assert.deepEqual(checkUiSource('View.tsx', '<button style={{ borderRadius: "var(--ui-radius-control)" }} className="rounded-[var(--ui-radius-control)]" />'), []);
});
test('rejects glyph, CSS, font and native disclosure stand-ins', () => {
  for (const source of ['<button>×</button>', '<button>{"×"}</button>', '<button><span>×</span></button>',
    '<button>{active ? "✓" : "×"}</button>', '<button>🔍</button>', '<button>{`⚙️`}</button>',
    '<span className="icon">→</span>', '<details><summary>Preview</summary></details>'])
    assert.ok(checkUiSource('View.tsx', source).length);
  for (const source of ['.chevron { border-right: 1px solid; transform: rotate(45deg); }', '.spinner { border: 2px solid currentColor; }',
    '.bot-spin { border: 1.5px solid currentColor; border-right-color: transparent; }',
    '.chat-thread-loading-mark { border: 2px solid gray; border-top-color: blue; animation: motion-spin 0.8s linear infinite; }',
    '.icon { font-family: "Material Icons"; }'])
    assert.ok(checkUiSource('view.css', source).length);
});
test('rejects undefined semantic radius tokens in CSS and inline styles', () => {
  assert.ok(checkUiSource('View.tsx', '<button style={{ borderRadius: "var(--ui-radius-missing)" }} />').length);
  assert.ok(checkUiSource('view.css', '.panel { border-radius: var(--ui-radius-missing); }').length);
});
test('does not mistake keyboard notation, diff signs, prose or user data for icons', () => {
  assert.deepEqual(checkUiSource('View.tsx', '<><kbd>↑</kbd><code>+ −</code><span>10:00 → 11:00</span><div>{userContent}</div><button>Next step</button><summary><PeerIcon name="chevronRight" />Preview</summary></>'), []);
  assert.deepEqual(checkUiSource('view.css', '.diff-add::before { content: "+ "; } .status-dot { border-radius: var(--ui-radius-circle); } .tooltip-arrow { border: 1px solid; }'), []);
  assert.deepEqual(checkUiSource('View.tsx', '<><button aria-label="×"><kbd>{"↑"}</kbd><code>+</code>Wait…</button><span>{"🔍"}</span><button>{userContent}</button></>'), []);
  assert.deepEqual(checkUiSource('View.tsx', '<button><span>+{additions}</span>{!label.includes("→") ? <PeerIcon name="arrowRight" /> : null}</button>'), []);
  assert.deepEqual(checkUiSource('view.css', '.tool-progress-spinner { background: currentColor; border-radius: var(--ui-radius-circle); animation: motion-pulse 1s infinite; }'), []);
});
test('renderer satisfies the shared radius and SVG rules', () => assert.deepEqual(checkUiTree(), []));

test('message/composer and their insets have explicit role relationships', () => {
  const css = readFileSync(new URL('../apps/desktop/renderer/src/styles/tokens.css', import.meta.url), 'utf8');
  const expected = { detail: '2px', chip: '4px', 'control-compact': '6px', control: '8px', row: '8px', panel: '12px',
    modal: '16px', inset: '8px', message: '16px', composer: '18px', pill: '999px', circle: '50%', avatar: '25%' };
  for (const [role, value] of Object.entries(expected)) assert.ok(css.includes(`--ui-radius-${role}: ${value};`));
  for (const alias of ['radius-', 'za-radius', 'control-radius', 'surface-radius', 'composer-radius']) {
    for (const match of css.matchAll(new RegExp(`--${alias}[\\w-]*:\\s*([^;]+);`, 'g')))
      assert.match(match[1], /^var\(--ui-radius-/);
  }
});
