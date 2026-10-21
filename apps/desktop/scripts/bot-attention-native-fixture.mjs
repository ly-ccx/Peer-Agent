import { readFileSync, writeFileSync, renameSync } from 'node:fs';

// Disposable acceptance entry only. Native notifications run on the main loop;
// renderer reads and answers still go through the production preload and IPC.
export function installAttentionNativeFixture({ BrowserWindow, commandFile, receiptFile }) {
  let sequence = 0;
  const actions = {
    signal(ids) {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('project-agent:changed', { workspaceIds: ids });
        win.webContents.send('project-agent:conversation-changed', { workspaceIds: ids });
      }
    },
    notify(target) {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('quick-chat:open-conversation', target);
    },
    failRead() { globalThis.rcAttentionFailOnce = true; },
    failInput() { globalThis.rcAttentionFailInput = true; },
  };
  const poll = () => {
    const command = JSON.parse(readFileSync(commandFile, 'utf8'));
    if (command.seq <= sequence) return;
    sequence = command.seq;
    let receipt;
    try {
      if (!Object.hasOwn(actions, command.action)) throw Error('Unknown attention fixture action');
      actions[command.action](command.value);
      receipt = { seq: sequence, ok: true };
    } catch (error) { receipt = { seq: sequence, ok: false, error: error.message }; }
    writeFileSync(receiptFile + '.next', JSON.stringify(receipt));
    renameSync(receiptFile + '.next', receiptFile);
  };
  const timer = setInterval(poll, 25); timer.unref();
  return () => clearInterval(timer);
}

export function createAttentionNativeController({ commandFile, receiptFile, until }) {
  let sequence = 0;
  return async (action, value) => {
    const seq = ++sequence;
    writeFileSync(commandFile + '.next', JSON.stringify({ seq, action, value }));
    renameSync(commandFile + '.next', commandFile);
    const receipt = await until(() => JSON.parse(readFileSync(receiptFile, 'utf8')), result => result.seq === seq, 5000);
    if (!receipt.ok) throw Error(receipt.error);
  };
}
