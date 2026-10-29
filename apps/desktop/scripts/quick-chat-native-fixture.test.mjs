import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installQuickChatNativeFixture, createQuickChatNativeController } from './quick-chat-native-fixture.mjs';

test('isolated native commands retire menu delivery once and restore the original popup', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'quick-native-fixture-'));
  const commandFile = path.join(root, 'command.json'), receiptFile = path.join(root, 'receipt.json');
  writeFileSync(commandFile, '{"seq":0}'); writeFileSync(receiptFile, '{"seq":0}');
  const delivered = [];
  class Menu { popup() { delivered.push('original'); } }
  const original = Menu.prototype.popup;
  const win = { show() { delivered.push('show'); }, focus() { delivered.push('focus'); },
    webContents: { getURL: () => 'file:///index.html?window=quick-chat', send: event => delivered.push(event) } };
  const stop = installQuickChatNativeFixture({ BrowserWindow: { getAllWindows: () => [win] }, Menu, commandFile, receiptFile });
  const until = async (read, predicate) => {
    for (let i = 0; i < 100; i++) { const value = read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw Error('fixture receipt missing');
  };
  const native = createQuickChatNativeController({ commandFile, receiptFile, until });
  try {
    await native('open');
    assert.deepEqual(delivered, ['show', 'focus', 'quick-chat:shown']);
    await native('installMenu');
    const menu = new Menu(); menu.items = [{ label: 'one', click: () => delivered.push('selected') }];
    menu.popup({ callback: () => delivered.push('closed') });
    assert.equal(await native('menuReady'), true);
    await native('selectMenu', 'one');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(delivered.filter(value => value === 'selected').length, 1, 'polling a consumed command cannot click again');
    assert.equal(await native('menuReady'), false);
    await assert.rejects(native('selectMenu', 'one'), /native choice missing/);
    assert.equal(JSON.parse(readFileSync(receiptFile)).ok, false, 'real errors remain failed receipts');
    await native('restoreMenu');
    assert.equal(Menu.prototype.popup, original);
  } finally { stop(); rmSync(root, { recursive: true, force: true }); }
});
