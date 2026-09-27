import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMemoryStore } from './memory-store.mjs';

function tempRoot(name) {
  return mkdtempSync(path.join(os.tmpdir(), `b2-10-${name}-`));
}

function messages(id = 'm-user') {
  return [{ id, role: 'user', kind: 'user_input', content: '记住：登录页在 src/login.tsx' }];
}

function stated(store, extra = {}) {
  return store.rememberStated({
    workspaceId: 'ws-1',
    kind: 'fact',
    text: '登录页在 src/login.tsx',
    anchorMessageId: 'm-user',
    messages: messages(),
    ...extra,
  });
}

test('追加写按 id 折叠，坏行不影响其余条目', () => {
  const root = tempRoot('fold');
  try {
    const store = createMemoryStore({ rootDir: root });
    const saved = stated(store);
    assert.equal(saved.ok, true);
    appendFileSync(store.projectFile('ws-1'), '\n{broken\n{"id":"skip"}\n', 'utf8');
    const forgotten = store.forget({
      id: saved.item.id,
      reason: '用户要求忘掉',
      workspaceId: 'ws-1',
    });
    assert.equal(forgotten.ok, true);
    const folded = store.list({ workspaceId: 'ws-1', scope: 'project' });
    assert.equal(folded.length, 1);
    assert.equal(folded[0].id, saved.item.id);
    assert.equal(folded[0].status, 'forgotten');
    const records = readFileSync(store.projectFile('ws-1'), 'utf8')
      .trim()
      .split('\n')
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          return parsed?.id === saved.item.id ? [parsed] : [];
        } catch {
          return [];
        }
      });
    assert.equal(records.length, 2);
    assert.equal(records[0].status, 'active');
    assert.equal(records[1].status, 'forgotten');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('用户原话锚点写成 stated，无锚点或其他消息不落盘', () => {
  const root = tempRoot('stated');
  try {
    const store = createMemoryStore({ rootDir: root });
    const saved = stated(store, { trust: 'verified', sourceRefs: ['ev-forged'] });
    assert.equal(saved.item.trust, 'stated');
    assert.equal(saved.item.status, 'active');
    assert.deepEqual(saved.item.sourceRefs, ['m-user']);
    assert.equal(existsSync(store.projectFile('ws-1')), true);
    const before = readFileSync(store.projectFile('ws-1'), 'utf8');

    const missing = stated(store, { anchorMessageId: undefined, text: '没有锚点的事实' });
    assert.equal(missing.reason, 'anchor_required');
    const assistant = store.rememberStated({
      workspaceId: 'ws-1',
      kind: 'fact',
      text: '代理自己说的',
      anchorMessageId: 'm-agent',
      messages: [{ id: 'm-agent', role: 'assistant', kind: 'agent_reply', content: '记一下' }],
    });
    assert.equal(assistant.reason, 'anchor_not_user_input');
    assert.equal(readFileSync(store.projectFile('ws-1'), 'utf8'), before);
    assert.equal(store.list({ workspaceId: 'ws-1', scope: 'project' }).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verified 必须有 sourceRefs，偏好只进用户作用域', () => {
  const root = tempRoot('verified');
  try {
    const store = createMemoryStore({ rootDir: root });
    const missing = store.writeVerified({
      workspaceId: 'ws-1',
      kind: 'procedure',
      text: '改完跑 pnpm test',
      sourceRefs: [],
    });
    assert.equal(missing.reason, 'source_refs_required');
    assert.equal(existsSync(store.projectFile('ws-1')), false);

    const saved = store.writeVerified({
      workspaceId: 'ws-1',
      kind: 'procedure',
      text: '改完跑 pnpm test',
      sourceRefs: ['ev-1'],
    });
    assert.equal(saved.item.trust, 'verified');
    assert.deepEqual(saved.item.sourceRefs, ['ev-1']);

    const preference = store.rememberStated({
      kind: 'preference',
      text: '只说结论',
      anchorMessageId: 'm-user',
      messages: messages(),
    });
    assert.equal(preference.item.scope, 'user');
    assert.equal(preference.item.workspaceId, undefined);
    assert.equal(existsSync(path.join(root, 'memory', 'items.jsonl')), true);
    assert.equal(store.list({ scope: 'user' }).some((item) => item.id === preference.item.id), true);
    const projectPreference = store.writeVerified({
      workspaceId: 'ws-1',
      kind: 'preference',
      text: '这条不该进项目',
      sourceRefs: ['ev-2'],
    });
    assert.equal(projectPreference.item.scope, 'user');
    assert.equal(store.list({ workspaceId: 'ws-1', scope: 'project' }).some((item) => item.kind === 'preference'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('忘掉只改状态，恢复后原文还在', () => {
  const root = tempRoot('restore');
  try {
    const store = createMemoryStore({ rootDir: root });
    const saved = stated(store);
    const forgotten = store.forget({
      id: saved.item.id,
      reason: '先忘掉',
      workspaceId: 'ws-1',
    });
    assert.equal(forgotten.item.status, 'forgotten');
    assert.equal(store.list({ workspaceId: 'ws-1', status: 'active', scope: 'project' }).length, 0);
    const file = readFileSync(store.projectFile('ws-1'), 'utf8');
    assert.equal(file.includes('登录页在 src/login.tsx'), true);
    const again = store.forget({
      id: saved.item.id,
      reason: '再忘掉一次',
      workspaceId: 'ws-1',
    });
    assert.equal(again.alreadyForgotten, true);
    assert.equal(readFileSync(store.projectFile('ws-1'), 'utf8'), file);

    const restored = store.restore({ id: saved.item.id, workspaceId: 'ws-1' });
    assert.equal(restored.item.status, 'active');
    assert.equal(restored.item.text, '登录页在 src/login.tsx');
    assert.equal(store.get(saved.item.id).status, 'active');
    const other = store.forget({
      id: saved.item.id,
      reason: '别的项目不能撤',
      workspaceId: 'ws-2',
    });
    assert.equal(other.reason, 'not_found');
    assert.equal(store.get(saved.item.id).status, 'active');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('密钥和令牌被拒绝，已有条目保持原样', () => {
  const root = tempRoot('secret');
  try {
    const store = createMemoryStore({ rootDir: root });
    const saved = stated(store);
    const before = readFileSync(store.projectFile('ws-1'), 'utf8');
    const samples = [
      'key is sk-abcdefghi',
      'Authorization: Bearer abcdefgh',
      'api_key=secret-value',
      'AKIAIOSFODNN7EXAMPLE',
      'export AWS_SECRET_ACCESS_KEY=abcd',
    ];
    for (const text of samples) {
      const denied = stated(store, { text, anchorMessageId: 'm-user' });
      assert.equal(denied.reason, 'sensitive', text);
      assert.equal(readFileSync(store.projectFile('ws-1'), 'utf8'), before);
      assert.equal(before.includes(text), false);
    }
    const reason = store.forget({
      id: saved.item.id,
      reason: 'token sk-abcdefghi',
      workspaceId: 'ws-1',
    });
    assert.equal(reason.reason, 'sensitive');
    assert.equal(store.get(saved.item.id).status, 'active');
    assert.equal(readFileSync(store.projectFile('ws-1'), 'utf8'), before);
    const ordinary = stated(store, { text: '登录页使用 token 刷新会话' });
    assert.equal(ordinary.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('固定、编辑和最近使用都追加在原条目上', () => {
  const root = tempRoot('page');
  try {
    const store = createMemoryStore({ rootDir: root, now: () => new Date('2026-09-27T00:00:00.000Z') });
    const saved = stated(store);
    const pinned = store.setPinned({ id: saved.item.id, pinned: true, workspaceId: 'ws-1' });
    assert.equal(pinned.ok, true);
    assert.equal(pinned.item.pinned, true);
    const unpinned = store.setPinned({ id: saved.item.id, pinned: false, workspaceId: 'ws-1' });
    assert.equal(unpinned.item.pinned, false);

    const edited = store.reviseStated({
      id: saved.item.id,
      text: '登录页改到 src/auth/login.tsx',
      workspaceId: 'ws-1',
    });
    assert.equal(edited.ok, true);
    assert.equal(edited.item.trust, 'stated');
    assert.deepEqual(edited.item.sourceRefs, [`edit:${saved.item.id}`]);
    assert.notEqual(edited.item.id, saved.item.id);
    assert.equal(store.get(saved.item.id).status, 'forgotten');
    const stillAnchored = store.rememberStated({
      workspaceId: 'ws-1',
      kind: 'fact',
      text: '没有锚点不能走工具路径',
    });
    assert.equal(stillAnchored.reason, 'anchor_required');

    const used = store.markUsed([edited.item.id], '2026-09-27T09:00:00.000Z');
    assert.equal(used[0].lastUsedAt, '2026-09-27T09:00:00.000Z');
    assert.equal(used[0].text, '登录页改到 src/auth/login.tsx');
    assert.equal(store.get(edited.item.id).lastUsedAt, '2026-09-27T09:00:00.000Z');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workspaceId 不能逃出项目目录', () => {
  const root = tempRoot('path');
  try {
    const store = createMemoryStore({ rootDir: root });
    const denied = stated(store, { workspaceId: '../outside' });
    assert.equal(denied.reason, 'invalid_workspace');
    assert.equal(existsSync(path.join(root, 'outside')), false);
    assert.equal(existsSync(path.join(path.dirname(root), 'outside')), false);
    assert.equal(existsSync(store.projectFile('ws-1')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
