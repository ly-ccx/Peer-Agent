import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 「Git」设置分区 · 源头分支下拉的布局契约。
 *
 * 背景：该行曾用原生 <select>，而 flex 项的 min-width:auto 会把它的
 * min-content（= 最宽 option）当成下限，于是 98～105 字符的 automation
 * 分支名把整行顶开，左侧说明文字被挤成一字一行。
 *
 * 现在改用共享 Dropdown（触发器有 text-overflow:ellipsis），并要求槽位
 * 自身可以被收缩。本测试钉住这两点不被回退。
 */

const componentsDir = dirname(fileURLToPath(import.meta.url));
const gitPanel = readFileSync(join(componentsDir, './GitPanel.tsx'), 'utf8');
const settingsCss = readFileSync(
  join(componentsDir, '../../styles/settings-page.css'),
  'utf8',
);

function ruleBody(css: string, selector: string) {
  const normalizedCss = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, (character) => '\\' + character);
  const match = normalizedCss.match(new RegExp(`(?:^|[{}])\\s*${escaped} \\{([^}]*)\\}`));
  assert.ok(match, `Expected CSS rule for ${selector}`);
  return match[1];
}

test('source branch picker uses the shared Dropdown, not a native select', () => {
  // 面板内不得出现原生 select / optgroup（长分支名会重新撑破布局）。
  assert.doesNotMatch(gitPanel, /<select\b/, 'GitPanel must not render a native <select>');
  assert.doesNotMatch(gitPanel, /<optgroup\b/, 'GitPanel must not render a native <optgroup>');
  assert.match(gitPanel, /<Dropdown\b/, 'GitPanel must render the shared Dropdown');
});

test('source branch Dropdown exposes local/remote tabs and stays searchable', () => {
  assert.match(gitPanel, /searchable=\{true\}/, 'branch list must stay searchable');
  assert.match(gitPanel, /tabs=\{\[/, 'branch list must render tabs');

  // 本地/远程两个标签页，选项按 tab 归属，未标记 tab 的 unset 项两页都可见。
  for (const tab of ['local', 'remote']) {
    assert.match(gitPanel, new RegExp(`id: '${tab}'`), `missing ${tab} tab`);
    assert.match(gitPanel, new RegExp(`tab: '${tab}'`), `missing ${tab} option tag`);
  }
});

test('branch slot can shrink so long branch names ellipsize instead of widening the row', () => {
  const slot = ruleBody(settingsCss, '.general-language-select');
  assert.match(slot, /min-width:\s*0/, 'slot must be allowed to shrink below min-content');
  assert.doesNotMatch(
    slot,
    /flex:\s*0 0 180px/,
    'a fixed flex-basis with min-width:auto is what let long branch names widen the row',
  );

  // 下拉容器必须填满槽位并同样可收缩，否则 min-width:200px 会外溢。
  const dropdown = ruleBody(settingsCss, '.general-language-select .pa-dropdown');
  assert.match(dropdown, /width:\s*100%/);
  assert.match(dropdown, /min-width:\s*0/);
});
