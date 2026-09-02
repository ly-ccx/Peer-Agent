import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const panelSource = readFileSync(new URL('./WorkbenchPanel.tsx', import.meta.url), 'utf8');
const browserViewSource = readFileSync(new URL('./views/BrowserView.tsx', import.meta.url), 'utf8');
const workbenchStyles = readFileSync(new URL('../styles/workbench.css', import.meta.url), 'utf8');

describe('workbench view visibility', () => {
  it('keeps BrowserView mounted so browser tabs and page sessions survive workbench tab switches', () => {
    assert.match(
      panelSource,
      /className="workbench-view workbench-view--browser"[\s\S]*data-active=\{activeTab === 'browser'\}[\s\S]*<BrowserView/,
    );
    assert.doesNotMatch(panelSource, /activeTab === 'browser'\s*&&\s*<BrowserView/);
  });

  it('removes every inactive view from layout so a visible nested preview cannot overlap another tab', () => {
    assert.match(
      workbenchStyles,
      /\.workbench-view\[data-active='false'\]\s*\{\s*display:\s*none;/,
    );
    assert.doesNotMatch(
      workbenchStyles,
      /\.workbench-view--browser\[data-active='false'\]\s*\{\s*display:\s*none;/,
    );
  });

  it('keeps a prepared background Browser guest mounted off-screen instead of display:none', () => {
    assert.match(panelSource, /workbench-view--prepared-browser/);
    assert.match(panelSource, /claimForeground=\{false\}/);
    assert.match(
      workbenchStyles,
      /\.workbench-view--prepared-browser\[data-active='false'\]\s*\{\s*display:\s*flex;/,
    );
  });

  it('exposes an address-bar control to open the current http(s) page in the default browser', () => {
    assert.match(browserViewSource, /openInDefaultBrowser/);
    assert.match(browserViewSource, /IconOpenExternal/);
    assert.match(browserViewSource, /openBrowserExternal/);
    assert.match(browserViewSource, /parsed\.protocol !== 'http:' && parsed\.protocol !== 'https:'/);
  });
});
