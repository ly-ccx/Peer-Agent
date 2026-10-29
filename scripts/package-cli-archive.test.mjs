import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { packageCliArchive, parseTargetSpec } from './package-cli-archive.mjs';
import { prepareMacosCliHelper } from './prepare-macos-cli-helper.mjs';

describe('parseTargetSpec', () => {
  it('splits linux-x64 and darwin-arm64', () => {
    assert.deepEqual(parseTargetSpec('linux-x64'), ['linux', 'x64']);
    assert.deepEqual(parseTargetSpec('darwin-arm64'), ['darwin', 'arm64']);
  });

  it('keeps win32 as the platform', () => {
    assert.deepEqual(parseTargetSpec('win32-x64'), ['win32', 'x64']);
  });
});

describe('macOS CLI signed helper assembly', () => {
  function fixture(t, overrides = {}) {
    const root = mkdtempSync(join(tmpdir(), 'peer-cli-signed-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const artifactDir = join(root, 'artifacts');
    const distDir = join(root, 'dist');
    const temporaryRoot = join(root, 'temp');
    for (const dir of [artifactDir, distDir, temporaryRoot]) mkdirSync(dir);
    writeFileSync(join(artifactDir, 'Peer-Agent-0.1.0-rc.2-arm64.zip'), 'desktop archive fixture');
    writeFileSync(join(distDir, 'peer'), '#!/bin/sh\necho peer\n');
    writeFileSync(join(distDir, 'peer-credential-helper'), 'original ad-hoc helper');
    const signedBytes = Buffer.from('signed helper\0signature retained');
    const commands = [];
    const options = {
      expectedVersion: '0.1.0-rc.2', platform: 'darwin', artifactDir, distDir, temporaryRoot,
      runCommand(command, args) {
        commands.push({ command, args });
        if (command.endsWith('/ditto')) {
          if (overrides.extractError) throw new Error('extraction failed');
          const contents = join(args.at(-1), 'Peer Agent.app', 'Contents');
          mkdirSync(join(contents, 'Resources', 'bin'), { recursive: true });
          writeFileSync(join(contents, 'Info.plist'), 'version fixture');
          writeFileSync(join(contents, 'Resources', 'bin', 'peer-credential-helper'), signedBytes);
        }
        if (command.endsWith('/PlistBuddy')) return overrides.version ?? '0.1.0-rc.2\n';
        if (command.endsWith('/lipo')) return overrides.arch ?? 'arm64\n';
        if (command.endsWith('/codesign') && args.includes('--verify')) {
          if (overrides.signatureError) throw new Error('invalid signature');
          if (overrides.copiedSignatureError && args.at(-1).includes('.peer-cli-helper-')) {
            throw new Error('copied signature invalid');
          }
        }
        if (command.endsWith('/codesign') && args.includes('--display')) {
          return overrides.identity ?? 'Identifier=peer-credential-helper\nAuthority=Developer ID Application: Test (82672N97RP)\nTeamIdentifier=82672N97RP\n';
        }
        return '';
      },
    };
    return { root, distDir, temporaryRoot, options, signedBytes, commands };
  }

  function assertClean(f) {
    assert.deepEqual(readdirSync(f.temporaryRoot), []);
    assert.deepEqual(readdirSync(f.distDir).filter((name) => name.startsWith('.peer-cli-helper-')), []);
  }

  it('keeps signed bytes through verification, replacement and the final archive', (t) => {
    const f = fixture(t);
    const result = prepareMacosCliHelper(f.options);
    assert.deepEqual(readFileSync(result.helperPath), f.signedBytes);
    assert.equal(result.version, '0.1.0-rc.2');
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    const verifiedPaths = f.commands.filter(({ command, args }) => command.endsWith('/codesign') && args.includes('--verify')).map(({ args }) => args.at(-1));
    assert.equal(verifiedPaths.length, 3);
    assert.match(verifiedPaths[0], /Peer Agent\.app$/);
    assert.match(verifiedPaths[1], /Contents\/Resources\/bin\/peer-credential-helper$/);
    assert.match(verifiedPaths[2], /\.peer-cli-helper-.*\/peer-credential-helper$/);
    const archive = packageCliArchive({ targetSpec: 'darwin-arm64', repositoryRoot: f.root, distDir: f.distDir });
    const extraction = join(f.root, 'check');
    mkdirSync(extraction);
    const tar = spawnSync('tar', ['-xzf', archive.archivePath, '-C', extraction], { encoding: 'utf8' });
    assert.equal(tar.status, 0, tar.stderr);
    assert.deepEqual(readFileSync(join(extraction, 'peer-darwin-arm64', 'peer-credential-helper')), f.signedBytes);
    assertClean(f);
  });

  for (const [label, overrides, pattern] of [
    ['wrong version', { version: '0.1.0-rc.1' }, /version mismatch/],
    ['ad-hoc signature', { identity: 'Identifier=peer-credential-helper\nSignature=adhoc\nTeamIdentifier=not set\n' }, /Developer ID/],
    ['wrong team', { identity: 'Identifier=peer-credential-helper\nAuthority=Developer ID Application: Other\nTeamIdentifier=OTHER\n' }, /TeamIdentifier/],
    ['unstable identifier', { identity: 'Identifier=peer-credential-helper-UUID\nAuthority=Developer ID Application: Test\nTeamIdentifier=82672N97RP\n' }, /Identifier/],
    ['wrong architecture', { arch: 'x86_64' }, /architecture/],
    ['invalid signature', { signatureError: true }, /invalid signature/],
    ['extraction failure', { extractError: true }, /extraction failed/],
    ['copied signature failure', { copiedSignatureError: true }, /copied signature invalid/],
  ]) {
    it(`rejects ${label}, keeps the original helper and cleans staging`, (t) => {
      const f = fixture(t, overrides);
      assert.throws(() => prepareMacosCliHelper(f.options), pattern);
      assert.equal(readFileSync(join(f.distDir, 'peer-credential-helper'), 'utf8'), 'original ad-hoc helper');
      assertClean(f);
    });
  }

  it('cleans staging after destination installation fails', (t) => {
    const f = fixture(t);
    const destination = join(f.distDir, 'peer-credential-helper');
    rmSync(destination);
    mkdirSync(destination);
    writeFileSync(join(destination, 'sentinel'), 'keep');
    assert.throws(() => prepareMacosCliHelper(f.options), /EISDIR|ENOTDIR/);
    assert.equal(readFileSync(join(destination, 'sentinel'), 'utf8'), 'keep');
    assertClean(f);
  });

  it('rejects absent same-version artifacts and non-macOS use before extraction', (t) => {
    const f = fixture(t);
    rmSync(join(f.options.artifactDir, 'Peer-Agent-0.1.0-rc.2-arm64.zip'));
    assert.throws(() => prepareMacosCliHelper(f.options), /archive/);
    assert.throws(() => prepareMacosCliHelper({ ...f.options, platform: 'linux' }), /macOS/);
    assert.equal(f.commands.length, 0);
    assertClean(f);
  });

  it('release downloads the same-run signed mac artifact before helper assembly and archive creation', () => {
    const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
    const cli = workflow.split('  build-cli:')[1].split('\n  release:')[0];
    assert.match(cli, /needs: \[meta, build\]/);
    const download = cli.indexOf('name: Download signed macOS desktop artifact');
    const prepare = cli.indexOf('name: Prepare signed macOS CLI helper');
    const archive = cli.indexOf('name: Package CLI archive');
    assert.ok(download >= 0 && download < prepare && prepare < archive);
    assert.match(cli.slice(download, prepare), /actions\/download-artifact@/);
    assert.match(cli.slice(download, prepare), /name: dist-mac/);
    assert.match(cli.slice(prepare, archive), /prepare-macos-cli-helper\.mjs.*needs\.meta\.outputs\.version/);
    assert.match(cli.slice(download, prepare), /if: matrix\.target == 'darwin-arm64'/);
    assert.match(cli.slice(prepare, archive), /if: matrix\.target == 'darwin-arm64'/);
  });
});

describe('packageCliArchive', () => {
  it('builds peer-linux-x64.tar.gz with peer + helper side by side', () => {
    const root = mkdtempSync(join(tmpdir(), 'peer-cli-pkg-'));
    const distDir = join(root, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'peer'), '#!/bin/sh\necho peer\n');
    writeFileSync(join(distDir, 'peer-credential-helper'), '#!/bin/sh\necho helper\n');
    chmodSync(join(distDir, 'peer'), 0o755);
    chmodSync(join(distDir, 'peer-credential-helper'), 0o755);

    const result = packageCliArchive({
      targetSpec: 'linux-x64',
      repositoryRoot: root,
      distDir,
      stageDir: join(root, 'cli-stage'),
      outputDir: join(root, 'cli-dist'),
    });

    assert.equal(result.archive, 'peer-linux-x64.tar.gz');
    assert.equal(result.folder, 'peer-linux-x64');
    assert.match(result.archivePath, /peer-linux-x64\.tar.gz$/);

    const tar = spawnSync('tar', ['-tzf', result.archivePath], { encoding: 'utf8' });
    assert.equal(tar.status, 0, tar.stderr);
    assert.match(tar.stdout, /peer-linux-x64\/peer$/m);
    assert.match(tar.stdout, /peer-linux-x64\/peer-credential-helper$/m);
  });
});
