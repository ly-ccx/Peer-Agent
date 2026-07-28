import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  inferBilingualSections,
  resolveReleaseNotesLocale,
  selectReleaseNotesByLocale,
  splitReleaseNotesByLocale,
} from './releaseNotesLocale.ts';

describe('resolveReleaseNotesLocale', () => {
  it('maps en* to en-US and everything else to zh-CN', () => {
    assert.equal(resolveReleaseNotesLocale('en-US'), 'en-US');
    assert.equal(resolveReleaseNotesLocale('en'), 'en-US');
    assert.equal(resolveReleaseNotesLocale('zh-CN'), 'zh-CN');
    assert.equal(resolveReleaseNotesLocale('zh'), 'zh-CN');
    assert.equal(resolveReleaseNotesLocale(null), 'zh-CN');
    assert.equal(resolveReleaseNotesLocale(undefined), 'zh-CN');
  });
});

describe('splitReleaseNotesByLocale', () => {
  it('returns empty map for monolingual chinese-only notes', () => {
    assert.deepEqual(splitReleaseNotesByLocale('## 新功能\n\n- 中文 only'), {});
  });

  it('splits markdown comment markers', () => {
    const source = [
      '<!-- locale:zh-CN -->',
      '## 新功能',
      '- 中文项',
      '',
      '<!-- locale:en-US -->',
      "## What's New",
      '- English item',
    ].join('\n');
    const sections = splitReleaseNotesByLocale(source);
    assert.match(sections['zh-CN'] ?? '', /中文项/);
    assert.doesNotMatch(sections['zh-CN'] ?? '', /English item/);
    assert.match(sections['en-US'] ?? '', /English item/);
    assert.doesNotMatch(sections['en-US'] ?? '', /中文项/);
  });

  it('splits visible plain-text locale markers', () => {
    const source = [
      'locale:zh-CN',
      '## 新功能',
      '- 中文可见标记',
      '',
      'locale:en-US',
      "## What's New",
      '- English visible marker',
    ].join('\n');
    const sections = splitReleaseNotesByLocale(source);
    assert.match(sections['zh-CN'] ?? '', /中文可见标记/);
    assert.doesNotMatch(sections['zh-CN'] ?? '', /English visible/);
    assert.match(sections['en-US'] ?? '', /English visible/);
    assert.doesNotMatch(sections['en-US'] ?? '', /中文可见/);
  });

  it('infers bilingual sections when GitHub HTML strips comments', () => {
    const html = [
      '<div class="markdown-heading"><h2 class="heading-element">说明</h2></div>',
      '<ul><li>本版在 <strong>0.0.1-beta.43</strong> 之上，把默认模式升级为 <strong>Agent 自驱</strong>。</li></ul>',
      '<div class="markdown-heading"><h2 class="heading-element">CLI / npm</h2></div>',
      '<ul><li>可安装：<code>npm i -g @peer-agent/cli@beta</code>。</li></ul>',
      '<div class="markdown-heading"><h2 class="heading-element">Notes</h2></div>',
      '<ul><li>Built on <strong>0.0.1-beta.43</strong>. Default mode is now <strong>Agent</strong>.</li></ul>',
      '<div class="markdown-heading"><h2 class="heading-element">What\'s New</h2></div>',
      '<ul><li>Default Agent mode for multi-step work.</li></ul>',
    ].join('\n');
    const sections = splitReleaseNotesByLocale(html);
    assert.match(sections['zh-CN'] ?? '', /可安装/);
    assert.doesNotMatch(sections['zh-CN'] ?? '', /Built on/);
    assert.match(sections['en-US'] ?? '', /Built on/);
    assert.doesNotMatch(sections['en-US'] ?? '', /可安装/);
  });
});

describe('inferBilingualSections', () => {
  it('splits on Markdown Notes heading after Chinese body', () => {
    const md = [
      '## 说明',
      '- 中文说明段落',
      '',
      '## Notes',
      '- English notes paragraph',
    ].join('\n');
    const sections = inferBilingualSections(md);
    assert.match(sections['zh-CN'] ?? '', /中文说明/);
    assert.match(sections['en-US'] ?? '', /English notes/);
  });
});

describe('selectReleaseNotesByLocale', () => {
  const bilingual = [
    '<!-- locale:zh-CN -->',
    '## 新功能',
    '- 中文说明',
    '',
    '<!-- locale:en-US -->',
    "## What's New",
    '- English notes',
  ].join('\n');

  it('selects Chinese section for zh-CN', () => {
    const out = selectReleaseNotesByLocale(bilingual, 'zh-CN');
    assert.match(out, /中文说明/);
    assert.doesNotMatch(out, /English notes/);
    assert.doesNotMatch(out, /locale:/i);
  });

  it('selects English section for en-US', () => {
    const out = selectReleaseNotesByLocale(bilingual, 'en-US');
    assert.match(out, /English notes/);
    assert.doesNotMatch(out, /中文说明/);
  });

  it('falls back to the other language when preferred is missing', () => {
    const zhOnly = '<!-- locale:zh-CN -->\n## 新功能\n- 只有中文';
    const out = selectReleaseNotesByLocale(zhOnly, 'en-US');
    assert.match(out, /只有中文/);
  });

  it('returns legacy chinese-only notes unchanged (markers stripped if any)', () => {
    const legacy = '## 新功能\n\n- 历史中文发布说明';
    assert.equal(selectReleaseNotesByLocale(legacy, 'en-US'), legacy);
    assert.equal(selectReleaseNotesByLocale(legacy, 'zh-CN'), legacy);
  });

  it('handles empty input', () => {
    assert.equal(selectReleaseNotesByLocale('', 'zh-CN'), '');
    assert.equal(selectReleaseNotesByLocale(null, 'en-US'), '');
  });

  it('accepts GitHub-style HTML with comment markers', () => {
    const html = [
      '<!-- locale:zh-CN -->',
      '<h2>新功能</h2><ul><li>中文 HTML</li></ul>',
      '<!-- locale:en-US -->',
      "<h2>What's New</h2><ul><li>English HTML</li></ul>",
    ].join('\n');
    const zh = selectReleaseNotesByLocale(html, 'zh-CN');
    const en = selectReleaseNotesByLocale(html, 'en-US');
    assert.match(zh, /中文 HTML/);
    assert.doesNotMatch(zh, /English HTML/);
    assert.match(en, /English HTML/);
    assert.doesNotMatch(en, /中文 HTML/);
  });

  it('selects Chinese only from comment-stripped GitHub HTML (beta.44 regression)', () => {
    // Mirrors electron-updater payload after GitHub markdown render drops HTML comments.
    const githubHtml = [
      '<div class="markdown-heading"><h2 class="heading-element">说明</h2><a id="user-content-说明" class="anchor" aria-label="Permalink: 说明" href="#说明"><span aria-hidden="true" class="octicon octicon-link"></span></a></div>',
      '<ul>',
      '<li>本版在 <strong>0.0.1-beta.43</strong> 之上，把默认模式升级为 <strong>Agent 自驱</strong>，并补齐 macOS 菜单栏托盘、Skills 工作区分层、首启配模型与产品文档站。</li>',
      '<li>Desktop 与 CLI 的模式产品面统一为 <strong>Agent / Plan</strong>；旧 <code>goal</code> 会话仍兼容，显示为 Agent。</li>',
      '</ul>',
      '<div class="markdown-heading"><h2 class="heading-element">CLI / npm</h2><a id="user-content-cli--npm" class="anchor" aria-label="Permalink: CLI / npm" href="#cli--npm"><span aria-hidden="true" class="octicon octicon-link"></span></a></div>',
      '<ul>',
      '<li>可安装：<code>npm i -g @peer-agent/cli@beta</code>。</li>',
      '<li>安装后执行 <code>peer --version</code> 应输出 <code>peer 0.0.1-beta.44</code>。</li>',
      '<li>会话与设置仍落在 <code>~/.peer-agent</code>，与 Desktop 共享。</li>',
      '</ul>',
      '<div class="markdown-heading"><h2 class="heading-element">Notes</h2><a id="user-content-notes" class="anchor" aria-label="Permalink: Notes" href="#notes"><span aria-hidden="true" class="octicon octicon-link"></span></a></div>',
      '<ul>',
      '<li>Built on <strong>0.0.1-beta.43</strong>. Default mode is now <strong>Agent</strong> (self-driven), with a macOS menu-bar tray, workspace/global Skills, first-run model setup, and a product docs site.</li>',
      '<li>Desktop and CLI product surface is <strong>Agent / Plan</strong>. Legacy <code>goal</code> sessions remain compatible and display as Agent.</li>',
      '</ul>',
      '<div class="markdown-heading"><h2 class="heading-element">What\'s New</h2><a id="user-content-whats-new" class="anchor" aria-label="Permalink: What\'s New" href="#whats-new"><span aria-hidden="true" class="octicon octicon-link"></span></a></div>',
      '<ul>',
      '<li><strong>Default Agent mode</strong>: Adapts planning depth (L0–L3).</li>',
      '</ul>',
    ].join('\n');

    const zh = selectReleaseNotesByLocale(githubHtml, 'zh-CN');
    const en = selectReleaseNotesByLocale(githubHtml, 'en-US');

    assert.match(zh, /可安装/);
    assert.doesNotMatch(zh, /Built on/);
    assert.doesNotMatch(zh, /Default Agent mode/);
    assert.doesNotMatch(zh, />Notes</);

    assert.match(en, /Built on/);
    assert.match(en, /Default Agent mode/);
    assert.doesNotMatch(en, /可安装/);
    assert.doesNotMatch(en, /会话与设置/);
  });

  it('strips visible locale markers from selected body', () => {
    const source = [
      'locale:zh-CN',
      '## 新功能',
      '- 中文',
      'locale:en-US',
      "## What's New",
      '- English',
    ].join('\n');
    const zh = selectReleaseNotesByLocale(source, 'zh-CN');
    assert.match(zh, /中文/);
    assert.doesNotMatch(zh, /locale:/i);
  });
});
