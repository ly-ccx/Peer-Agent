import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./ci-install-linux-deps.sh', import.meta.url));

// No sudo, APT, downloads or wall-clock sleeps run on the test machine.
function fixture(t, statuses = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'peer-ci-apt-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sources = path.join(root, 'apt');
  const bin = path.join(root, 'bin');
  const temp = path.join(root, 'temp');
  for (const dir of [bin, temp, path.join(sources, 'sources.list.d')]) mkdirSync(dir, { recursive: true });
  const legacy = 'deb http://azure.archive.ubuntu.com/ubuntu noble main universe\n';
  const deb822 = 'Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble noble-updates\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n\nTypes: deb\nURIs: mirror+file:/etc/apt/apt-security-mirrors.txt\nSuites: noble-security\nComponents: main\n';
  const thirdParty = 'deb [signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/ubuntu/24.04/prod noble main\n';
  writeFileSync(path.join(sources, 'sources.list'), legacy);
  writeFileSync(path.join(sources, 'sources.list.d/ubuntu.sources'), deb822);
  writeFileSync(path.join(sources, 'sources.list.d/microsoft.list'), thirdParty);
  const log = path.join(root, 'calls.jsonl');
  const stub = `#!${process.execPath}
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const command=path.basename(process.argv[1]),args=process.argv.slice(2),log=process.env.PEER_CI_TEST_LOG;
const record=row=>appendFileSync(log,JSON.stringify(row)+'\\n');
const run=(bin,argv)=>{const r=spawnSync(bin,argv,{stdio:'inherit'});process.exit(r.status??1);};
if(command==='timeout'){record({command,args});run(args[3],args.slice(4));}
else if(command==='sudo'){if(args[0]!=='-n')throw Error('interactive sudo');run(args[1],args.slice(2));}
else if(command==='sleep'){record({command,args});}
else if(command==='apt-get'){
 const rows=(()=>{try{return readFileSync(log,'utf8').trim().split('\\n').map(JSON.parse);}catch{return [];}})();
 const option=key=>args.find(a=>a.startsWith(key+'=')).slice(key.length+1);
 const list=option('Dir::Etc::sourcelist'),parts=option('Dir::Etc::sourceparts');
 const sources={legacy:readFileSync(list,'utf8'),parts:Object.fromEntries(readdirSync(parts).map(n=>[n,readFileSync(path.join(parts,n),'utf8')]))};
 record({command,args,phase:args.includes('update')?'update':'install',sources});
 process.exit(JSON.parse(process.env.PEER_CI_TEST_STATUSES)[rows.filter(r=>r.command==='apt-get').length]??0);
}else throw Error('unexpected command');
`;
  for (const name of ['timeout', 'sudo', 'sleep', 'apt-get']) {
    const target = path.join(bin, name);
    writeFileSync(target, stub);
    chmodSync(target, 0o755);
  }
  const run = () => {
    const result = spawnSync('bash', [script, sources], {
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RUNNER_TEMP: temp,
        PEER_CI_TEST_LOG: log, PEER_CI_TEST_STATUSES: JSON.stringify(statuses) },
      encoding: 'utf8', timeout: 10_000,
    });
    const rows = (() => { try { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } })();
    assert.deepEqual(readdirSync(temp), [], 'owned source copies are cleaned on every exit');
    assert.equal(readFileSync(path.join(sources, 'sources.list'), 'utf8'), legacy, 'host sources stay unchanged');
    assert.equal(readFileSync(path.join(sources, 'sources.list.d/ubuntu.sources'), 'utf8'), deb822);
    assert.equal(readFileSync(path.join(sources, 'sources.list.d/microsoft.list'), 'utf8'), thirdParty);
    return { ...result, rows, apt: rows.filter(r => r.command === 'apt-get') };
  };
  return { run, sources, thirdParty };
}

test('healthy source succeeds once, with bounded commands and unchanged dependency coverage', t => {
  const { run } = fixture(t);
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.apt.map(c => c.phase), ['update', 'install']);
  assert.deepEqual(r.rows.filter(c => c.command === 'timeout').map(c => c.args.slice(0, 4)), [
    ['--signal=TERM', '--kill-after=5s', '90s', 'env'],
    ['--signal=TERM', '--kill-after=5s', '120s', 'env'],
  ]);
  for (const c of r.apt) {
    for (const option of ['Acquire::http::Timeout=15', 'Acquire::https::Timeout=15', 'Acquire::Retries=0', 'DPkg::Lock::Timeout=20']) assert.ok(c.args.includes(option));
  }
  assert.ok(r.apt[0].args.includes('--error-on=any'), 'partial index failures must fail the attempt');
  assert.deepEqual(r.apt[1].args.slice(r.apt[1].args.indexOf('install')), [
    'install', '-y', 'libdbus-1-dev', 'pkg-config', 'xvfb', 'libnss3', 'libatk-bridge2.0-0', 'libgtk-3-0', 'libgbm1', 'libasound2t64',
  ]);
});

test('failed index switches legacy and deb822 Ubuntu URIs to official HTTPS, preserving trust and third parties', t => {
  const { run, thirdParty } = fixture(t, [100, 0, 0]);
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.apt.map(c => c.phase), ['update', 'update', 'install']);
  assert.match(r.apt[0].sources.legacy, /azure\.archive/);
  const fallback = r.apt[1].sources;
  assert.equal(fallback.legacy, 'deb https://archive.ubuntu.com/ubuntu/ noble main universe\n');
  assert.match(fallback.parts['ubuntu.sources'], /URIs: https:\/\/archive\.ubuntu\.com\/ubuntu\//);
  assert.match(fallback.parts['ubuntu.sources'], /URIs: https:\/\/security\.ubuntu\.com\/ubuntu\//);
  assert.match(fallback.parts['ubuntu.sources'], /Signed-By: \/usr\/share\/keyrings\/ubuntu-archive-keyring.gpg/);
  assert.match(fallback.parts['ubuntu.sources'], /Suites: noble noble-updates/);
  assert.equal(fallback.parts['microsoft.list'], thirdParty);
});

test('command timeouts stop after three attempts and never install with a failed index', t => {
  const r = fixture(t, [124, 124, 124]).run();
  assert.equal(r.status, 124);
  assert.deepEqual(r.apt.map(c => c.phase), ['update', 'update', 'update']);
  assert.deepEqual(r.rows.filter(c => c.command === 'sleep').map(c => c.args), [['2'], ['4']]);
  assert.match(r.stdout + r.stderr, /failed after 3 attempts/);
});

test('download failure refreshes the fallback index before retrying installation', t => {
  const r = fixture(t, [0, 100, 0, 0]).run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.apt.map(c => c.phase), ['update', 'install', 'update', 'install']);
  assert.match(r.apt[2].sources.legacy, /https:\/\/archive\.ubuntu\.com/);
});

test('persistent install failure is not hidden by retries or a successful index', t => {
  const r = fixture(t, [0, 100, 0, 100, 0, 100]).run();
  assert.equal(r.status, 100);
  assert.equal(r.apt.length, 6);
});

test('cancellation exits immediately without retrying', t => {
  const r = fixture(t, [143]).run();
  assert.equal(r.status, 143);
  assert.equal(r.apt.length, 1);
  assert.equal(r.rows.some(c => c.command === 'sleep'), false);
});

test('workflow runs bootstrap tests before dependency acquisition and bounds the Linux step', () => {
  const yaml = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(yaml, /run: node --test scripts\/ci-install-linux-deps\.test\.mjs/);
  assert.match(yaml, /Install Linux credential-helper build deps\n\s+if: runner.os == 'Linux'\n\s+timeout-minutes: 12\n\s+run: bash scripts\/ci-install-linux-deps\.sh/);
});
