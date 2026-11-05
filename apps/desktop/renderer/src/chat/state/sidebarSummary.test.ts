import assert from 'node:assert/strict';
import test from 'node:test';
import { sidebarSummaryExcerpt } from './sidebarSummary.ts';

test('sidebar summary reads the materialized excerpt and skips a rebuilding preview', () => {
  assert.equal(sidebarSummaryExcerpt({ preview: { excerpt: '  最近一条  ', availability: 'ready' } }), '最近一条');
  assert.equal(sidebarSummaryExcerpt({ preview: { excerpt: '旧摘要', availability: 'rebuilding' } }), '');
  assert.equal(sidebarSummaryExcerpt({ preview: { excerpt: '损坏', availability: 'damaged' } }), '');
  assert.equal(sidebarSummaryExcerpt({}), '');
  assert.equal(sidebarSummaryExcerpt(null), '');
});
