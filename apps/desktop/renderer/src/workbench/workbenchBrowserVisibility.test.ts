import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const panelSource = readFileSync(new URL('./WorkbenchPanel.tsx', import.meta.url), 'utf8');
const browserViewSource = readFileSync(new URL('./views/BrowserView.tsx', import.meta.url), 'utf8');
const workbenchStyles = readFileSync(new URL('../styles/workbench.css', import.meta.url), 'utf8');

describe('workbench view visibility', () => {
  it('keeps BrowserView mounted so browser tabs and page sessions survive workbench tab switches', () => {
    // root/local 分支现在都用模板字符串 class（workbench-view--browser + 可能 workbench-view--prepared-browser），
    // 关键不变量是：浏览器视图常驻渲染（不通过 activeTab==='browser' && <BrowserView> 条件卸载），
    // 且 data-active 用三元表达式绑定 activeTab，保证切会话/切 tab 时 guest 不重建。
    assert.match(
      panelSource,
      /className=\{`workbench-view workbench-view--browser\$\{id === conversationId \? '' : ' workbench-view--prepared-browser'\}`\}[\s\S]*data-active=\{id === conversationId \? activeTab === 'browser' : false\}[\s\S]*<BrowserView/,
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

  it('reuses one BrowserView instance per conversation instead of remounting the foreground key', () => {
    assert.match(panelSource, /mountedBrowserConversations\(conversationId, preparedBrowserConversations\)/);
    assert.match(panelSource, /key=\{`mounted-browser-\$\{id\}`\}/);
    assert.match(panelSource, /claimForeground=\{id === conversationId\}/);
    assert.match(
      panelSource,
      /workbench-view--prepared-browser[\s\S]*claimForeground=\{id === conversationId\}/,
    );
  });

  it('keeps a prepared background Browser guest mounted off-screen instead of display:none', () => {
    assert.match(panelSource, /workbench-view--prepared-browser/);
    assert.match(panelSource, /claimForeground=\{id === conversationId\}/);
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
