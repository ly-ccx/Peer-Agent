import { readFileSync, writeFileSync, renameSync } from 'node:fs';

/** Isolated acceptance entry only. Commands run once on Electron's native loop,
 * outside the inspector's Promise lifetime; the renderer still uses real IPC. */
export function installQuickChatNativeFixture({ BrowserWindow, Menu, commandFile, receiptFile }) {
  let sequence = 0, menu, options, originalPopup;
  const window = () => {
    const win = BrowserWindow.getAllWindows().find(win => new URL(win.webContents.getURL()).searchParams.get('window') === 'quick-chat');
    if (!win) throw Error('Quick Chat window missing');
    return win;
  };
  const actions = {
    open() { const win = window(); win.show(); win.focus(); win.webContents.send('quick-chat:shown'); },
    focus() { const win = window(); win.show(); win.focus(); },
    installMenu() {
      if (originalPopup) throw Error('Quick Chat menu fixture already installed');
      originalPopup = Menu.prototype.popup;
      Menu.prototype.popup = function (value) { menu = this; options = value; };
    },
    clearMenu() { menu = undefined; options = undefined; },
    menuReady() { return Boolean(menu); },
    selectMenu(label) {
      const item = menu?.items.find(item => item.label === label);
      if (!item) throw Error('Quick Chat native choice missing: ' + label);
      // Retire before delivery. A failed callback cannot be replayed by polling.
      const callback = options.callback;
      menu = undefined; options = undefined;
      item.click(); callback();
    },
    execution() { return globalThis.rcQuickExecution; },
    restoreMenu() {
      if (originalPopup) Menu.prototype.popup = originalPopup;
      originalPopup = undefined; menu = undefined; options = undefined;
    },
  };
  const poll = () => {
    const command = JSON.parse(readFileSync(commandFile, 'utf8'));
    if (command.seq <= sequence) return;
    sequence = command.seq;
    let receipt;
    try {
      if (!Object.hasOwn(actions, command.action)) throw Error('Unknown Quick Chat fixture action');
      receipt = { seq: sequence, ok: true, value: actions[command.action](command.value) };
    } catch (error) { receipt = { seq: sequence, ok: false, error: error.message }; }
    writeFileSync(receiptFile + '.next', JSON.stringify(receipt));
    renameSync(receiptFile + '.next', receiptFile);
  };
  const timer = setInterval(poll, 25); timer.unref();
  return () => { clearInterval(timer); actions.restoreMenu(); };
}

export function createQuickChatNativeController({ commandFile, receiptFile, until }) {
  let sequence = 0;
  return async (action, value) => {
    const seq = ++sequence;
    writeFileSync(commandFile + '.next', JSON.stringify({ seq, action, value }));
    renameSync(commandFile + '.next', commandFile);
    const receipt = await until(() => JSON.parse(readFileSync(receiptFile, 'utf8')), result => result.seq === seq, 5000);
    if (!receipt.ok) throw Error(receipt.error);
    return receipt.value;
  };
}
