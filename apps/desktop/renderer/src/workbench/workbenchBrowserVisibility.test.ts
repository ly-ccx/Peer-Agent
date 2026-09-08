import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const panelSource = readFileSync(new URL('./WorkbenchPanel.tsx', import.meta.url), 'utf8');
const contextSource = readFileSync(new URL('./WorkbenchContext.tsx', import.meta.url), 'utf8');
const browserViewSource = readFileSync(new URL('./views/BrowserView.tsx', import.meta.url), 'utf8');
const workbenchStyles = readFileSync(new URL('../styles/workbench.css', import.meta.url), 'utf8');

describe('workbench view visibility', () => {
  it('inherits selected-page visibility from its conversation and panel instead of escaping hidden ancestors', () => {
    assert.match(
      workbenchStyles,
      /\.browser-webview\[data-active='true'\]\s*\{\s*visibility:\s*inherit;/,
    );
    assert.doesNotMatch(
      workbenchStyles,
      /\.browser-webview\[data-active='true'\]\s*\{\s*visibility:\s*visible;/,
    );
  });

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
    assert.match(panelSource, /mountedBrowserConversations\(/);
    assert.match(panelSource, /stabilizeMountedBrowserOrder\(/);
    assert.match(panelSource, /key=\{`mounted-browser-\$\{id\}`\}/);
    assert.match(panelSource, /claimForeground=\{id === conversationId\}/);
    assert.match(
      panelSource,
      /workbench-view--prepared-browser[\s\S]*claimForeground=\{id === conversationId\}/,
    );
  });

  it('disables pointer events on kept-alive Browser guests so they cannot steal Goal or Files wheel', () => {
    assert.match(
      workbenchStyles,
      /\.workbench-view\.workbench-view--browser\[data-active='false'\] \.browser-webview,\s*\n\s*\.workbench-view--prepared-browser\[data-active='false'\] \.browser-webview,\s*\n\s*\.workbench-view\.workbench-view--browser\[data-active='false'\] \.browser-webview\[data-active='true'\],\s*\n\s*\.workbench-view--prepared-browser\[data-active='false'\] \.browser-webview\[data-active='true'\]\s*\{\s*pointer-events:\s*none !important;/,
    );
  });

  it('keeps a prepared background Browser guest mounted without display:none or fixed reparent', () => {
    assert.match(panelSource, /workbench-view--prepared-browser/);
    assert.match(panelSource, /claimForeground=\{id === conversationId\}/);
    assert.match(
      workbenchStyles,
      /\.workbench-view\.workbench-view--browser\[data-active='false'\],\s*\n\s*\.workbench-view--prepared-browser\[data-active='false'\]\s*\{\s*display:\s*flex;/,
    );
    assert.doesNotMatch(
      workbenchStyles,
      /\.workbench-view--prepared-browser\[data-active='false'\][\s\S]{0,200}position:\s*fixed/,
    );
  });

  it('tracks the previous conversation in state so Strict Mode cannot drop a live page', () => {
    assert.match(contextSource, /const \[trackedConversationId, setTrackedConversationId\] = useState\(conversationId\)/);
    assert.match(contextSource, /if \(trackedConversationId !== conversationId\)/);
    assert.match(contextSource, /rememberLeavingBrowserConversation\(/);
    assert.doesNotMatch(contextSource, /previousConversationIdRef/);
  });

  it('exposes an address-bar control to open the current http(s) page in the default browser', () => {
    assert.match(browserViewSource, /openInDefaultBrowser/);
    assert.match(browserViewSource, /IconOpenExternal/);
    assert.match(browserViewSource, /openBrowserExternal/);
    assert.match(browserViewSource, /parsed\.protocol !== 'http:' && parsed\.protocol !== 'https:'/);
  });
});
