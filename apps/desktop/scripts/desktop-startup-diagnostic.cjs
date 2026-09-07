// Opt-in diagnostic preload. Never use in production or with the daily profile.
const { app, dialog } = require('electron');
const path = require('node:path');
const os = require('node:os');
const home = process.env.PEER_AGENT_HOME;
if (process.env.PEER_STARTUP_DIAGNOSTIC !== '1' || !home ||
    !path.resolve(home).startsWith(path.join(os.tmpdir(), 'peer-startup-diagnostic-'))) {
  throw new Error('Startup diagnostic requires an isolated temporary home');
}
let failed = false;
function fail(kind, error) {
  if (failed) return;
  failed = true;
  process.stderr.write(`[startup-diagnostic:${kind}] ${error?.stack || String(error)}\n`);
  app.exit(1);
}
process.on('uncaughtException', (error) => fail('uncaughtException', error));
process.on('unhandledRejection', (error) => fail('unhandledRejection', error));
dialog.showErrorBox = (title, content) => fail('errorBox', `${title}\n${content}`);
// Capture only routing metadata, never IPC arguments or message content.
const { ipcMain } = require('electron');
const originalEmit = ipcMain.emit;
ipcMain.emit = function (channel, event, ...args) {
  try { return originalEmit.call(this, channel, event, ...args); }
  catch (error) {
    process.stderr.write(`[startup-diagnostic:ipc] ${JSON.stringify({
      channel, frameUrl: event?.senderFrame?.url, senderUrl: event?.sender?.getURL?.(),
    })}\n`);
    throw error;
  }
};
process.stderr.write('[startup-diagnostic] installed\n');
