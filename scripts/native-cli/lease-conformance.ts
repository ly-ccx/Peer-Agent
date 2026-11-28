import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createHostLease, HOST_LEASE_HEARTBEAT_MS, HOST_LEASE_STALE_MS } from '../../packages/runtime-node/src/project-agent/host-lease.mjs';

const root = mkdtempSync(join(tmpdir(), 'peer-native-lease-'));
writeFileSync(join(root, '.native-cli-fixture'), 'synthetic');
let now = 1000; let cases = 0;
const ts = createHostLease({ rootDir: join(root, 'project-runtime'), hostId: 'ts', surface: 'desktop', pid: process.pid,
  appVersion: 'fixture', now: () => now, schedule: () => ({ unref() {} }), cancel() {} });
const child = spawn(resolve(process.argv[2] ?? 'target/debug/examples/lease-conformance'), [], {
  env: { ...process.env, PEER_NATIVE_CONFORMANCE_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'],
});
let pending: { yes: (value: any) => void; no: (error: Error) => void } | null = null;
let stderr = '';
child.stderr.on('data', bytes => { stderr += bytes.toString(); assert(stderr.length < 16384); });
const done = new Promise<void>((yes, no) => { child.once('error', no); child.once('close', code => { pending?.no(Error(`fixture exit ${code}: ${stderr}`)); code === 0 ? yes() : no(Error(stderr)); }); });
const lines = createInterface({ input: child.stdout });
lines.on('line', line => { assert(line.length < 16384); assert(pending, 'unexpected fixture line'); const current = pending; pending = null; current.yes(JSON.parse(line)); });
function response() {
  return new Promise<any>((yes, no) => {
    assert.equal(pending, null);
    const timer = setTimeout(() => { child.kill(); no(Error('fixture response deadline')); }, 5000);
    pending = { yes: value => { clearTimeout(timer); yes(value); }, no: error => { clearTimeout(timer); no(error); } };
  });
}
async function native(op: string, workspace: string, at = now) {
  const reply = response(); child.stdin.write(`${JSON.stringify({ op, workspace, now: at })}\n`); return reply;
}
const file = (workspace: string) => join(root, 'project-runtime', workspace, 'host.lease');
try {
  assert.deepEqual(await response(), { ready: true, heartbeatMs: HOST_LEASE_HEARTBEAT_MS, staleMs: HOST_LEASE_STALE_MS }); cases++;
  assert.equal(ts.acquire('from-ts').acquired, true);
  assert.deepEqual((await native('inspect', 'from-ts')).lease, JSON.parse(readFileSync(file('from-ts'), 'utf8'))); cases++;
  assert.equal((await native('acquire', 'from-ts')).acquired, false); cases++;
  now = 6000; ts.pulse();
  assert.equal((await native('inspect', 'from-ts')).lease.heartbeatAt, new Date(now).toISOString()); cases++;
  now = 26_000;
  const taken = await native('acquire', 'from-ts'); assert.equal(taken.acquired, true); assert.equal(taken.tookOver, true);
  assert.equal(ts.holds('from-ts'), false); assert.equal(ts.release('from-ts'), false);
  assert.equal(JSON.parse(readFileSync(file('from-ts'), 'utf8')).hostId, 'native'); cases++;
  assert.equal(ts.requestTakeover('from-ts').requested, true);
  assert.equal((await native('pending', 'from-ts')).pending, true);
  assert.equal((await native('heartbeat', 'from-ts', 31_000)).ok, true);
  now = 31_000; assert.equal(ts.acquire('from-ts').acquired, false); cases++;
  assert.equal((await native('release', 'from-ts')).ok, true); assert.equal(ts.acquire('from-ts').acquired, true); cases++;
  assert.equal((await native('acquire', 'from-native')).acquired, true);
  assert.equal(ts.acquire('from-native').acquired, false); cases++;
  assert.equal((await native('takeover', 'from-ts')).requested, true);
  // TS processes the real native host.yield, then runs its configured drain port.
  let drained = false; ts.setYieldHandler(async () => { drained = true; }); ts.pulse(); await ts.awaitDrained();
  assert.equal(drained, true); assert.equal(ts.holds('from-ts'), false); cases++;
  now = 51_000; const tsTaken = ts.acquire('from-native'); assert.equal(tsTaken.acquired, true); assert.equal(tsTaken.tookOver, true);
  assert.equal((await native('holds', 'from-native')).holds, false);
  assert.equal((await native('heartbeat', 'from-native')).code, 'HOST_LEASE_LOST');
  assert.equal((await native('release', 'from-native')).code, 'HOST_LEASE_LOST');
  assert.equal(JSON.parse(readFileSync(file('from-native'), 'utf8')).hostId, 'ts'); cases++;
  const racing = native('acquire', 'race'); const tsRace = ts.acquire('race'); const rustRace = await racing;
  assert.equal([tsRace, rustRace].filter(result => result.acquired).length, 1); cases++;
  // Preserve corrupt data; native admission intentionally does not mimic legacy reclaim-on-parse-error.
  const badPath = file('from-native'); const good = readFileSync(badPath, 'utf8'); writeFileSync(badPath, 'corrupt');
  assert.throws(() => ts.diagnosticSnapshot('from-native'), /CORRUPT_LEASE/);
  assert.equal((await native('acquire', 'from-native')).code, 'CORRUPT_LEASE');
  assert.equal(readFileSync(badPath, 'utf8'), 'corrupt'); writeFileSync(badPath, good); cases++;
  assert.equal((await native('acquire', 'abandoned')).acquired, true);
  child.stdin.end(); await done;
  assert.equal(ts.acquire('abandoned').acquired, false); now += HOST_LEASE_STALE_MS;
  assert.equal(ts.acquire('abandoned').acquired, true); cases++;
  process.stdout.write(`${JSON.stringify({ passed: cases, fixtureRoot: root, coverage: 'Real TS/native lease ownership, heartbeat, yield, stale handles and two-process race; no execution stop proof or production admission.' })}\n`);
} finally { child.stdin.end(); child.kill(); ts.close(); }
