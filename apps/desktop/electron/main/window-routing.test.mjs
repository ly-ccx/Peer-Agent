import assert from 'node:assert/strict';
import test from 'node:test';

import { getMainWindowWebContents, getOAuthWindowWebContents } from './window-routing.mjs';

function windowStub({ main = false, destroyed = false, name }) {
  return {
    __peerAgentMainWindow: main,
    isDestroyed: () => destroyed,
    webContents: { name },
  };
}

test('routes Goal Runner stream events to the tagged main window when utility windows exist', () => {
  const quickChat = windowStub({ name: 'quick-chat' });
  const popover = windowStub({ name: 'popover' });
  const main = windowStub({ main: true, name: 'main' });

  assert.equal(getMainWindowWebContents([quickChat, popover, main]), main.webContents);
});

test('does not fall back to a utility window when the main window is unavailable', () => {
  const quickChat = windowStub({ name: 'quick-chat' });
  const destroyedMain = windowStub({ main: true, destroyed: true, name: 'main' });

  assert.equal(getMainWindowWebContents([quickChat, destroyedMain]), null);
});

test('routes OAuth events to the renderer that initiated the IPC request', () => {
  const sender = { isDestroyed: () => false, name: 'settings' };
  const main = windowStub({ main: true, name: 'main' });

  assert.equal(getOAuthWindowWebContents(sender, [main]), sender);
});

test('falls back to the tagged main window when the OAuth IPC sender is destroyed', () => {
  const sender = { isDestroyed: () => true, name: 'closed-settings' };
  const quickChat = windowStub({ name: 'quick-chat' });
  const main = windowStub({ main: true, name: 'main' });

  assert.equal(getOAuthWindowWebContents(sender, [quickChat, main]), main.webContents);
});
