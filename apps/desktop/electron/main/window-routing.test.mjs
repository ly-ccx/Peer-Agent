import assert from 'node:assert/strict';
import test from 'node:test';

import { getMainWindowWebContents } from './window-routing.mjs';

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
