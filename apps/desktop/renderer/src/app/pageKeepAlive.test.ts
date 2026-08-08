import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readRendererSource = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('settings overlays the mounted application shell instead of remounting it', async () => {
  const app = await readRendererSource('../App.tsx');
  const shellCss = await readRendererSource('../styles/shell.css');

  assert.match(
    app,
    /className=\{`app-page-layer app-chat-page\$\{activePage !== 'settings' \? ' is-active' : ''\}`\}/,
  );
  assert.match(app, /aria-hidden=\{activePage === 'settings'\}/);
  assert.match(app, /inert=\{activePage === 'settings'\}/);
  assert.match(app, /<Sidebar[\s\S]*?<section className="main-panel">[\s\S]*?activePage === 'automations'[\s\S]*?<AutomationCenter/);
  assert.match(app, /activePage === 'tools'[\s\S]*?<CapabilitiesPanel/);
  assert.match(
    app,
    /onOpenTools=\{\(\) => \{[\s\S]*?setCollectionDrawer\(null\);[\s\S]*?setActivePage\('tools'\);[\s\S]*?\}\}/,
  );
  assert.doesNotMatch(app, /activePage === 'automations' \? \(\s*<section className="app-page-layer/);
  assert.match(app, /\{activePage === 'settings' \? \([\s\S]*?<SettingsPage/);
  assert.doesNotMatch(app, /session && activePage === 'settings' \? \(/);
  assert.match(shellCss, /\.app-chat-page:not\(\.is-active\)[\s\S]*visibility:\s*hidden/);
});

test('hidden chat and workbench layers suspend their global shortcuts', async () => {
  const chatSurface = await readRendererSource('../chat/components/ChatSurface.tsx');
  const workbench = await readRendererSource('../workbench/WorkbenchContext.tsx');

  assert.match(chatSurface, /readonly isPageActive: boolean/);
  assert.ok((chatSurface.match(/if \(!isPageActive/g) ?? []).length >= 3);
  assert.match(workbench, /readonly isPageActive: boolean/);
  assert.ok((workbench.match(/if \(!isPageActive/g) ?? []).length >= 2);
});
