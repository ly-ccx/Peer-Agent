import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sidebarSource = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');

test('conversation context menu copies the clicked conversation Session ID', () => {
  assert.match(sidebarSource, /isZh \? '复制会话 ID' : 'Copy Session ID'/);
  assert.match(
    sidebarSource,
    /onClick=\{\(\) => \{[\s\S]*?closeContextMenu\(\);[\s\S]*?navigator\.clipboard\.writeText\(contextConv\.id\)[\s\S]*?Failed to copy Session ID[\s\S]*?\}\}/,
  );
});
