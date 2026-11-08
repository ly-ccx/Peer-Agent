import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { DELEGATION_SUPERVISOR_METHODS, installDelegation, liveDelegationSupervisor } from './delegation-port.mjs';
import { rehearseLegacyObligationsOnDesktop } from './obligation-desktop-rehearsal.mjs';

const providerSources = [
  '../../../../../packages/runtime-node/src/project-agent/delegation-provider.mjs',
  '../../../../../packages/runtime-node/src/project-agent/working-context.mjs',
];

function supervisorMethods(source) {
  return [...source.matchAll(/supervisor\??\.([A-Za-z]+)/g)].map(match => match[1]);
}

describe('desktop obligation bridge', { concurrency: false }, () => {
test('desktop bridge forwards every supervisor method the providers call', async () => {
  const used = new Set(providerSources.flatMap(file => supervisorMethods(readFileSync(new URL(file, import.meta.url), 'utf8'))));
  assert.ok(used.has('inspectExecutionObligations'));
  assert.ok(used.has('requestObligationAuthorization'));
  assert.ok(used.has('resolveExecutionObligation'));
  const bridge = liveDelegationSupervisor();
  for (const name of used) {
    assert.equal(DELEGATION_SUPERVISOR_METHODS.includes(name), true, name);
    assert.equal(typeof bridge[name], 'function', name);
  }
  const seen = [];
  const uninstall = installDelegation({
    supervisor: Object.fromEntries(DELEGATION_SUPERVISOR_METHODS.map(name => [name, (input) => {
      seen.push(name);
      return { ok: true, method: name, probe: input?.probe || null };
    }])),
  });
  try {
    for (const name of used) {
      const result = await liveDelegationSupervisor()[name]({ probe: name });
      assert.equal(result.method, name);
      assert.equal(result.error, undefined);
    }
  } finally {
    uninstall();
  }
  assert.deepEqual([...used].sort(), [...new Set(seen)].sort());
  const missing = installDelegation({ supervisor: {} });
  try {
    assert.equal((await liveDelegationSupervisor().inspectExecutionObligations({})).error, 'supervisor_unavailable');
  } finally {
    missing();
  }
  const preload = readFileSync(new URL('../../preload/preload.source.cjs', import.meta.url), 'utf8');
  const channels = readFileSync(new URL('../../ipc/channels.mjs', import.meta.url), 'utf8');
  assert.match(preload, /projectAgentListObligationGrants: \(params\) => ipcRenderer\.invoke\('project-agent:list-obligation-grants'/);
  assert.match(preload, /projectAgentDecideObligation: \(params\) => ipcRenderer\.invoke\('project-agent:decide-obligation'/);
  assert.match(channels, /project-agent:list-obligation-grants/);
  assert.match(channels, /project-agent:decide-obligation/);
});

test('legacy records retire through the live supervisor and local tool host', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-obligation-desktop-'));
  const previous = process.env.PEER_AGENT_HOME;
  process.env.PEER_AGENT_HOME = root;
  try {
    const report = await rehearseLegacyObligationsOnDesktop({ rootDir: root });
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(report.steps.find(step => step.step === 'request-one').count, 1);
    assert.equal(report.steps.find(step => step.step === 'request-three').count, 3);
    const confirms = report.steps.filter(step => step.step === 'confirm');
    assert.equal(confirms.length, 2);
    assert.equal(confirms.every(step => step.ok === true && step.grants?.some(grant => grant.grantId === step.grantId)), true);
    assert.equal(report.steps.filter(step => step.step === 'resolve').every(step => step.replayed === true), true);
    const log = readFileSync(report.logPath, 'utf8');
    assert.match(log, /"event":"inspect"/);
    assert.match(log, /legacy_recorder_unproven/);
    assert.match(log, /"missing":\["bootId","pid","pidStart","hostId","acquiredAt"\]/);
    assert.equal(log.includes('syn-call-b'), false);
  } finally {
    if (previous === undefined) delete process.env.PEER_AGENT_HOME;
    else process.env.PEER_AGENT_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
});
