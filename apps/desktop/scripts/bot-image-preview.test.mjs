import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron } from 'playwright-core';
import { build } from 'vite';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const workspaceId = 'preview-test';
const entry = '\0peer-bot-image-preview.tsx';
const renderer = `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { createI18n } from '@peer-agent/i18n';
  import { intakeAttachments } from './renderer/src/chat/state/attachmentIntake.ts';
  import { getClipboardFiles } from './renderer/src/chat/state/quickChatAttachments.ts';
  import { normalizeBotMessage } from './renderer/src/project-agent/state/botConversationState.ts';
  import { BotAttachments } from './renderer/src/project-agent/conversation/BotAttachments.tsx';
  const i18n = createI18n('en');
  const root = createRoot(document.getElementById('root'));
  const workspaceId = ${JSON.stringify(workspaceId)};
  window.pasteImages = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 768;
    const ctx = canvas.getContext('2d');
    const pixels = ctx.createImageData(768, 768);
    let seed = 42;
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      pixels.data[i] = seed & 255;
      pixels.data[i + 1] = (seed >>> 8) & 255;
      pixels.data[i + 2] = (seed >>> 16) & 255;
      pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    const clipboard = new DataTransfer();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    clipboard.items.add(new File([blob], 'clipboard.png', { type: 'image/png' }));
    canvas.width = canvas.height = 2;
    const small = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    clipboard.items.add(new File([small], 'inline.png', { type: 'image/png' }));
    const paste = new ClipboardEvent('paste', { clipboardData: clipboard });
    const { attachments, error } = await intakeAttachments(getClipboardFiles(paste.clipboardData.items), 0, false);
    if (error) throw Error(error);
    const result = await window.peerAgent.projectAgentSubmitInput({ workspaceId, inputId: 'paste', surface: 'desktop', text: '', attachments });
    if (!result.ok) throw Error(JSON.stringify(result));
    const { size, blobDigest } = result.input.attachments[0];
    return { size, blobDigest };
  };
  window.loadHistory = async () => {
    const page = await window.peerAgent.projectAgentReadConversation({ workspaceId, view: 'interactions' });
    const attachments = normalizeBotMessage(page.messages[0]).attachments;
    root.render(React.createElement(BotAttachments, { workspaceId, attachments, i18n }));
    return attachments.map(({ blobDigest, dataUrl }) => ({ blobDigest: blobDigest ?? null, inline: Boolean(dataUrl) }));
  };
`;

function writeMain(dir, state) {
  const main = path.join(dir, 'main.mjs');
  const url = file => JSON.stringify(pathToFileURL(path.resolve(desktop, file)).href);
  writeFileSync(main, `
    import { app, BrowserWindow, ipcMain } from 'electron';
    import path from 'node:path';
    import { createConversationStore } from ${url('../../packages/conversation-store/src/index.mjs')};
    import { createInputQueue } from ${url('../../packages/runtime-node/src/project-agent/input-queue.mjs')};
    import { createProjectAgentApplicationService } from ${url('electron/main/project-agent/project-agent-application-service.mjs')};
    import { createProjectAgentIpcRegistrations } from ${url('electron/main/ipc/register-project-agent-ipc.mjs')};
    const state = ${JSON.stringify(state)}, workspaceId = ${JSON.stringify(workspaceId)};
    app.setPath('userData', path.join(state, 'electron'));
    app.whenReady().then(async () => {
    const store = createConversationStore({ storeDir: path.join(state, 'conversations') });
    const inputQueue = createInputQueue({ rootDir: path.join(state, 'project-runtime'), resolveConversationId: () => parentId,
      hasMessage: () => false, appendMessage: (id, row) => store.appendMessage(id, row) });
    // The first process enqueues only. Reopen and consume in the second process.
    const reopening = process.argv.includes('--reopen');
    const { readFileSync, writeFileSync } = await import('node:fs');
    const marker = path.join(state, 'parent');
    const parentId = reopening ? readFileSync(marker, 'utf8') : store.createConversation({ title: 'preview', role: 'project_agent', workspaceId }).id;
    if (reopening) inputQueue.consume(workspaceId); else writeFileSync(marker, parentId);
    globalThis.imageRequests = [];
    const service = createProjectAgentApplicationService({ enabled: () => true, inputQueue, directory: {
      hasActiveBot: id => id === workspaceId,
      readInteractions: async () => ({ ok: true, ...await store.readInteractionPage(parentId) }),
    } });
    const readImage = service.readInputImage;
    const [registration] = createProjectAgentIpcRegistrations({ projectAgent: { ...service, readInputImage(payload) {
      globalThis.imageRequests.push(payload);
      return readImage(payload);
    } } });
    registration.register(ipcMain);
    ipcMain.on('settings:get-sync', event => { event.returnValue = {}; });
    const window = new BrowserWindow({ show: process.platform === 'linux', width: 1024, height: 768, webPreferences: {
      preload: ${JSON.stringify(path.join(desktop, 'electron/preload/preload.cjs'))},
      contextIsolation: true, sandbox: true, backgroundThrottling: false,
    } });
    await window.loadFile(${JSON.stringify(path.join(dir, 'index.html'))});
    }).catch(error => { console.error(error); app.exit(1); });
  `);
  return main;
}

test('clipboard images survive a host restart and history previews load by digest through preload', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-bot-image-preview-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'renderer');
  await build({ root: desktop, logLevel: 'error', plugins: [{ name: 'peer-bot-image-preview-fixture', enforce: 'pre',
    resolveId(id, importer) { if (id === entry) return entry; if (importer === entry && id.startsWith('./')) return path.resolve(desktop, id); },
    load(id) { if (id === entry) return renderer; },
  }], build: { outDir: dir, emptyOutDir: true, target: 'esnext', rollupOptions: { input: entry,
    output: { entryFileNames: 'fixture.js', format: 'iife', inlineDynamicImports: true } } } });
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="fixture.js"></script>');
  const main = writeMain(dir, root);
  const launch = (...args) => _electron.launch({ timeout: 12000, executablePath: process.env.PEER_TEST_ELECTRON ?? require('electron'), args: [main, ...args] });
  const first = await launch();
  let submission;
  try {
    const page = await first.firstWindow();
    await page.waitForFunction(() => typeof window.pasteImages === 'function');
    submission = await page.evaluate(() => window.pasteImages());
    assert.ok(submission.size > 512 * 1024);
    const file = path.join(root, 'project-runtime', workspaceId, 'attachment-blobs', `${submission.blobDigest}.png`);
    const bytes = readFileSync(file);
    assert.equal(bytes.length, submission.size);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), submission.blobDigest);
  } finally { await first.close(); }

  const second = await launch('--reopen');
  try {
    const page = await second.firstWindow();
    await page.waitForFunction(() => typeof window.loadHistory === 'function');
    assert.deepEqual(await page.evaluate(() => window.loadHistory()), [
      { blobDigest: submission.blobDigest, inline: false }, { blobDigest: null, inline: true },
    ]);
    const thumbnail = page.locator('.bot-attachments img[alt="clipboard.png"]');
    const inline = page.locator('.bot-attachments img[alt="inline.png"]');
    await thumbnail.waitFor();
    await inline.waitFor();
    await page.waitForFunction(() => document.querySelector('.bot-attachments img[alt="clipboard.png"]')?.naturalWidth === 768);
    const readRequests = () => second.evaluate(() => globalThis.imageRequests);
    const ref = { workspaceId, blobDigest: submission.blobDigest, mimeType: 'image/png' };
    assert.deepEqual(await readRequests(), [ref]);
    await inline.click();
    await page.locator('.markdown-local-image-lightbox-stage img[alt="inline.png"]').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.markdown-local-image-lightbox-stage').waitFor({ state: 'detached' });
    assert.deepEqual(await readRequests(), [ref]);

    // Fault after thumbnail fetch: the lightbox must request the digest itself and support recovery.
    const file = path.join(root, 'project-runtime', workspaceId, 'attachment-blobs', `${submission.blobDigest}.png`);
    renameSync(file, `${file}.hidden`);
    await thumbnail.click();
    await page.getByText('Image unavailable: reading or decoding failed. The original attachment is preserved.').waitFor();
    assert.deepEqual(await readRequests(), [ref, ref]);
    renameSync(`${file}.hidden`, file);
    await page.getByRole('button', { name: 'Load again' }).click();
    await page.waitForFunction(() => document.querySelector('.markdown-local-image-lightbox-stage img')?.naturalWidth === 768);
    assert.deepEqual(await readRequests(), [ref, ref, ref]);
    await page.keyboard.press('Escape');
    await page.locator('.markdown-local-image-lightbox-stage').waitFor({ state: 'detached' });
    await thumbnail.waitFor();
  } finally { await second.close(); }
});
