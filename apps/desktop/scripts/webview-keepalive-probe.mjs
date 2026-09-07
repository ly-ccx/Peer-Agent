/**
 * Electron <webview> guest keep-alive probe.
 *
 * Reproduces the conversation-switch remount: moving a webview host with
 * insertBefore destroys WebContents and reloads the page. Leaving the host
 * in place (the Desktop fix) must keep the same webContents id and load count.
 *
 * Exit 0 when stable host order preserves the guest; exit 1 if Electron no
 * longer destroys guests on move (probe would be stale) or if keep-in-place
 * still reloads.
 */
import { app, BrowserWindow } from 'electron';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const GUEST_HTML = `<!doctype html>
<meta charset="utf-8">
<title>keep-alive probe guest</title>
<body>
<p id="boot"></p>
<p id="loads">0</p>
<form><input id="field" value=""></form>
<script>
  // In-memory only. persist: partition sessionStorage survives a remount and
  // must not be used as the remount signal — webContentsId + this boot id are.
  window.__keepaliveBootId = window.__keepaliveBootId || ('boot-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  window.__keepaliveLoads = (window.__keepaliveLoads || 0) + 1;
  document.getElementById('boot').textContent = window.__keepaliveBootId;
  document.getElementById('loads').textContent = String(window.__keepaliveLoads);
  if (!window.__keepaliveSeeded) {
    document.getElementById('field').value = 'typed-in-page';
    window.__keepaliveSeeded = true;
  }
</script>
</body>`;

const HOST_HTML = `<!doctype html>
<meta charset="utf-8">
<title>keep-alive probe host</title>
<style>
  .slot { width: 480px; height: 240px; }
  webview { width: 100%; height: 100%; }
</style>
<div id="root">
  <div id="host-a" class="slot"><webview id="wv-a" partition="persist:keepalive-probe"></webview></div>
  <div id="host-b" class="slot"></div>
</div>
`;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 8_000, intervalMs = 50 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await wait(intervalMs);
  }
  throw new Error('timed out waiting for webview guest');
}

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

const ready = app.whenReady().then(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'peer-webview-keepalive-'));
  const guestPath = path.join(dir, 'guest.html');
  const hostPath = path.join(dir, 'host.html');
  writeFileSync(guestPath, GUEST_HTML);
  writeFileSync(hostPath, HOST_HTML);
  const guestUrl = pathToFileURL(guestPath).toString();

  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      webviewTag: true,
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  await win.loadFile(hostPath);

  const readGuest = async () => win.webContents.executeJavaScript(`
    (() => {
      const wv = document.getElementById('wv-a');
      if (!wv) return { attached: false };
      let webContentsId = null;
      try { webContentsId = wv.getWebContentsId(); } catch {}
      return {
        attached: true,
        src: wv.src || '',
        webContentsId,
      };
    })()
  `);

  await win.webContents.executeJavaScript(`
    const wv = document.getElementById('wv-a');
    window.__keepaliveStartLoads = 0;
    wv.addEventListener('did-start-loading', () => { window.__keepaliveStartLoads += 1; });
    wv.src = ${JSON.stringify(guestUrl)};
  `);

  const first = await waitFor(async () => {
    const snap = await readGuest();
    return snap.webContentsId ? snap : null;
  });

  const readGuestPage = async () => {
    const raw = await win.webContents.executeJavaScript(`
      document.getElementById('wv-a').executeJavaScript(\`JSON.stringify({
        boot: document.getElementById('boot').textContent,
        loads: document.getElementById('loads').textContent,
        field: document.getElementById('field').value
      })\`)
    `);
    return JSON.parse(raw);
  };

  const firstPage = await waitFor(async () => {
    try {
      const page = await readGuestPage();
      return Number(page.loads) >= 1 ? page : null;
    } catch {
      return null;
    }
  });
  const startLoadsAfterFirst = await win.webContents.executeJavaScript('window.__keepaliveStartLoads');

  await wait(400);
  const afterStable = await readGuest();
  const stablePage = await readGuestPage();
  const startLoadsAfterStable = await win.webContents.executeJavaScript('window.__keepaliveStartLoads');

  await win.webContents.executeJavaScript(`
    const root = document.getElementById('root');
    const a = document.getElementById('host-a');
    const b = document.getElementById('host-b');
    root.insertBefore(a, null);
    root.insertBefore(b, a);
  `);

  await wait(800);
  const afterMove = await waitFor(async () => {
    const snap = await readGuest();
    return snap.webContentsId ? snap : null;
  }).catch(() => ({ webContentsId: null }));

  let movePage = { boot: null, loads: null, field: null };
  try {
    movePage = await readGuestPage();
  } catch {
    movePage = { boot: null, loads: null, field: null };
  }
  const startLoadsAfterMove = await win.webContents.executeJavaScript('window.__keepaliveStartLoads');

  const report = {
    firstWebContentsId: first.webContentsId,
    firstBootId: firstPage.boot,
    loadsAfterFirst: Number(firstPage.loads),
    fieldAfterFirst: firstPage.field,
    startLoadsAfterFirst,
    afterStableWebContentsId: afterStable.webContentsId,
    afterStableBootId: stablePage.boot,
    loadsAfterStable: Number(stablePage.loads),
    fieldAfterStable: stablePage.field,
    startLoadsAfterStable,
    afterMoveWebContentsId: afterMove.webContentsId,
    afterMoveBootId: movePage.boot,
    loadsAfterMove: movePage.loads == null ? null : Number(movePage.loads),
    fieldAfterMove: movePage.field,
    startLoadsAfterMove,
    guestPreservedWhenHostStays:
      afterStable.webContentsId === first.webContentsId
      && stablePage.boot === firstPage.boot
      && Number(stablePage.loads) === Number(firstPage.loads)
      && startLoadsAfterStable === startLoadsAfterFirst
      && stablePage.field === 'typed-in-page',
    guestDestroyedWhenHostMoved:
      afterMove.webContentsId !== first.webContentsId
      || movePage.boot !== firstPage.boot
      || startLoadsAfterMove > startLoadsAfterStable,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  const ok = report.guestPreservedWhenHostStays && report.guestDestroyedWhenHostMoved;
  win.destroy();
  app.exit(ok ? 0 : 1);
});

ready.catch((error) => {
  console.error(error);
  app.exit(1);
});
