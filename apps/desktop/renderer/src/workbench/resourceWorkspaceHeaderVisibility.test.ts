import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const headerSource = readFileSync(new URL('./ResourceWorkspaceHeader.tsx', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('./WorkbenchPanel.tsx', import.meta.url), 'utf8');
const launcherSource = readFileSync(new URL('./ResourceLauncher.tsx', import.meta.url), 'utf8');

describe('resource workspace header (ADR125 2026-11-25 Plan A amendment)', () => {
  it('retires the 3 legacy mode icons (browser/files/changes) from the header controls', () => {
    assert.doesNotMatch(headerSource, /setActiveTab\('browser'\)/);
    assert.doesNotMatch(headerSource, /data-navigator="files"/);
    assert.doesNotMatch(headerSource, /data-navigator="changes"/);
    assert.doesNotMatch(headerSource, /navigation\.toggle/);
  });

  it('keeps only window-level controls (maximize/restore and collapse) beside the tab strip', () => {
    const controls = headerSource.match(/<div className="resource-workspace-controls">[\s\S]*?<\/div>/);
    assert.ok(controls, 'header must render resource-workspace-controls');
    assert.match(controls[0], /setMaximized/);
    assert.match(controls[0], /aria-label=\{isZh \? '收起工作区' : 'Collapse workspace'\}/);
    const buttons = controls[0].match(/<button\b/g) ?? [];
    assert.equal(buttons.length, 2, 'header controls should contain only maximize/restore and collapse');
  });

  it('gives each resource kind a distinct icon in the tab strip', () => {
    assert.match(headerSource, /kind === 'browser'\) return 'globe'/);
    assert.match(headerSource, /kind === 'directory'\) return 'folder'/);
    assert.match(headerSource, /kind === 'interactive'\) return 'blocks'/);
    assert.match(headerSource, /kind === 'comparison'\) return 'history'/);
  });

  it('keeps the launcher tools as the unified entry and opens first-class directory & diff tabs', () => {
    const tools = launcherSource.match(/<div className="resource-launcher-tools">[\s\S]*?<\/div>/);
    assert.ok(tools, 'launcher keeps its in-page tools block');
    assert.match(tools[0], /setActiveTab\('browser'\)/);
    assert.match(tools[0], /文件与目录|Files and folders/);
    assert.match(tools[0], /onChanges/);
    assert.match(panelSource, /openReference\(\{ kind: 'directory', workspaceId: botWorkspaceId, path: '\.' \}\)/);
  });
});
