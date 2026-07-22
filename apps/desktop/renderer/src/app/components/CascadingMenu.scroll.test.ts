import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSource = () => readFile(new URL('./CascadingMenu.tsx', import.meta.url), 'utf8');

test('submenu open/group scroll effect does not depend on activeItemIndex', async () => {
  const source = await readSource();

  // 打开/切换分组时只滚到已选 value，不能把 activeItemIndex 放进依赖，否则悬停会回跳。
  assert.match(
    source,
    /resolveOpenGroupScrollTarget\(selectedIdx\)/,
  );
  assert.match(
    source,
    /\[open, submenuCoords, activeGroupIndex, groups, value, updateSubmenuScrollState\]/,
  );
  assert.doesNotMatch(
    source,
    /\[open, submenuCoords, activeGroupIndex, activeItemIndex, groups, value, updateSubmenuScrollState\]/,
  );
});

test('hover-driven activeItemIndex only scrolls when keyboard nav flag is set', async () => {
  const source = await readSource();

  assert.match(source, /scrollActiveItemOnNavRef/);
  assert.match(source, /resolveKeyboardActiveScrollTarget\(keyboardNav, activeItemIndex\)/);
  assert.match(source, /case 'ArrowDown':[\s\S]*scrollActiveItemOnNavRef\.current = true/);
  assert.match(source, /case 'ArrowUp':[\s\S]*scrollActiveItemOnNavRef\.current = true/);
  // 悬停只改 activeItemIndex，不置 keyboard 门控。
  assert.match(
    source,
    /onMouseEnter=\{\(\) => \{\s*if \(!itemDisabled\) \{\s*setFocusZone\('sub'\);\s*setActiveItemIndex\(ii\);/,
  );
  assert.doesNotMatch(
    source,
    /onMouseEnter=\{\(\) => \{[\s\S]{0,200}scrollActiveItemOnNavRef\.current = true/,
  );
});
