import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getApplicationShellTasks, disposeApplicationShellTasks } from './runtime-gateway/application-shell-tasks.mjs';
import { createLocalShellProvider } from './runtime-gateway/local-shell-provider.mjs';
import { createLocalToolHost } from './runtime-gateway/local-tool-host.mjs';

test('application host sees task launched by a separate provider and can stop it', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'peer-global-task-'));
  const manager = getApplicationShellTasks(home);
  const provider = createLocalShellProvider({ workspaceRoot: home, userDataPath: home, taskManager: manager });
  const host = createLocalToolHost({ workspaceRoot: home, userDataPath: home, sessionStore: { getSession: () => null } });
  const command = 'node -e "setInterval(() => {}, 1000)"';
  provider.permissionReview.addShellRule({ behavior: 'allow', match: { type: 'exact', command }, scope: { cwd: home, maxRiskLevel: 'L4_privileged' } });
  try {
    const execution = await provider.executeCapability({ call: {
      toolCallId: 'source-A', capabilityId: 'local.shell.exec',
      arguments: { command, runInBackground: true },
    } }, { conversationId: 'A' });
    assert.equal(execution.grant.granted, true);
    const taskId = execution.result.outputPreview.backgroundTaskId;
    const [record] = host.listShellTasks();
    assert.equal(record.taskId, taskId);
    assert.equal(record.conversationId, 'A');
    assert.equal(record.status, 'running');
    assert.equal(host.stopShellTask(taskId).stopped, true);
    await disposeApplicationShellTasks(home);
    assert.notEqual(host.listShellTasks()[0].status, 'running');
  } finally {
    await provider.dispose();
    await disposeApplicationShellTasks(home);
    rmSync(home, { recursive: true, force: true });
  }
});
