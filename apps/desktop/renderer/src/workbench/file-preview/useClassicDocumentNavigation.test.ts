import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as references from '../../chat/components/markdown/documentReference.ts';

function navigation(relativeBaseKnown = true) {
  const opened: any[][] = [], browser: string[] = [];
  const workbench = { openFile: (...args: any[]) => opened.push(args), setBrowserSession: (update: (value: object) => { url: string }) => browser.push(update({}).url),
    setActiveTab: (tab: string) => browser.push(tab), setOpen: () => browser.push('open') };
  const modules: Record<string, unknown> = { react: { useMemo: (read: () => unknown) => read() },
    '../WorkbenchContext': { useWorkbenchOptional: () => workbench }, '../../chat/components/markdown/documentReference': references,
    '../browserSessionState': { createBrowserTabSession: (_: unknown, url: string) => ({ url }), addBrowserTab: (_: unknown, tab: unknown) => tab } };
  const exports: Record<string, any> = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL('./useClassicDocumentNavigation.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, require(id: string) { if (id in modules) return modules[id]; throw Error(id); } });
  return { adapter: exports.useClassicDocumentNavigation('/repo/docs/guide.md', '/repo', false, relativeBaseKnown), opened, browser };
}
test('relative document navigation uses the displayed file directory and original read scope, only on explicit action', () => {
  const h = navigation(); assert.equal(h.opened.length, 0);
  h.adapter.open('examples/demo.ts#L12');
  assert.equal(h.opened[0][0], '/repo/docs/examples/demo.ts'); assert.equal(h.opened[0][1], '/repo'); assert.equal(h.opened[0][3].line, 12);
  h.adapter.openUrl('javascript:alert(1)'); assert.equal(h.browser.length, 0);
  h.adapter.openUrl('https://example.invalid/a'); assert.deepEqual(h.browser, ['https://example.invalid/a', 'browser', 'open']);
});
test('unknown classic resolved base leaves relative targets inert instead of guessing a repository', () => {
  const h = navigation(false);
  assert.equal(h.adapter.resolve('examples/demo.ts'), null);
  h.adapter.open('examples/demo.ts'); h.adapter.open('~/private.md'); assert.equal(h.opened.length, 0);
  h.adapter.open('/repo/other.md'); assert.equal(h.opened[0][0], '/repo/other.md'); assert.equal(h.opened[0][1], '/repo');
});
