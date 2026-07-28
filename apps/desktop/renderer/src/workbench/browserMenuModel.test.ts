import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BROWSER_MENU_P0_ENABLED_IDS,
  buildBrowserOverflowMenu,
  importSiteSessionPlaceholder,
} from './browserMenuModel.ts';

describe('buildBrowserOverflowMenu', () => {
  it('includes Import site session wording, never cookies and passwords package', () => {
    const en = buildBrowserOverflowMenu(false);
    const zh = buildBrowserOverflowMenu(true);
    const enLabels = en.filter((i) => i.kind === 'action').map((i) => i.label);
    const zhLabels = zh.filter((i) => i.kind === 'action').map((i) => i.label);

    assert.ok(enLabels.some((l) => l.includes('Import site session')));
    assert.ok(zhLabels.some((l) => l.includes('导入站点会话')));
    assert.ok(!enLabels.some((l) => /cookies and passwords/i.test(l)));
    assert.ok(!zhLabels.some((l) => /cookies and passwords/i.test(l)));
  });

  it('enables only P0 actions', () => {
    const items = buildBrowserOverflowMenu(false).filter((i) => i.kind === 'action');
    for (const item of items) {
      if (BROWSER_MENU_P0_ENABLED_IDS.has(item.id)) {
        assert.equal(item.enabled, true, item.id);
      } else {
        assert.equal(item.enabled, false, item.id);
      }
    }
  });

  it('enables Password manager for Phase 1 user-facing vault', () => {
    const item = buildBrowserOverflowMenu(false).find(
      (i) => i.kind === 'action' && i.id === 'password_manager',
    );
    assert.ok(item && item.kind === 'action');
    assert.equal(item.enabled, true);
    assert.match(item.label, /Password manager/i);
    assert.equal(BROWSER_MENU_P0_ENABLED_IDS.has('password_manager'), true);
  });
});

describe('importSiteSessionPlaceholder', () => {
  it('states cookies-only scope', () => {
    assert.match(importSiteSessionPlaceholder(false), /cookies only/i);
    assert.match(importSiteSessionPlaceholder(true), /Cookie/);
    assert.doesNotMatch(importSiteSessionPlaceholder(false), /and passwords/i);
  });
});
