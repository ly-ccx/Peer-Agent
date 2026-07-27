import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
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
  it('returns empty map when no locale markers', () => {
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
});
