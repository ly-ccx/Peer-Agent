import assert from 'node:assert/strict';
import test from 'node:test';
import { documentReferencePath, documentReferencesInText } from './documentReference.ts';

test('document destinations keep paths and strip optional source positions', () => {
  assert.equal(documentReferencePath('Peer-Knowledge/knowledge/decisions/104-bot-capability-visibility.md'), 'Peer-Knowledge/knowledge/decisions/104-bot-capability-visibility.md');
  assert.equal(documentReferencePath('README.md'), 'README.md');
  assert.equal(documentReferencePath('说明 文档.md'), '说明 文档.md');
  assert.equal(documentReferencePath('/repo/file.ts:12:4'), '/repo/file.ts');
  assert.equal(documentReferencePath('docs/file.md#L8'), 'docs/file.md');
  for (const text of ['useState', '--flag', 'javascript:alert(1)', 'https://example.com/file.md', 'file:///tmp/file.md']) {
    assert.equal(documentReferencePath(text), null);
  }
});

test('bare paths preserve original text without turning URLs, versions and code names into files', () => {
  const text = '文件在 Peer-Knowledge/knowledge/ADR.md。另见 README.md, https://example.com/a.md 和 React.useState 1.2.3';
  const parts = documentReferencesInText(text);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.deepEqual(parts.flatMap(part => part.path ? [part.path] : []), ['Peer-Knowledge/knowledge/ADR.md', 'README.md']);
});
