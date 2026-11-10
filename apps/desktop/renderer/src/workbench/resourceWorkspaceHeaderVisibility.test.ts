import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const headerSource = readFileSync(new URL('./ResourceWorkspaceHeader.tsx', import.meta.url), 'utf8');

describe('resource workspace header navigation visibility (ADR125 决策五)', () => {
  it('hides the header navigation entries only on a bare launcher tab', () => {
    // 隐藏条件必须同时要求 launcher 激活与没有任何辅助面板打开；面板一开入口即恢复。
    assert.match(headerSource, /const bareLauncher = workbench\.activeTab === 'launcher' && !navigation\.mode;/);
  });

  it('keeps browser, files and changes entries inside the conditional with their toggle contracts', () => {
    const conditional = headerSource.match(/\{!bareLauncher \? <>[\s\S]*?<\/> : null\}/);
    assert.ok(conditional, 'the three navigation entries must be wrapped in the bare-launcher conditional');
    const block = conditional[0];
    assert.match(block, /setActiveTab\('browser'\)/);
    assert.match(block, /data-navigator="files"/);
    assert.match(block, /navigation\.toggle\('files'\)/);
    assert.match(block, /aria-pressed=\{navigation\.mode === 'files' \|\| workbench\.activeTab === 'files'\}/);
    assert.match(block, /data-navigator="changes"/);
    assert.match(block, /navigation\.toggle\('changes'\)/);
    assert.match(block, /aria-pressed=\{navigation\.mode === 'changes' \|\| workbench\.activeTab === 'changes'\}/);
  });

  it('keeps maximize and collapse outside the conditional', () => {
    const tail = headerSource.match(/<\/> : null\}([\s\S]*)$/);
    assert.ok(tail, 'the conditional must close before the remaining header controls');
    assert.match(tail[1], /setMaximized/);
    assert.match(tail[1], /aria-label=\{isZh \? '收起工作区' : 'Collapse workspace'\}/);
    assert.doesNotMatch(tail[1], /data-navigator/);
  });

  it('leaves the launcher in-page tool entries untouched as the sole launcher surface', () => {
    // 页内入口在 ResourceLauncher；头部条件只影响 resource-workspace-controls。
    const launcherSource = readFileSync(new URL('./ResourceLauncher.tsx', import.meta.url), 'utf8');
    const tools = launcherSource.match(/<div className="resource-launcher-tools">[\s\S]*?<\/div>/);
    assert.ok(tools, 'launcher keeps its in-page tools block');
    assert.match(tools[0], /setActiveTab\('browser'\)/);
    assert.match(tools[0], /文件与目录|Files and folders/);
    assert.match(tools[0], /onChanges/);
  });
});
