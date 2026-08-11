import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../renderer/src/App.tsx', import.meta.url), 'utf8');
const sidebar = await readFile(new URL('../renderer/src/chat/components/Sidebar.tsx', import.meta.url), 'utf8');
const sidebarCss = await readFile(new URL('../renderer/src/chat/styles/sidebar.css', import.meta.url), 'utf8');

const sidebarStart = app.indexOf('<Sidebar');
const mainPanelStart = app.indexOf('<section className="main-panel">', sidebarStart);
const automationStart = app.indexOf('<AutomationCenter', mainPanelStart);
const settingsStart = app.indexOf("{activePage === 'settings'", automationStart);

assert.ok(sidebarStart >= 0, 'Sidebar must remain mounted in the application shell');
assert.ok(mainPanelStart > sidebarStart, 'main-panel must follow the persistent Sidebar');
assert.ok(automationStart > mainPanelStart, 'AutomationCenter must render inside the right-side main-panel');
assert.ok(settingsStart > automationStart, 'Settings remains the only full-page navigation layer after the shell');
assert.match(app, /activePage !== 'settings' \? ' is-active' : ''/);
assert.doesNotMatch(app, /activePage === 'automations' \? \(\s*<section className="app-page-layer/);
assert.equal((sidebar.match(/onClick=\{onOpenAutomations\}/g) ?? []).length, 1, 'Automation navigation must be unique');
const sidebarTopStart = sidebar.indexOf('<div className="sidebar-top">');
const automationNavStart = sidebar.indexOf('className={`sidebar-automation-nav', sidebarTopStart);
const sidebarTopEnd = sidebar.indexOf('\n      </div>', automationNavStart);
assert.ok(sidebarTopStart >= 0, 'sidebar-top container must exist');
assert.ok(automationNavStart > sidebarTopStart, 'Automation navigation must be a descendant of sidebar-top');
assert.ok(sidebarTopEnd > automationNavStart, 'Automation navigation must close inside sidebar-top');
assert.match(sidebar, /className=\{`sidebar-automation-nav\$\{activePage === 'automations' \? ' active' : ''\}`\}/);
assert.doesNotMatch(sidebarCss, /\.codex-sidebar-actions \.sidebar-automation-nav/);
const automationRule = sidebarCss.match(/\.sidebar-top \.sidebar-automation-nav \{([\s\S]*?)\n  \}/)?.[1] ?? '';
assert.match(automationRule, /display:\s*flex/);
assert.match(automationRule, /align-items:\s*center/);
assert.match(automationRule, /justify-content:\s*flex-start/);
assert.match(automationRule, /width:\s*calc\(100% - 2px\)/);
assert.match(automationRule, /min-height:\s*36px/);
assert.match(automationRule, /white-space:\s*nowrap/);
assert.match(automationRule, /color:\s*var\(--za-text\)/);
assert.match(sidebarCss, /\.sidebar-top \.sidebar-automation-nav > svg \{[\s\S]*?flex:\s*0 0 16px/);
assert.match(sidebarCss, /\.sidebar-top \.sidebar-automation-nav > span \{[\s\S]*?white-space:\s*nowrap/);
assert.match(sidebarCss, /\.sidebar-top \.sidebar-automation-nav:hover \{[\s\S]*?background:/);
assert.match(sidebarCss, /\.sidebar-top \.sidebar-automation-nav\.active \{[\s\S]*?background:/);
assert.match(sidebarCss, /\.sidebar-top \.sidebar-automation-nav:focus-visible \{[\s\S]*?box-shadow:/);

console.log('AUTOMATION_SHELL_LAYOUT_OK');
