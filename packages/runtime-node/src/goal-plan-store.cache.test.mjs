import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, writeFileSync, rmSync, utimesSync, statSync, renameSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGoalPlanStore } from './goal-plan-store.mjs';

function createTempStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'goal-plan-cache-'));
  const store = createGoalPlanStore({ storeDir: dir });
  return { dir, store };
}

test('evidence projection parses an unchanged index once and isolates nested caller mutations', t => {
  const { dir, store } = createTempStore();
  const file = path.join(dir, 'evidence-index.jsonl');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  store.recordEvidenceRefs({ evidenceRef: 'capture', capabilityId: 'local.file.read', toolName: 'read_file',
    bodyPreview: { kind: 'file', text: 'actual content' }, artifactRefs: ['file-ref'],
    userArtifacts: [{ ref: 'file-ref', kind: 'file', label: 'file',
      preview: { kind: 'code', additions: 1, deletions: 0, diffLines: ['+actual'] } }] });
  const original = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', (...args) => {
    if (args[0] === file) reads++;
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const first = store.listEvidenceIndex();
  first[0].evidenceRef = 'forged';
  first[0].artifactRefs.push('forged');
  first[0].bodyPreview.text = 'forged';
  first[0].userArtifacts[0].preview.diffLines[0] = '+forged';
  first.splice(0);
  for (let i = 0; i < 5; i++) {
    const current = store.listEvidenceIndex();
    assert.equal(current[0].evidenceRef, 'capture');
    assert.deepEqual(current[0].artifactRefs, ['file-ref']);
    assert.equal(current[0].bodyPreview.text, 'actual content');
    assert.deepEqual(current[0].userArtifacts[0].preview.diffLines, ['+actual']);
  }
  assert.equal(reads, 1, 'completion projections must share parsing, not mutable evidence records');
});

test('evidence projection sees same-size rewrites, replacements, deletion and corruption', t => {
  const { dir, store } = createTempStore();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'evidence-index.jsonl');
  const row = ref => JSON.stringify({ evidenceRef: ref, createdAt: '2026-01-01T00:00:00Z' }) + '\n';
  writeFileSync(file, row('old'));
  assert.equal(store.listEvidenceIndex()[0].evidenceRef, 'old');
  const originalStat = statSync(file);
  writeFileSync(file, row('new'));
  utimesSync(file, originalStat.atime, originalStat.mtime);
  assert.equal(store.listEvidenceIndex()[0].evidenceRef, 'new', 'ctime invalidates an mtime-restored rewrite');
  const replacement = path.join(dir, 'replacement.jsonl');
  writeFileSync(replacement, row('alt'));
  utimesSync(replacement, originalStat.atime, originalStat.mtime);
  renameSync(replacement, file);
  assert.equal(store.listEvidenceIndex()[0].evidenceRef, 'alt', 'file identity invalidates a same-size replacement');
  writeFileSync(file, '{invalid\n');
  assert.deepEqual(store.listEvidenceIndex(), [], 'corrupt records cannot retain an earlier valid snapshot');
  rmSync(file);
  assert.deepEqual(store.listEvidenceIndex(), []);
  writeFileSync(file, row('end'));
  assert.equal(store.listEvidenceIndex()[0].evidenceRef, 'end');
});

test('evidence projection sees local and cross-process appends immediately', t => {
  const { dir, store } = createTempStore();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(store.listEvidenceIndex(), []);
  store.recordEvidenceRefs({ evidenceRef: 'local' });
  assert.deepEqual(store.listEvidenceIndex().map(row => row.evidenceRef), ['local']);
  const nextHost = createGoalPlanStore({ storeDir: dir });
  nextHost.recordEvidenceRefs({ evidenceRef: 'remote' });
  assert.deepEqual(store.listEvidenceIndex().map(row => row.evidenceRef), ['local', 'remote']);
});

test('listPlans 缓存命中：index 未变化时复用结果（不重复 normalize 全量索引）', async () => {
  const { dir, store } = createTempStore();
  try {
    store.createPlan({ title: 'plan-a', goal: 'cache-test' });
    const first = store.listPlans();
    assert.equal(first.length, 1);

    // 第二次调用应命中 mtime+size 缓存并返回等值结果；
    // 用 spy 思路验证：直接对比两次结果一致性 + 时间大幅缩短（粗验证）。
    const t0 = process.hrtime.bigint();
    const second = store.listPlans();
    const t1 = process.hrtime.bigint();
    assert.equal(second.length, 1);
    assert.equal(second[0].planId, first[0].planId);
    // 真正复用归一化结果对象；数组本身是浅拷贝，避免调用方 sort 污染缓存。
    assert.equal(second[0], first[0]);
    assert.notEqual(second, first);
    // 缓存命中路径只做 stat + 浅拷贝，应在个位数 ms 内。
    assert.ok(Number(t1 - t0) < 50_000_000, `second listPlans took ${Number(t1 - t0) / 1e6}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('缓存失效：外部写入 index.jsonl 后 listPlans 感知新数据', async () => {
  const { dir, store } = createTempStore();
  try {
    store.createPlan({ title: 'plan-a', goal: 'cache-test' });
    assert.equal(store.listPlans().length, 1);

    // 模拟外部进程写入：直接 append 一条合法 index 记录（mtime/size 均变化）。
    const indexFile = path.join(dir, 'index.jsonl');
    const existing = store.listPlans();
    const externalRecord = {
      ...existing[0],
      planId: 'external-plan-0001',
      title: 'external-plan',
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(indexFile, JSON.stringify(externalRecord) + '\n', { flag: 'a' });

    const after = store.listPlans();
    assert.equal(after.length, 2, '外部写入后应看到新 plan（缓存已失效）');
    assert.ok(after.some((p) => p.planId === 'external-plan-0001'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同进程 persist 后 listPlans 立即反映变更（writeJsonl 使缓存失效）', async () => {
  const { dir, store } = createTempStore();
  try {
    store.createPlan({ title: 'plan-a', goal: 'cache-test' });
    store.createPlan({ title: 'plan-b', goal: 'cache-test' });
    // persist 走 writeJsonl（重写整个 index.jsonl），随后读取必须看到两条。
    assert.equal(store.listPlans().length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('旧宿主的待刷进度在新宿主写盘后失效，不覆盖接管状态', async () => {
  const { dir, store } = createTempStore();
  try {
    const plan = store.createPlan({ title: 'handoff', goal: 'handoff' });
    const nextHost = createGoalPlanStore({ storeDir: dir });
    store.setRunnerState(plan.planId, { turnCount: 7 });
    assert.equal(store.getPlan(plan.planId).runner.turnCount, 7);
    nextHost.setRunnerState(plan.planId, { status: 'paused', turnCount: 11 });
    assert.equal(store.getPlan(plan.planId).runner.turnCount, 11);
    assert.equal(store.getPlan(plan.planId).runner.status, 'paused');
    // Cover the pending flush without first reading from the old store.
    store.setRunnerState(plan.planId, { turnCount: 12 });
    nextHost.setRunnerState(plan.planId, { status: 'paused', turnCount: 23 });
    await new Promise(resolve => setTimeout(resolve, 1150));
    assert.equal(nextHost.getPlan(plan.planId).runner.turnCount, 23);
    assert.equal(store.getPlan(plan.planId).runner.turnCount, 23);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('证据索引跨进程追加后，命中和缺失缓存均失效且保留已有字段', () => {
  const { dir, store } = createTempStore();
  try {
    const nextHost = createGoalPlanStore({ storeDir: dir });
    assert.deepEqual(store.findEvidenceIndexRecords(['tool-result://shared']), []);
    nextHost.recordEvidenceRefs({ evidenceRefs: ['tool-result://shared'], toolName: 'read_file',
      artifactRefs: ['local-file-artifact://snapshot'] });
    assert.equal(store.findEvidenceIndexRecords(['tool-result://shared'])[0].toolName, 'read_file');
    nextHost.recordEvidenceRefs({ evidenceRefs: ['tool-result://shared'], capabilityId: 'local.file.read', toolName: 'read_file', bodyPreview: { kind: 'file', text: 'snapshot body' } });
    assert.equal(store.findEvidenceIndexRecords(['tool-result://shared'])[0].bodyPreview.text, 'snapshot body');
    store.recordEvidenceRefs({ evidenceRefs: ['tool-result://shared'], capabilityId: 'local.file.read' });
    const merged = nextHost.findEvidenceIndexRecords(['tool-result://shared'])[0];
    assert.equal(merged.bodyPreview.text, 'snapshot body');
    assert.deepEqual(merged.artifactRefs, ['local-file-artifact://snapshot']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('command evidence survives reload and cannot be supplied or overwritten by a goal wrapper', () => {
  const { dir, store } = createTempStore();
  try {
    const evidenceRef = 'tool-result://shell-check';
    const preview = { kind: 'command', text: '{"exitCode":0,"stdout":"observed","stderr":""}', truncated: false };
    store.recordEvidenceRefs({ evidenceRef, capabilityId: 'local.shell.exec', toolName: 'Bash', bodyPreview: preview });
    const reloaded = createGoalPlanStore({ storeDir: dir });
    assert.deepEqual(reloaded.findEvidenceIndexRecords([evidenceRef])[0].bodyPreview, preview);
    store.recordEvidenceRefs({ evidenceRef, capabilityId: 'local.shell.exec', toolName: 'goal_update_task',
      bodyPreview: { ...preview, text: 'forged' } });
    assert.deepEqual(reloaded.findEvidenceIndexRecords([evidenceRef])[0].bodyPreview, preview);
    store.recordEvidenceRefs({ evidenceRef: 'tool-result://wrapper', capabilityId: 'local.goal.update_task',
      toolName: 'goal_update_task', bodyPreview: preview });
    assert.equal(reloaded.findEvidenceIndexRecords(['tool-result://wrapper'])[0].bodyPreview, undefined);
    store.recordEvidenceRefs({ evidenceRef: 'tool-result://long-shell', capabilityId: 'local.shell.exec',
      toolName: 'bash', bodyPreview: { ...preview, text: 'x'.repeat(5000) } });
    const long = reloaded.findEvidenceIndexRecords(['tool-result://long-shell'])[0].bodyPreview;
    assert.equal(long.text.length, 4000); assert.equal(long.truncated, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
