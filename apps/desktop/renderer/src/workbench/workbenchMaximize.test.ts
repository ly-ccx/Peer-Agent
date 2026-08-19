import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const contextSource = readFileSync(new URL('./WorkbenchContext.tsx', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('./WorkbenchPanel.tsx', import.meta.url), 'utf8');
const workbenchStyles = readFileSync(new URL('../styles/workbench.css', import.meta.url), 'utf8');
const drawerStyles = readFileSync(new URL('../styles/task-overview.css', import.meta.url), 'utf8');

describe('workbench maximize behavior', () => {
  it('owns one transient maximize state in Workbench Context and preserves the stored width', () => {
    assert.match(contextSource, /const \[maximized, setMaximizedState\] = useState\(false\)/);
    assert.match(contextSource, /setMaximized: \(maximized: boolean\) => void/);
    assert.match(contextSource, /document\.documentElement\.dataset\.workbenchMaximized/);
    assert.doesNotMatch(contextSource, /maximized[\s\S]{0,80}schedulePersist\(\)/);
  });

  it('renders an accessible maximize and restore toggle and disables resizing while maximized', () => {
    assert.match(panelSource, /aria-label=\{maximized \?/);
    assert.match(panelSource, /aria-pressed=\{maximized\}/);
    assert.match(panelSource, /onClick=\{\(\) => setMaximized\(!maximized\)\}/);
    assert.match(panelSource, /\{open && !maximized \? \(/);
    assert.match(panelSource, /maximized \? '100%' : `\$\{width\}px`/);
  });

  it('lets the root sidebar and chat yield while the workbench occupies the full content area', () => {
    assert.match(workbenchStyles, /:root\[data-workbench-maximized='true'\] \.app-layout/);
    assert.match(workbenchStyles, /grid-template-columns:\s*0 minmax\(0, 0\) minmax\(0, 1fr\)/);
    assert.match(workbenchStyles, /\.app-layout > :not\(\.workbench-panel\)[\s\S]*visibility:\s*hidden/);
    assert.match(workbenchStyles, /\.workbench-panel--maximized[\s\S]*width:\s*100% !important/);
  });

  it('applies the same yielding behavior inside conversation drawers', () => {
    assert.match(drawerStyles, /conversation-chat-drawer-shell:has\(> \.workbench-panel--maximized\)/);
    assert.match(drawerStyles, /conversation-chat-drawer__body[\s\S]*display:\s*none/);
    assert.match(drawerStyles, /\.workbench-panel--maximized[\s\S]*flex:\s*1 1 100%/);
  });

  it('keeps a visible left radius on the conversation drawer outline', () => {
    assert.match(
      drawerStyles,
      /\.conversation-chat-drawer \{[\s\S]*?border-radius:\s*var\(--radius-xl\) 0 0 var\(--radius-xl\);/,
    );
    assert.match(
      drawerStyles,
      /\.conversation-result-drawer \{[\s\S]*?border-radius:\s*var\(--radius-xl\) 0 0 var\(--radius-xl\);/,
    );
  });
});
