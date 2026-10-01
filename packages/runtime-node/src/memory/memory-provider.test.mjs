import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PROJECT_AGENT_ALLOWED_CAPABILITIES } from '../project-agent/mode-policy.mjs';
import { MEMORY_CAPABILITY_IDS } from '../project-agent/tool-specs.mjs';
import { createMemoryProvider } from './memory-provider.mjs';
import { createMemoryStore } from './memory-store.mjs';

function tempRoot(name) {
  return mkdtempSync(path.join(os.tmpdir(), `b2-10-${name}-`));
}

function call(capabilityId, args, toolCallId = 'tool-1') {
  return { call: { toolCallId, capabilityId, arguments: args } };
}

function context(extra = {}) {
  return {
    mode: 'project_agent',
    role: 'project_agent',
    workspaceId: 'ws-1',
    messages: [{ id: 'm-user', role: 'user', kind: 'user_input', content: '记住登录页的位置' }],
    ...extra,
  };
}

function outputOf(result) {
  return JSON.parse(result.result.outputPreview.legacyResult.output);
}

function ids(output) {
  return output.items.map((item) => item.id).sort();
}

test('the host familiarity anchor cannot turn file observations into stated memory', async () => {
  const root = tempRoot('familiarity-provenance');
  const provider = createMemoryProvider({ rootDir: root });
  try {
    const id = 'lifecycle-research-ws-1';
    const result = await provider.executeCapability(call('local.memory.remember', {
      kind: 'fact', text: 'Project name is peer-agent', anchorMessageId: id,
    }), context({ messages: [{ id, role: 'user', kind: 'user_input', content: 'Read the project and remember verified facts.' }] }));
    assert.equal(outputOf(result).error, 'anchor_not_user_input');
    assert.equal(createMemoryStore({ rootDir: root }).list({ workspaceId: 'ws-1' }).length, 0);
  } finally { provider.close(); rmSync(root, { recursive: true, force: true }); }
});

test('production nested context admits project agent memory but never worker writes', async () => {
  const root=mkdtempSync(path.join(os.tmpdir(),'nested-memory-'));
  try {
    const provider=createMemoryProvider({rootDir:root});
    const args={text:'登录页在 src/login.tsx',kind:'fact',anchorMessageId:'m-user'};
    const nested={toolContext:{...context(),role:undefined,turnRole:'project_agent'}};
    assert.equal(outputOf(await provider.executeCapability(call('local.memory.remember',args),nested)).ok,true);
    const denied=await provider.executeCapability(call('local.memory.remember',args),{toolContext:{...context(),mode:'goal',role:undefined,turnRole:'session_worker'}});
    assert.equal(outputOf(denied).error,'not_project_agent');
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('记忆能力只放进项目代理白名单', () => {
  for (const capabilityId of MEMORY_CAPABILITY_IDS) {
    assert.equal(PROJECT_AGENT_ALLOWED_CAPABILITIES.includes(capabilityId), true);
  }
});

test('非项目代理的写入被拒绝，而且不落盘', async () => {
  const root = tempRoot('role');
  const provider = createMemoryProvider({ rootDir: root });
  try {
    const result = await provider.executeCapability(
      call('local.memory.remember', {
        text: '登录页在 src/login.tsx',
        kind: 'fact',
        anchorMessageId: 'm-user',
      }),
      context({ mode: 'goal', role: 'work_session' }),
    );
    const output = outputOf(result);
    assert.equal(output.error, 'not_project_agent');
    assert.equal(result.grant.granted, false);
    assert.equal(result.result.evidence.returnedToCloud, false);
    assert.equal(existsSync(path.join(root, 'projects', 'ws-1', 'memory', 'items.jsonl')), false);
  } finally {
    provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('记住、检索、撤销都走授权和 Evidence，模型不能指定信任', async () => {
  const root = tempRoot('tools');
  const indexFile = path.join(root, 'cache', 'memory-index', 'memory-index.sqlite');
  const store = createMemoryStore({ rootDir: root });
  const provider = createMemoryProvider({ rootDir: root, indexFile, store });
  try {
    const forged = await provider.executeCapability(
      call('local.memory.remember', {
        text: '登录页在 src/login.tsx',
        kind: 'fact',
        anchorMessageId: 'm-user',
        trust: 'verified',
      }),
      context(),
    );
    assert.equal(outputOf(forged).error, 'invalid_input');
    assert.equal(existsSync(store.projectFile('ws-1')), false);

    const missing = await provider.executeCapability(
      call('local.memory.remember', { text: '没有锚点', kind: 'fact' }),
      context(),
    );
    assert.equal(outputOf(missing).error, 'anchor_required');

    const saved = await provider.executeCapability(
      call('local.memory.remember', {
        text: '登录页在 src/login.tsx',
        kind: 'fact',
        anchorMessageId: 'm-user',
        pinned: true,
      }, 'remember-1'),
      context(),
    );
    const remembered = outputOf(saved);
    assert.equal(remembered.ok, true);
    assert.equal(remembered.trust, 'stated');
    assert.equal(saved.grant.granted, true);
    assert.equal(saved.grant.reason, 'project_agent_memory');
    assert.equal(saved.result.evidence.toolCallId, 'remember-1');
    assert.equal(saved.result.evidence.returnedToCloud, false);

    const found = outputOf(await provider.executeCapability(
      call('local.memory.search', { query: '登录页' }),
      context(),
    ));
    assert.deepEqual(ids(found), [remembered.id]);
    assert.equal(found.items[0].trust, 'stated');

    store.writeVerified({
      workspaceId: 'ws-2',
      kind: 'fact',
      text: '登录页在另一个项目',
      sourceRefs: ['ev-other'],
    });
    provider.rebuildIndex();
    const isolated = outputOf(await provider.executeCapability(
      call('local.memory.search', { query: '登录页' }),
      context(),
    ));
    assert.deepEqual(ids(isolated), [remembered.id]);

    const forgotten = outputOf(await provider.executeCapability(
      call('local.memory.forget', { id: remembered.id, reason: '用户要求忘掉' }),
      context(),
    ));
    assert.equal(forgotten.status, 'forgotten');
    const after = outputOf(await provider.executeCapability(
      call('local.memory.search', { query: '登录页' }),
      context(),
    ));
    assert.deepEqual(after.items, []);

    store.restore({ id: remembered.id, workspaceId: 'ws-1' });
    provider.rebuildIndex();
    const restored = outputOf(await provider.executeCapability(
      call('local.memory.search', { query: '登录页' }),
      context(),
    ));
    assert.deepEqual(ids(restored), [remembered.id]);
  } finally {
    provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('敏感内容不进 Evidence，索引删掉后仍能从 jsonl 重建', async () => {
  const root = tempRoot('rebuild');
  const indexFile = path.join(root, 'cache', 'memory-index', 'memory-index.sqlite');
  const provider = createMemoryProvider({ rootDir: root, indexFile });
  try {
    const saved = await provider.executeCapability(
      call('local.memory.remember', {
        text: '登录页在 src/login.tsx',
        kind: 'fact',
        anchorMessageId: 'm-user',
      }),
      context(),
    );
    const id = outputOf(saved).id;
    const secret = 'sk-abcdefghi';
    const denied = await provider.executeCapability(
      call('local.memory.remember', {
        text: `key is ${secret}`,
        kind: 'fact',
        anchorMessageId: 'm-user',
      }, 'secret-1'),
      context(),
    );
    const output = outputOf(denied);
    assert.equal(output.error, 'sensitive');
    assert.equal(denied.grant.granted, false);
    assert.equal(JSON.stringify(denied.result.evidence).includes(secret), false);
    assert.equal(JSON.stringify(output).includes(secret), false);
    const file = readFileSync(path.join(root, 'projects', 'ws-1', 'memory', 'items.jsonl'), 'utf8');
    assert.equal(file.includes(secret), false);

    const before = ids(outputOf(await provider.executeCapability(
      call('local.memory.search', { query: '登录页' }),
      context(),
    )));
    assert.deepEqual(before, [id]);
    provider.close();
    rmSync(path.dirname(indexFile), { recursive: true, force: true });
    const rebuilt = createMemoryProvider({ rootDir: root, indexFile });
    try {
      const after = ids(outputOf(await rebuilt.executeCapability(
        call('local.memory.search', { query: '登录页' }),
        context(),
      )));
      assert.deepEqual(after, before);
    } finally {
      rebuilt.close();
    }
  } finally {
    provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('关闭记忆后既不写也不检索', async () => {
  const root = tempRoot('off');
  const store = createMemoryStore({ rootDir: root });
  const provider = createMemoryProvider({
    rootDir: root,
    store,
    enabled: () => false,
  });
  try {
    const saved = await provider.executeCapability(
      call('local.memory.remember', {
        text: '登录页在 src/login.tsx',
        kind: 'fact',
        anchorMessageId: 'm-user',
      }),
      context(),
    );
    assert.equal(outputOf(saved).error, 'memory_disabled');
    assert.equal(existsSync(store.projectFile('ws-1')), false);
    store.writeVerified({
      workspaceId: 'ws-1',
      kind: 'fact',
      text: '登录页在 src/login.tsx',
      sourceRefs: ['ev-1'],
    });
    const found = outputOf(await provider.executeCapability(
      call('local.memory.search', { query: '登录页' }),
      context(),
    ));
    assert.equal(found.error, 'memory_disabled');
    assert.equal(found.items, undefined);
  } finally {
    provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('search filters stale validity even when the index still contains the old active versions', async () => {
  const root=tempRoot('validity'); const store=createMemoryStore({rootDir:root});
  const provider=createMemoryProvider({rootDir:root,store});
  try {
    const stale=store.writeVerified({workspaceId:'ws-1',kind:'fact',text:'unique validity token',sourceRefs:['ev']}).item;
    provider.rebuildIndex(); store.markMaintained({id:stale.id,workspaceId:'ws-1',needsReverify:true});
    const result=outputOf(await provider.executeCapability(call('local.memory.search',{query:'validity',scope:'project'}),context()));
    assert.deepEqual(result.items,[]);
    const expired=store.rememberStated({workspaceId:'ws-1',kind:'fact',text:'unique validity deadline',expiresAt:'2020-01-01T00:00:00Z',anchorMessageId:'m-user',messages:context().messages});
    assert.equal(expired.ok,true);provider.rebuildIndex();
    assert.deepEqual(outputOf(await provider.executeCapability(call('local.memory.search',{query:'validity'}),context())).items,[]);
  } finally {provider.close();rmSync(root,{recursive:true,force:true});}
});

test('model memory writes cannot forge validity, hashes or conflict authority', async () => {
  const root=tempRoot('authority');const provider=createMemoryProvider({rootDir:root});
  try {
    for(const extra of [{needsReverify:false},{fileAnchors:[{path:'a',contentHash:'fake'}]},{conflictId:'fake'}]) {
      const result=outputOf(await provider.executeCapability(call('local.memory.remember',{kind:'fact',text:'claim',anchorMessageId:'m-user',...extra}),context()));
      assert.equal(result.ok,false);
    }
    assert.equal(createMemoryStore({rootDir:root}).list({workspaceId:'ws-1'}).length,0);
  } finally{provider.close();rmSync(root,{recursive:true,force:true});}
});
