import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
const releaseTag = process.env.RELEASE_TAG?.trim();
const expectedTag = `v${version}`;

function fail(message) {
  console.error(`Release readiness check failed: ${message}`);
  process.exit(1);
}

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

if (releaseTag && releaseTag !== expectedTag) {
  fail(`RELEASE_TAG ${releaseTag} does not match VERSION ${version}`);
}

const releaseNotePath = join(root, 'release-notes', `${expectedTag}.md`);
if (!existsSync(releaseNotePath)) {
  fail(`missing release note release-notes/${expectedTag}.md`);
}

const releaseNote = readFileSync(releaseNotePath, 'utf8');
const localeMarker = /^\s*(?:<!--\s*)?locale:(zh-CN|en-US)(?:\s*-->)?\s*$/gm;
const markers = [...releaseNote.matchAll(localeMarker)];
for (const locale of ['zh-CN', 'en-US']) {
  const localeMarkers = markers.filter((match) => match[1] === locale);
  if (localeMarkers.length !== 1) {
    fail(`release-notes/${expectedTag}.md must contain exactly one ${locale} locale section`);
  }
  const marker = localeMarkers[0];
  const start = marker.index + marker[0].length;
  const next = markers.find((candidate) => candidate.index > marker.index);
  const body = releaseNote.slice(start, next?.index ?? releaseNote.length).trim();
  if (!/^##\s+\S/m.test(body) || !/^[-*]\s+\S/m.test(body)) {
    fail(`release-notes/${expectedTag}.md has an empty or incomplete ${locale} locale section`);
  }
}

run(process.execPath, ['scripts/check-version.mjs']);
run(process.execPath, ['scripts/build-changelog.mjs', '--check']);
run(process.execPath, ['scripts/stamp-version.mjs', version]);
run('git', [
  'diff',
  '--exit-code',
  'HEAD',
  '--',
  'VERSION',
  'README.md',
  'package.json',
  'apps',
  'packages',
  'crates',
  'Cargo.lock',
]);

console.log(`Release readiness check passed: ${expectedTag}`);
