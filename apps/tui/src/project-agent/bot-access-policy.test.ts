import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApprovalStore, createBotAccessPolicyAuthority } from '@peer-agent/runtime-node';
import { createTuiHost, type TuiExecutionContext } from '../tui-host.ts';

function fixture(hookRunner: any = null) {
  const dataHome = mkdtempSync(path.join(os.tmpdir(), 'peer-tui-bot-access-'));
  for (const id of ['a', 'b']) {
    mkdirSync(path.join(dataHome, 'projects', id), { recursive: true });
    writeFileSync(path.join(dataHome, 'projects', id, 'profile.json'), JSON.stringify({ workspaceId: id,
      agentConversationId: `bot-${id}`, displayName: id, status: 'active', avatar: { kind: 'generated' } }));
  }
  const plans = new Map(['a', 'b'].map(id => [`p-${id}`, { planId: `p-${id}`, conversationId: `child-${id}`, status: 'executing',
    delegationOrigin: { workspaceId: id, sessionId: `s-${id}`, parentConversationId: `bot-${id}`, phase: 'running' } }]));
  const store = { getPlan: (id: string) => plans.get(id), getActivePlanByConversation: (id: string) => [...plans.values()].find(plan => plan.conversationId === id), recordEvidenceRefs() {} } as any;
  const authority = createBotAccessPolicyAuthority({ dataHome, legacyAccessLevel: 'full_local', goalPlanStore: store });
  expect(authority.initialize().ok).toBe(true);
  expect(authority.update({ workspaceId: 'b', expectedRevision: 1, accessLevel: 'ask_before_local' }).ok).toBe(true);
  const host = createTuiHost({ workspaceRoot: dataHome, userDataPath: dataHome, accessLevel: 'full_local', goalPlanStore: store, hookRunner });
  const context = (id: string, approver = false): TuiExecutionContext => ({ sessionId: 'runtime', turnId: 'same-turn', turnIndex: 0,
    conversationId: `child-${id}`, mode: 'chat', toolContext: { turnProfile: { role: 'work_session' } },
    project: { workspaceId: id, sessionId: `s-${id}`, planId: `p-${id}`, approver, holdsLease: () => true } });
  const change = (accessLevel: string) => { const current = authority.read('a'); if (!current.ok || !current.policy) throw new Error('No Bot policy'); return authority.update({ workspaceId: 'a', expectedRevision: current.policy.revision, accessLevel }); };
  return { dataHome, host, context, change, async close() { await host.dispose(); authority.close(); rmSync(dataHome, { recursive: true, force: true }); } };
}

test('the same TUI host and worker turn use current parent authority; global switching cannot grant another Bot', async () => {
  const f = fixture();
  try {
    const write = (id: string, name: string) => f.host.execute('local.file.write', { path: name, content: 'real write' }, f.context(id));
    const written = await write('a', 'a.txt');
    expect(written.result.status).toBe('completed');
    expect((written.result.permissionGrant as any).metadata.policyRevision).toMatch(/^bot:a:bot-a:1$/);
    expect((await write('b', 'b.txt')).result.status).toBe('denied');
    f.host.setAccessLevel('restricted_local');
    expect((await write('a', 'a-next.txt')).result.status).toBe('completed');
    f.change('ask_before_local'); f.host.setAccessLevel('full_local');
    expect((await write('a', 'a-after-revoke.txt')).result.status).toBe('denied');
    expect(existsSync(path.join(f.dataHome, 'a-after-revoke.txt'))).toBe(false);
  } finally { await f.close(); }
});

test('Bun and Node share persisted policy revisions without replaying the legacy migration', async () => {
  const f = fixture();
  try {
    const moduleUrl = new URL('../../../../packages/runtime-node/dist/index.js', import.meta.url).href;
    const child = Bun.spawnSync(['node', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { createBotAccessPolicyAuthority } from ${JSON.stringify(moduleUrl)};
      const authority = createBotAccessPolicyAuthority({ dataHome: process.argv[1], legacyAccessLevel: 'restricted_local' });
      try {
        const before = authority.read('a');
        assert.equal(before.ok, true); assert.equal(before.policy.accessLevel, 'full_local');
        const updated = authority.update({ workspaceId: 'a', expectedRevision: 1, accessLevel: 'ask_before_local' });
        assert.equal(updated.ok, true); assert.equal(updated.policy.revision, 2);
      } finally { authority.close(); }
    `, f.dataHome]);
    expect(child.exitCode).toBe(0);
    expect(child.stderr.toString()).not.toContain('AssertionError');
    const updated = f.change('full_local');
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.policy?.revision).toBe(3);
  } finally { await f.close(); }
});

test('TUI closes a live waiting approval after another authority instance changes the policy', async () => {
  const f = fixture();
  try {
    f.change('ask_before_local');
    let waiting = false;
    const unsubscribe = f.host.subscribeApproval(approval => { if (approval) waiting = true; });
    const write = f.host.execute('local.file.write', { path: 'never-written.txt', content: 'no' }, f.context('a', true));
    for (let tries = 0; !waiting && tries < 100; tries++) await Bun.sleep(10);
    expect(waiting).toBe(true); f.change('full_local');
    expect((await write).result.status).toBe('denied');
    expect(existsSync(path.join(f.dataHome, 'never-written.txt'))).toBe(false);
    const record = createApprovalStore({ rootDir: path.join(f.dataHome, 'project-runtime') }).list().at(-1);
    expect(record?.state).toBe('expired');
    expect(record?.decidedBy).toBe('policy');
    unsubscribe();
  } finally { await f.close(); }
});

test('an unavailable approval journal denies without publishing a live approval or leaving a watcher', async () => {
  const f = fixture();
  try {
    f.change('ask_before_local');
    mkdirSync(path.join(f.dataHome, 'project-runtime', 'a', 'approvals.jsonl'), { recursive: true });
    let approvals = 0;
    const unsubscribe = f.host.subscribeApproval(row => { if (row) approvals++; });
    const result = await f.host.execute('local.file.write', { path: 'unrecorded.txt', content: 'no' }, f.context('a', true));
    expect(result.result.status).toBe('denied');
    expect(approvals).toBe(0);
    expect(existsSync(path.join(f.dataHome, 'unrecorded.txt'))).toBe(false);
    unsubscribe();
  } finally { await f.close(); }
  await Bun.sleep(600);
});

test('a failed approval decision receipt denies and releases the queue for the next request', async () => {
  const f = fixture();
  try {
    f.change('ask_before_local');
    const journal = path.join(f.dataHome, 'project-runtime', 'a', 'approvals.jsonl');
    let approvals = 0;
    const unsubscribe = f.host.subscribeApproval(row => {
      if (!row) return;
      approvals++;
      if (approvals === 1) { rmSync(journal); mkdirSync(journal); }
      row.resolve('allow-once');
    });
    const first = await f.host.execute('local.file.write', { path: 'unrecorded-decision.txt', content: 'no' }, f.context('a', true));
    expect(first.result.status).toBe('denied');
    expect(existsSync(path.join(f.dataHome, 'unrecorded-decision.txt'))).toBe(false);
    rmSync(journal, { recursive: true });
    const second = await f.host.execute('local.file.write', { path: 'recorded-decision.txt', content: 'yes' }, f.context('a', true));
    expect(second.result.status).toBe('completed');
    expect(approvals).toBe(2);
    unsubscribe();
  } finally { await f.close(); }
});

test('a policy change during an async Hook blocks the old dispatch before its Provider can write', async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture({ async runPreToolUse() { f.change('ask_before_local'); return []; } });
  try {
    let approvals = 0;
    const unsubscribe = f.host.subscribeApproval(row => { if (row) { approvals++; row.resolve('allow-once'); } });
    const result = await f.host.execute('local.file.write', { path: 'blocked-by-new-policy.txt', content: 'no' }, f.context('a', true));
    expect(result.result.status).toBe('denied'); expect(approvals).toBe(0);
    expect(existsSync(path.join(f.dataHome, 'blocked-by-new-policy.txt'))).toBe(false);
    unsubscribe();
  } finally { await f.close(); }
});

test('revoking access while a shell command waits behind an active command prevents its later execution', async () => {
  const f = fixture();
  try {
    const running = f.host.executeShell('touch shell-started; sleep 0.4', f.context('a'));
    for (let n = 0; n < 100 && !existsSync(path.join(f.dataHome, 'shell-started')); n++) await Bun.sleep(10);
    expect(existsSync(path.join(f.dataHome, 'shell-started'))).toBe(true);
    const queued = f.host.executeShell('printf forbidden > queued-shell.txt', f.context('a'));
    await Bun.sleep(40);
    expect(existsSync(path.join(f.dataHome, 'queued-shell.txt'))).toBe(false);
    f.change('ask_before_local');
    expect((await running).result.status).toBe('completed');
    expect((await queued).result.status).toBe('denied');
    expect(existsSync(path.join(f.dataHome, 'queued-shell.txt'))).toBe(false);
  } finally { await f.close(); }
});
