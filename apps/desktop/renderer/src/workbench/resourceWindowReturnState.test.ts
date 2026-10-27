import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResourceWindowContext } from '@peer-agent/protocol';
import { createDocumentTabSession } from './documentSessionState.ts';
import { returnDocumentSession, seedSourceDirectory } from './resourceWindowReturnState.ts';
const reference = { workspaceId: 'bot', path: '/repo/a.md' };
const context: ResourceWindowContext = { viewId: 'view', windowId: 'window', generation: 1, phase: 'ready', sourceTabId: 'original', owner: { workspaceId: 'bot', conversationId: 'conversation' },
  resource: { kind: 'document', reference, mode: 'preview' }, sourceNavigation: { top: 100, left: 0 }, navigation: { top: 900, left: 0 } };
test('returning preserves the source view reading and mode; a closed source document is not recreated', () => {
  const tab = createDocumentTabSession(reference.path, { id: 'original', reference, mode: 'source' });
  const source = { tabs: [tab], activeTabId: null };
  const returned = returnDocumentSession(source, context);
  assert.equal(returned.session.activeTabId, tab.id); assert.equal(returned.session.tabs[0], tab); assert.equal(returned.session.tabs[0].mode, 'source');
  assert.equal(returnDocumentSession({ tabs: [], activeTabId: null }, context).status, 'source_tab_closed');
});
test('recreated comparisons retain immutable endpoints and source anchors, without adopting the copy point', () => {
  const result = returnDocumentSession({ tabs: [], activeTabId: null }, { ...context, resource: { kind: 'comparison', reference: { ...reference, path: '/repo', kind: 'directory' }, fromRef: 'a'.repeat(40), toRef: 'b'.repeat(40) },
    sourceNavigation: { top: 55, left: 0, selected: 'src/a.ts' } });
  assert.equal(result.session.tabs[0].comparison?.fromRef, 'a'.repeat(40)); assert.equal(result.session.tabs[0].resourceReading?.top, 55);
  assert.equal(result.session.tabs[0].resourceReading?.selected, 'src/a.ts');
});
test('directory return seeds only missing roots and does not overwrite a newer source-tree reading', () => {
  const ctx = { ...context, resource: { kind: 'directory' as const, reference: { ...reference, path: '/repo', kind: 'directory' as const } }, sourceNavigation: { top: 100, left: 0, expanded: ['.', 'src'], selected: 'src/a.ts' } };
  const source = { source: '/other', readings: [{ root: '/repo', top: 500, left: 0, expanded: ['.'], selected: null, filter: '' }] };
  assert.equal(seedSourceDirectory(source, ctx), source);
  const seeded = seedSourceDirectory({ source: '/other', readings: [] }, ctx);
  assert.equal(seeded.source, '/other'); assert.equal(seeded.readings[0].top, 100);
});
