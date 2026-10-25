import assert from 'node:assert/strict';
import test from 'node:test';
import { documentReferencePath, documentReferencesInText, isGitReferenceContext } from './documentReference.ts';

test('document destinations keep paths and strip optional source positions', () => {
  assert.equal(documentReferencePath('Peer-Knowledge/knowledge/decisions/104-bot-capability-visibility.md'), 'Peer-Knowledge/knowledge/decisions/104-bot-capability-visibility.md');
  assert.equal(documentReferencePath('README.md'), 'README.md');
  assert.equal(documentReferencePath('说明 文档.md'), '说明 文档.md');
  assert.equal(documentReferencePath('/repo/file.ts:12:4'), '/repo/file.ts');
  assert.equal(documentReferencePath('docs/file.md#L8'), 'docs/file.md');
  assert.equal(documentReferencePath('README.md:12:4'), 'README.md');
  assert.equal(documentReferencePath('src/.gitignore'), 'src/.gitignore');
  assert.equal(documentReferencePath('Dockerfile'), 'Dockerfile');
  for (const text of ['useState', '--flag', 'javascript:alert(1)', 'https://example.com/file.md', 'file:///tmp/file.md']) {
    assert.equal(documentReferencePath(text), null);
  }
});

test('slash-separated branches, repositories, versions and commands remain ordinary code', () => {
  for (const value of ['codex/rc24-release-evidence', 'PeerAgent/dev/0.1.0', 'origin/main', 'ly-ccx/Peer-Knowledge',
    'refs/heads/docs/change.md', 'origin/docs/change.md', 'release/0.1.0', 'docs/', 'git checkout docs/report.md',
    'pnpm test src/report.test.ts', 'cat README.md', 'README.md; rm -rf /']) {
    assert.equal(documentReferencePath(value), null, value);
  }
  for (const path of ['knowledge/decisions/104-bot-capability-visibility.md', 'playbook/product-regression.md',
    './README.md', '../decisions/104.md', 'src/custom.config', 'C:\\project\\report.md']) {
    assert.equal(documentReferencePath(path), path);
  }
});

test('explicit branch context overrides a file-looking ref and preserves the message text', () => {
  for (const prefix of ['分支 ', '分支名：', '分支为 ', 'branch: ', '标签 ', 'git switch -c ']) {
    assert.equal(isGitReferenceContext(prefix), true, prefix);
  }
  assert.equal(isGitReferenceContext('分支里的文件：'), false);
  const text = '推到 codex/rc24-release-evidence，分支 docs/review.md；文件 knowledge/decisions/104.md。';
  const parts = documentReferencesInText(text);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.deepEqual(parts.flatMap(part => part.path ? [part.path] : []), ['knowledge/decisions/104.md']);
});

test('bare paths preserve original text without turning URLs, versions and code names into files', () => {
  const text = '文件在 Peer-Knowledge/knowledge/ADR.md。另见 README.md, https://example.com/a.md 和 React.useState 1.2.3';
  const parts = documentReferencesInText(text);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.deepEqual(parts.flatMap(part => part.path ? [part.path] : []), ['Peer-Knowledge/knowledge/ADR.md', 'README.md']);
});
