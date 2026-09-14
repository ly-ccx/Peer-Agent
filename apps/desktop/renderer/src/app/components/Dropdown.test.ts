import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./Dropdown.tsx', import.meta.url), 'utf8');

test('closed trigger can override option labels without changing menu items', () => {
  assert.match(source, /readonly triggerLabel\?: string;/);
  assert.match(
    source,
    /const triggerLabel = triggerLabelOverride \?\? selected\?\.label \?\? placeholder \?\? value;/,
  );
  assert.match(source, /<span className="pa-dropdown-value">\{triggerLabel\}<\/span>/);
  assert.match(source, /<span className="pa-dropdown-item-label">\{opt\.label\}<\/span>/);
  assert.doesNotMatch(source, /triggerLabelOverride \?\? opt\.label/);
});

test('open menus clamp against the open workbench and visible webviews', () => {
  assert.match(source, /collectDropdownOccluders, placeDropdownMenu/);
  assert.match(source, /occluders: collectDropdownOccluders\(\)/);
  assert.match(source, /width: menuRef\.current\?\.offsetWidth \?\? rect\.width/);
});

test('source menus can render local and remote tabs without filtering untagged options', () => {
  assert.match(source, /readonly tabs\?: readonly DropdownTab\[\];/);
  assert.match(source, /role="tablist"/);
  assert.match(source, /role="tab"/);
  assert.match(source, /filterDropdownOptions\(options, query, menuTab\)/);
  assert.match(source, /resolveDropdownActiveTab\(\{ tabs: tabList, options, value \}\)/);
  assert.match(source, /onClick=\{\(\) => setActiveTab\(tab\.id\)\}/);
});

test('footer actions never forward the hovered row to the callback', () => {
  // `activeIndex` moves with the mouse (rows call setActiveIndex on mouse enter), so a footer
  // action that receives it forks from whatever row the pointer last crossed. The footer must
  // only forward the search text; callers read their own selection instead.
  assert.match(source, /readonly onSelect: \(query: string\) => void;/);
  assert.match(source, /footerAction\.onSelect\(query\);/);
  assert.doesNotMatch(source, /footerAction\.onSelect\(query,\s*visibleOptions\[activeIndex\]/);
  assert.doesNotMatch(source, /highlightedValue/);
});
