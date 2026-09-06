/**
 * Drive a Linux unpacked Desktop build over CDP and observe Browser webviews.
 *
 * Seeds two conversations, launches peer-agent, connects playwright-core, then:
 *   1. open A (report whether the renderer stays up)
 *   2. if Workbench/Browser can be reached, read guest webContentsId + in-memory boot
 *   3. switch A → B → A and report whether the guest remounted
 *
 *   PEER_AGENT_PACKAGED_BIN=... PEER_AGENT_HOME=... node scripts/packaged-keepalive-cdp.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const binary = process.env.PEER_AGENT_PACKAGED_BIN
  || path.resolve(process.cwd(), '../../dist-electron/linux-unpacked/peer-agent');
const port = Number(process.env.PEER_AGENT_DEBUG_PORT || 9334);
const pagePort = Number(process.env.PEER_AGENT_PAGE_PORT || 8765);
const home = process.env.PEER_AGENT_HOME
  || mkdtempSync(path.join(tmpdir(), 'peer-agent-keepalive-cdp-'));

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJson(url, timeoutMs = 25_000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(200);
  }
  throw new Error(`timed out waiting for ${url}: ${lastError?.message || lastError}`);
}

const guestDir = mkdtempSync(path.join(tmpdir(), 'peer-keepalive-page-'));
writeFileSync(path.join(guestDir, 'index.html'), `<!doctype html>
<meta charset="utf-8">
<title>keepalive-probe</title>
<style>body{font:20px/1.4 sans-serif;padding:24px}input{font:inherit;width:80%;padding:8px}</style>
<h1 id="boot"></h1>
<p>In-memory load marker. A full webview reload creates a new boot id and clears the field.</p>
<p><input id="field" placeholder="type here"></p>
<script>
  window.__keepaliveBootId = 'boot-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  document.getElementById('boot').textContent = window.__keepaliveBootId;
  document.title = window.__keepaliveBootId;
</script>
`);

const httpServer = createServer((request, response) => {
  if (request.url === '/' || request.url === '/index.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(awaitImport());
    return;
  }
  response.writeHead(404);
  response.end();
});

function awaitImport() {
  return require('node:fs').readFileSync(path.join(guestDir, 'index.html'));
}

await new Promise((resolve) => httpServer.listen(pagePort, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${pagePort}/`;

const { createConversationStore } = await import(
  pathToFileURL(path.resolve(process.cwd(), '../../packages/conversation-store/src/index.mjs')).href
);
mkdirSync(home, { recursive: true });
writeFileSync(path.join(home, 'settings.json'), `${JSON.stringify({
  locale: 'en',
  workbench: {
    open: false,
    openByConversation: {},
    width: 640,
    activeTab: {},
    browserSessions: {},
    documentSessions: {},
    sidebarOpen: true,
    sidebarWidth: 264,
  },
}, null, 2)}\n`);
const store = createConversationStore({ storeDir: path.join(home, 'conversations') });
const convA = store.createConversation({ title: 'KeepAlive A' });
const convB = store.createConversation({ title: 'KeepAlive B' });
const now = Date.now();
store.appendMessage(convA.id, { id: 'seed-a', role: 'user', content: 'seed conversation A', timestamp: now });
store.appendMessage(convB.id, { id: 'seed-b', role: 'user', content: 'seed conversation B', timestamp: now + 1 });

const child = spawn(binary, [
  `--remote-debugging-port=${port}`,
  '--no-sandbox',
  '--disable-gpu',
  '--in-process-gpu',
], {
  env: {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ':1',
    ELECTRON_DISABLE_SANDBOX: '1',
    PEER_AGENT_HOME: home,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });

const report = {
  binary,
  home,
  pageUrl,
  a: convA.id,
  b: convB.id,
  rendererCrashedOnOpenA: null,
  rendererError: null,
  openedA: false,
  openedB: false,
  firstWebContentsId: null,
  firstBootId: null,
  afterSwitchWebContentsId: null,
  afterSwitchBootId: null,
  guestPreservedAcrossSwitch: null,
};

function cleanup(code) {
  try { child.kill('SIGTERM'); } catch {}
  try { httpServer.close(); } catch {}
  process.exit(code);
}

try {
  await waitForJson(`http://127.0.0.1:${port}/json/version`);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const pickMainPage = () => (context.pages().find((candidate) => {
    const url = candidate.url();
    return url.includes('index.html') && !url.includes('window=');
  }) || context.pages().find((candidate) => candidate.url().includes('index.html')) || context.pages()[0]);
  let page = pickMainPage();
  if (!page) page = await context.waitForEvent('page', { timeout: 15_000 });
  const startedPick = Date.now();
  while (Date.now() - startedPick < 12_000 && (!page || page.url().includes('window='))) {
    await wait(250);
    page = pickMainPage() || page;
  }
  await page.bringToFront().catch(() => {});
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('body', { timeout: 10_000 }).catch(() => {});
  await wait(2_500);
  report.pageUrlOpened = page.url();
  report.pageUrls = context.pages().map((candidate) => candidate.url());

  const expandUnassigned = async () => {
    const expand = page.getByRole('button', { name: /Expand unassigned|展开未归属/i });
    if (await expand.count()) {
      await expand.first().click({ timeout: 5_000 }).catch(() => {});
      await wait(400);
      return;
    }
    const header = page.getByText('Unassigned', { exact: true });
    if (await header.count()) {
      await header.first().click({ timeout: 5_000 }).catch(() => {});
      await wait(400);
    }
  };

  const clickConversation = async (title) => {
    await expandUnassigned();
    const locators = [
      page.getByRole('button', { name: title }),
      page.locator('.sidebar-conv-title', { hasText: title }),
      page.getByText(title, { exact: true }),
    ];
    for (const locator of locators) {
      if (await locator.count()) {
        await locator.first().click({ timeout: 5_000, force: true });
        return true;
      }
    }
    return false;
  };

  const snapshotError = async () => {
    const text = await page.locator('body').innerText();
    if (text.includes('界面渲染失败') || text.includes('UI render failed') || text.includes('Rendered more hooks')) {
      return text.slice(0, 1_500);
    }
    return null;
  };

  report.openedA = await clickConversation('KeepAlive A');
  await wait(1_200);
  report.rendererError = await snapshotError();
  report.rendererCrashedOnOpenA = Boolean(report.rendererError);

  if (!report.rendererCrashedOnOpenA) {
    const workbenchToggle = page.locator('button[aria-label*="Workbench"], button[aria-label*="工作台"], button[title*="Workbench"], button[title*="工作台"]');
    if (await workbenchToggle.count()) {
      await workbenchToggle.first().click().catch(() => {});
      await wait(400);
    }
    const browserTab = page.locator('button[role="tab"][aria-label="Browser"], button[role="tab"][aria-label="浏览器"]');
    if (await browserTab.count()) {
      await browserTab.first().click().catch(() => {});
      await wait(400);
    }

    const address = page.locator('input[aria-label*="Address"], input[placeholder*="http"], .browser-address input, input.browser-address-input');
    if (await address.count()) {
      await address.first().fill(pageUrl);
      await address.first().press('Enter');
      await wait(1_200);
    }

    const readGuest = async () => page.evaluate(async () => {
      const wv = document.querySelector('webview.browser-webview, webview');
      if (!wv) return { attached: false };
      let webContentsId = null;
      try { webContentsId = wv.getWebContentsId(); } catch {}
      let boot = null;
      let field = null;
      try {
        const raw = await wv.executeJavaScript(`JSON.stringify({
          boot: document.getElementById('boot') && document.getElementById('boot').textContent,
          field: document.getElementById('field') && document.getElementById('field').value
        })`);
        const pageState = JSON.parse(raw);
        boot = pageState.boot;
        field = pageState.field;
      } catch {}
      return { attached: true, webContentsId, boot, field, src: wv.src || '' };
    });

    const first = await readGuest();
    report.firstWebContentsId = first.webContentsId ?? null;
    report.firstBootId = first.boot ?? null;
    if (first.attached && first.webContentsId) {
      await page.evaluate(() => {
        const wv = document.querySelector('webview.browser-webview, webview');
        if (!wv) return;
        return wv.executeJavaScript(`document.getElementById('field').value = 'typed-in-page'`);
      }).catch(() => {});
    }

    report.openedB = await clickConversation('KeepAlive B');
    await wait(800);
    await clickConversation('KeepAlive A');
    await wait(1_200);
    const after = await readGuest();
    report.afterSwitchWebContentsId = after.webContentsId ?? null;
    report.afterSwitchBootId = after.boot ?? null;
    report.guestPreservedAcrossSwitch = Boolean(
      report.firstWebContentsId
      && report.afterSwitchWebContentsId === report.firstWebContentsId
      && report.afterSwitchBootId
      && report.afterSwitchBootId === report.firstBootId,
    );
    report.rendererError = report.rendererError || await snapshotError();
  }

  report.pageTitle = await page.title();
  report.bodyPreview = (await page.locator('body').innerText()).slice(0, 1_200);
  report.bodyHtmlPreview = (await page.locator('body').innerHTML()).slice(0, 1_200);
  const shot = path.join(home, 'cdp-main.png');
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  report.screenshot = shot;
  await browser.close();
} catch (error) {
  report.error = String(error?.stack || error);
  report.stdoutTail = stdout.slice(-2_000);
  report.stderrTail = stderr.slice(-2_000);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  cleanup(1);
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
const ok = report.openedA && report.rendererCrashedOnOpenA === false;
cleanup(ok ? 0 : 2);
