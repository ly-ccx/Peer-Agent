import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('electron-builder ships Linux Desktop AppImage + deb x64', () => {
  const yml = readFileSync(join(root, 'apps/desktop/electron-builder.yml'), 'utf8');
  const linuxStart = yml.indexOf('# ── Linux Desktop');
  const linuxEnd = yml.indexOf('# ── 发布');
  assert.ok(linuxStart >= 0 && linuxEnd > linuxStart, 'linux block markers missing');
  const linuxBlock = yml.slice(linuxStart, linuxEnd);

  assert.match(linuxBlock, /target:\s*AppImage/);
  assert.match(linuxBlock, /target:\s*deb/);
  assert.match(linuxBlock, /arch:\s*\[x64\]/);
  assert.doesNotMatch(linuxBlock, /target:\s*dir/);
  assert.match(yml, /latest-linux\.yml/);
  assert.match(yml, /beta-linux\.yml/);
  assert.match(yml, /artifactName: Peer-Agent-\$\{version\}-\$\{arch\}\.\$\{ext\}/);
  assert.match(linuxBlock, /artifactName: Peer-Agent-\$\{version\}-x64\.\$\{ext\}/);
});

test('release.yml builds and publishes Linux Desktop artifacts', () => {
  const yml = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  assert.match(yml, /platform:\s*linux/);
  assert.match(yml, /ebflags:\s*--linux --x64/);
  assert.match(yml, /os:\s*ubuntu-latest/);
  assert.match(yml, /\*\.AppImage/);
  assert.match(yml, /\*\.deb/);
  assert.match(yml, /latest-linux\.yml/);
  assert.match(yml, /beta-linux\.yml/);
  assert.match(yml, /libdbus-1-dev/);
});

test('README install section lists Linux Desktop AppImage and dist:linux', () => {
  const en = readFileSync(join(root, 'README.md'), 'utf8');
  const zh = readFileSync(join(root, 'README.zh-CN.md'), 'utf8');
  for (const text of [en, zh]) {
    assert.match(text, /Peer-Agent-<ver>-x64\.AppImage/);
    assert.match(text, /pnpm dist:linux/);
    assert.match(text, /pnpm pack:linux/);
    assert.match(text, /latest-linux\.yml/);
  }
});

test('package scripts expose pack:linux (dir) and dist:linux (AppImage/deb)', () => {
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const desktopPkg = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8'));

  assert.match(desktopPkg.scripts['pack:linux'], /--linux dir --x64/);
  assert.match(desktopPkg.scripts['dist:linux'], /--linux --x64/);
  assert.equal(rootPkg.scripts['pack:linux'], 'pnpm build && pnpm --filter @peer-agent/desktop pack:linux');
  assert.equal(rootPkg.scripts['dist:linux'], 'pnpm build && pnpm --filter @peer-agent/desktop dist:linux');
});
