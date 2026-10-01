import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConversationStore } from '@peer-agent/conversation-store';
import { createInputQueue, RECOVERY_PHASES } from '@peer-agent/runtime-node';
const childFile = fileURLToPath(new URL('./test-fixtures/recovery-crash-child.mjs', import.meta.url));
function prepare() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b4-kill-recovery-')); const workspacePath = path.join(root, 'workspace'); mkdirSync(workspacePath);
  const store = createConversationStore({ storeDir: path.join(root, 'conversations') });
  const parent = store.createConversation({ role: 'project_agent', workspaceId: 'ws-crash', workspacePath });
  writeFileSync(path.join(root, 'fixture.json'), JSON.stringify({ conversationId: parent.id, workspacePath }));
  createInputQueue({ rootDir: path.join(root, 'project-runtime') }).submitInput({ workspaceId: 'ws-crash', inputId: 'input-one', surface: 'desktop', text: 'Read the project once' });
  return root;
}
function run(root, phase = '') {
  return new Promise((resolve, reject) => {
    const child = fork(childFile, [root, phase], { env: { ...process.env, PEER_AGENT_HOME: root }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let errors = '', result; let killed = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`fixture timed out ${phase}: ${errors}`)); }, 12_000);
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('message', message => { if (message.checkpoint === phase) { killed = true; child.kill('SIGKILL'); } else if (message.done) result = message; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer);
      if (phase && killed && signal === 'SIGKILL') resolve({ killed: true });
      else if (code === 0 && result) resolve(result);
      else reject(new Error(`fixture ${phase} exited ${code}/${signal}: ${errors}`));
    });
  });
}

test('real kill -9 at every recovery phase and durable write gap preserves one input, one task and one reply', { timeout: 120_000 }, async t => {
  const baselineRoot = prepare(); let baseline;
  try { baseline = await run(baselineRoot); assert.deepEqual(baseline.counts, { inputs: 1, tasks: 1, replies: 1 }); }
  finally { rmSync(baselineRoot, { recursive: true, force: true }); }
  for (const phase of [...RECOVERY_PHASES, 'input_written', 'task_created', 'reply_written']) await t.test(phase, async () => {
    const root = prepare();
    try { assert.equal((await run(root, phase)).killed, true); await new Promise(resolve => setTimeout(resolve, 1100)); const restored = await run(root);
      assert.deepEqual(restored.counts, baseline.counts); assert.equal(restored.reply, baseline.reply);
      assert.equal(restored.result.outcomes[0].ok, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
