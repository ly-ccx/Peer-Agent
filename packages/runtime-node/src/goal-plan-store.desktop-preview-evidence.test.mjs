import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGoalPlanStore } from './goal-plan-store.mjs';

function tempStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'goal-preview-evidence-'));
  return { dir, store: createGoalPlanStore({ storeDir: dir }) };
}

test('hasDesktopPreviewEvidence 只认带桌面预览产物的计划', () => {
  const { dir, store } = tempStore();
  try {
    const plan = store.createPlan({ title: 'UI', goal: 'panel' });
    const other = store.createPlan({ title: 'Code', goal: 'code' });
    store.recordEvidenceRefs({
      planId: plan.planId,
      evidenceRefs: ['note'],
      capabilityId: 'local.file.read',
      artifactRefs: ['file://notes.txt'],
    });
    assert.equal(store.hasDesktopPreviewEvidence(plan.planId), false);
    assert.equal(store.hasDesktopPreviewEvidence(other.planId), false);
    store.recordEvidenceRefs({
      planId: plan.planId,
      evidenceRefs: ['shot'],
      capabilityId: 'local.desktop.preview',
      artifactRefs: ['local-desktop-preview-artifact://panel'],
    });
    assert.equal(store.hasDesktopPreviewEvidence(plan.planId), true);
    assert.equal(store.hasDesktopPreviewEvidence(other.planId), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('证据索引被外部改写后，预览成员按新文件重算', () => {
  const { dir, store } = tempStore();
  try {
    const plan = store.createPlan({ title: 'UI', goal: 'panel' });
    store.recordEvidenceRefs({
      planId: plan.planId,
      evidenceRefs: ['shot'],
      capabilityId: 'local.desktop.preview',
      artifactRefs: ['local-desktop-preview-artifact://panel'],
    });
    assert.equal(store.hasDesktopPreviewEvidence(plan.planId), true);
    const indexPath = path.join(dir, 'evidence-index.jsonl');
    const rows = readFileSync(indexPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    for (const row of rows) row.capabilityId = 'local.file.read';
    writeFileSync(indexPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    assert.equal(store.hasDesktopPreviewEvidence(plan.planId), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('重复查询复用同一份索引扫描', () => {
  const { dir, store } = tempStore();
  try {
    const plan = store.createPlan({ title: 'UI', goal: 'panel' });
    const lines = [];
    for (let i = 0; i < 20000; i += 1) {
      lines.push(JSON.stringify({
        evidenceRef: `e${i}`,
        planId: `other-${i}`,
        capabilityId: 'local.file.read',
        createdAt: '2026-01-01T00:00:00.000Z',
      }));
    }
    lines.push(JSON.stringify({
      evidenceRef: 'shot',
      planId: plan.planId,
      capabilityId: 'local.desktop.preview',
      artifactRefs: ['local-desktop-preview-artifact://panel'],
      createdAt: '2026-01-01T00:00:00.000Z',
    }));
    writeFileSync(path.join(dir, 'evidence-index.jsonl'), `${lines.join('\n')}\n`);
    assert.equal(store.hasDesktopPreviewEvidence(plan.planId), true);
    const started = process.hrtime.bigint();
    for (let i = 0; i < 100; i += 1) {
      assert.equal(store.hasDesktopPreviewEvidence(plan.planId), true);
      assert.equal(store.hasDesktopPreviewEvidence('missing'), false);
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 50, `cached lookups took ${elapsedMs}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
