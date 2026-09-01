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
