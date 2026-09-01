import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const contextSource = readFileSync(new URL('./WorkbenchContext.tsx', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('./WorkbenchPanel.tsx', import.meta.url), 'utf8');
const workbenchStyles = readFileSync(new URL('../styles/workbench.css', import.meta.url), 'utf8');
const sidebarStyles = readFileSync(new URL('../styles/sidebar.css', import.meta.url), 'utf8');
const stylesEntry = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const drawerStyles = readFileSync(new URL('../styles/task-overview.css', import.meta.url), 'utf8');

function withoutLayerBlocks(css: string): string {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let out = '';
  let i = 0;
  while (i < source.length) {
    const layer = source.indexOf('@layer', i);
    if (layer < 0) {
      out += source.slice(i);
      break;
    }
    out += source.slice(i, layer);
    const brace = source.indexOf('{', layer);
    if (brace < 0) break;
    let depth = 1;
    let j = brace + 1;
    while (j < source.length && depth > 0) {
      if (source[j] === '{') depth += 1;
      else if (source[j] === '}') depth -= 1;
      j += 1;
    }
    i = j;
  }
  return out;
}

describe('workbench maximize behavior', () => {
  it('owns one transient maximize state in Workbench Context and preserves the stored width', () => {
    assert.match(contextSource, /const \[maximized, setMaximizedState\] = useState\(false\)/);
    assert.match(contextSource, /setMaximized: \(maximized: boolean\) => void/);
    assert.match(contextSource, /document\.documentElement\.dataset\.workbenchMaximized/);
    assert.doesNotMatch(contextSource, /maximized[\s\S]{0,80}schedulePersist\(\)/);
  });

  it('renders an accessible maximize and restore toggle and keeps the resizer while maximized', () => {
    assert.match(panelSource, /aria-label=\{maximized \?/);
    assert.match(panelSource, /aria-pressed=\{maximized\}/);
    assert.match(panelSource, /onClick=\{\(\) => setMaximized\(!maximized\)\}/);
    assert.match(panelSource, /\{open \? \(/);
    assert.match(panelSource, /maximized \? '100%' : `\$\{width\}px`/);
  });

  it('captures the workbench resizer pointer and clears the drag session on cancel', () => {
    assert.match(panelSource, /setPointerCapture\(pointerId\)/);
    assert.match(panelSource, /addEventListener\('pointercancel', onUp\)/);
    assert.match(panelSource, /addEventListener\('lostpointercapture', onUp\)/);
    assert.match(panelSource, /dataset\.workbenchResizing = 'true'/);
    assert.match(panelSource, /delete document\.documentElement\.dataset\.workbenchResizing/);
    assert.match(panelSource, /delete resizer\.dataset\.active/);
    assert.match(workbenchStyles, /data-workbench-resizing='true'\] \.app-layout/);
    assert.match(workbenchStyles, /data-workbench-resizing='true'\] \.workbench-panel/);
    assert.match(workbenchStyles, /data-workbench-resizing='true'\] \.browser-webview/);
    assert.match(sidebarStyles, /data-workbench-resizing='true'\] \.app-layout/);
  });

  it('lets the root sidebar and chat yield while the workbench occupies the full content area', () => {
    assert.match(workbenchStyles, /:root\[data-workbench-maximized='true'\] \.app-layout/);
    assert.match(workbenchStyles, /grid-template-columns:\s*0 minmax\(0, 0\) minmax\(0, 1fr\)/);
    assert.match(workbenchStyles, /\.app-layout > :not\(\.workbench-panel\)[\s\S]*visibility:\s*hidden/);
    assert.match(workbenchStyles, /\.workbench-panel--maximized[\s\S]*width:\s*100% !important/);
  });

  it('keeps the maximize grid unlayered so sidebar collapse and expand cannot pin the workbench width', () => {
    const unlayeredWorkbench = withoutLayerBlocks(workbenchStyles);
    const unlayeredSidebar = withoutLayerBlocks(sidebarStyles);

    assert.match(
      unlayeredWorkbench,
      /:root\[data-workbench-maximized='true'\] \.app-layout \{\s*grid-template-columns:\s*0 minmax\(0, 0\) minmax\(0, 1fr\);/,
    );
    assert.match(
      unlayeredSidebar,
      /\.app-layout \{[\s\S]*?grid-template-columns:[\s\S]*?var\(--za-workbench-current-width, 0px\);/,
    );
    assert.match(
      unlayeredSidebar,
      /:root\[data-sidebar-collapsed='true'\] \.app-layout \{\s*grid-template-columns:\s*0 minmax\(0, 1fr\) var\(--za-workbench-current-width, 0px\);/,
    );
    assert.match(
      stylesEntry,
      /@import "\.\/styles\/sidebar\.css";[\s\S]*@import "\.\/styles\/workbench\.css";/,
    );
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
