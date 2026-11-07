import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { rehearseLegacyObligations } from './obligation-legacy-rehearsal.mjs';

test('main bot tools, host card, and list projection retire three legacy stopping records', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-obligation-rehearsal-'));
  const previous = process.env.PEER_AGENT_HOME;
  process.env.PEER_AGENT_HOME = root;
  try {
    const report = await rehearseLegacyObligations({ rootDir: root });
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.deepEqual(report.steps.map(step => step.step), ['inspect', 'card', 'confirm', 'resolve', 'lists']);
    const lists = report.steps.find(step => step.step === 'lists');
    assert.equal(lists.rows.every(row => row.inCurrentList === false && row.inObligations === true), true);
    assert.equal(lists.claimsReleased, false);
    const log = readFileSync(report.logPath, 'utf8');
    assert.match(log, /"event":"inspect"/);
    assert.match(log, /legacy_recorder_unproven/);
    assert.match(log, /"missing":\["bootId","pid","pidStart","hostId","acquiredAt"\]/);
    assert.match(log, /"event":"authorize"/);
    assert.match(log, /"event":"confirm"/);
    assert.match(log, /"event":"resolve"/);
    assert.equal(log.includes('syn-call-b'), false);
  } finally {
    if (previous === undefined) delete process.env.PEER_AGENT_HOME;
    else process.env.PEER_AGENT_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
