// A separate Electron process loads this entry, then the real production main.
// No HTTP/CDP listener. Only its spawning parent can send the private IPC protocol.
import { app, session, shell } from 'electron';
import path from 'node:path';
import { mkdirSync, realpathSync } from 'node:fs';
import { DESKTOP_PREVIEW_PROTOCOL as protocol } from '@peer-agent/protocol';
import { capturePreviewScene } from './runtime-gateway/desktop-preview-scene.mjs';
import { createPreviewIdleWatch } from './runtime-gateway/desktop-preview-lifecycle.mjs';

const home = process.env.PEER_PREVIEW_HOME;
const instanceId = process.env.PEER_PREVIEW_INSTANCE;
const buildFingerprint = process.env.PEER_PREVIEW_BUILD;
if (!process.send || !home || !instanceId || !buildFingerprint || app.isPackaged) {
  throw new Error('preview requires a managed development child process');
}
const root = realpathSync(home);
for (const name of ['user-data', 'cache', 'data']) mkdirSync(path.join(root, name), { recursive: true });
process.env.PEER_AGENT_HOME = path.join(root, 'data');
process.env.PEER_DISABLE_LOCAL_SKILL = '1';
process.env.PEER_DISABLE_MCP = '1';
app.setPath('userData', path.join(root, 'user-data'));
app.setPath('sessionData', path.join(root, 'cache'));
app.setPath('home', root);
app.setAppUserModelId('com.peeragent.preview');

// Restrict this child's browser surfaces, not the parent or any existing app.
shell.openExternal = async () => { throw new Error('external navigation disabled in preview'); };
app.on('session-created', guardSession);
function guardSession(s) {
  s.setPermissionRequestHandler((_wc, _permission, respond) => respond(false));
  s.setPermissionCheckHandler(() => false);
  s.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, respond) => respond({ cancel: true }));
}
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => { if (!url.startsWith('file:')) event.preventDefault(); });
});
let target = null;
let ready = false;
let observing = false;
const send = (body) => { if (process.connected) process.send({ protocol, instanceId, ...body }); };
const idle = createPreviewIdleWatch(() => app.exit(0));
app.on('browser-window-created', (_event, window) => {
  // main is the first composition-root window; affordance/quick windows are disabled.
  if (target) return;
  target = window;
  window.webContents.on('did-finish-load', async () => {
    try {
      const url = new URL(window.webContents.getURL());
      if (url.protocol !== 'file:' || !url.pathname.endsWith('/index.html')) throw new Error('unexpected preview document');
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const start = Date.now(); const timer = setInterval(() => {
          if (document.getElementById('root')?.children.length) { clearInterval(timer); resolve(true); }
          else if (Date.now() - start > 15000) { clearInterval(timer); reject(new Error('renderer not ready')); }
        }, 100);
      })`);
      ready = true;
      send({ status: 'ready', buildFingerprint });
    } catch { send({ status: 'failed', error: 'renderer-not-ready' }); }
  });
});
process.on('message', async (message) => {
  if (message?.protocol !== protocol || typeof message.requestId !== 'string') return;
  idle.arm();
  if (message.action === 'close') { idle.disarm(); app.exit(0); return; }
  if (message.action === 'keepalive') { send({ requestId: message.requestId, status: 'ok' }); return; }
  if (message.action !== 'observe' || !ready || !target || target.isDestroyed() || observing) {
    send({ requestId: message.requestId, status: 'failed', error: 'preview-not-ready' }); return;
  }
  observing = true;
  try {
    const { image, scene } = await capturePreviewScene(target.webContents, message.scene);
    const png = image.toPNG();
    const size = image.getSize();
    if (image.isEmpty() || png.length > 8 * 1024 * 1024) throw new Error('invalid image');
    send({ requestId: message.requestId, status: 'observed', buildFingerprint, scene,
      pngBase64: png.toString('base64'), width: size.width, height: size.height });
  } catch (error) { send({ requestId: message.requestId, status: 'failed',
    error: ['preview-scene-invalid', 'preview-scene-not-ready', 'preview-scene-document'].includes(error?.message)
      ? error.message : 'capture-failed' }); }
  finally { observing = false; }
});
process.on('disconnect', () => { idle.disarm(); app.exit(0); });
app.whenReady().then(async () => {
  guardSession(session.defaultSession);
  await import('./main.mjs');
}).catch(() => { send({ status: 'failed', error: 'preview-startup-failed' }); app.exit(1); });
