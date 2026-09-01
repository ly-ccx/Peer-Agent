import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  WORKBENCH_MAXIMIZE_RATIO,
  WORKBENCH_MAXIMIZE_RESTORE_RATIO,
  WORKBENCH_SIDEBAR_COLLAPSE_RATIO,
  WORKBENCH_SIDEBAR_RESTORE_RATIO,
  clampWorkbenchWidth,
  resolveWorkbenchResizeStage,
} from './workbenchResizeStages.ts';

const contextSource = readFileSync(new URL('./WorkbenchContext.tsx', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('./WorkbenchPanel.tsx', import.meta.url), 'utf8');

const viewportWidth = 1000;

function stage(partial: {
  workbenchWidth: number;
  sidebarOpen?: boolean;
  sidebarAutoCollapsed?: boolean;
  maximized?: boolean;
}) {
  return resolveWorkbenchResizeStage({
    viewportWidth,
    workbenchWidth: partial.workbenchWidth,
    sidebarOpen: partial.sidebarOpen ?? true,
    sidebarAutoCollapsed: partial.sidebarAutoCollapsed ?? false,
    maximized: partial.maximized ?? false,
  });
}

describe('workbench progressive resize stages', () => {
  it('collapses the left sidebar at 60% of the window width', () => {
    assert.equal(WORKBENCH_SIDEBAR_COLLAPSE_RATIO, 0.6);
    assert.equal(stage({ workbenchWidth: 599 }).sidebarAutoCollapsed, false);
    assert.equal(stage({ workbenchWidth: 600 }).sidebarAutoCollapsed, true);
  });

  it('does not override a user-collapsed left sidebar', () => {
    const result = stage({ workbenchWidth: 800, sidebarOpen: false });
    assert.equal(result.sidebarAutoCollapsed, false);
    assert.equal(result.maximized, true);
  });

  it('collapses the sidebar at 60% before entering fullscreen at 80%', () => {
    const mid = stage({ workbenchWidth: 700 });
    assert.equal(mid.sidebarAutoCollapsed, true);
    assert.equal(mid.maximized, false);
    const full = stage({ workbenchWidth: 800 });
    assert.equal(full.sidebarAutoCollapsed, true);
    assert.equal(full.maximized, true);
  });

  it('enters fullscreen at 80% of the window width', () => {
    assert.equal(WORKBENCH_MAXIMIZE_RATIO, 0.8);
    assert.equal(stage({ workbenchWidth: 799 }).maximized, false);
    assert.equal(stage({ workbenchWidth: 800 }).maximized, true);
  });

  it('restores sidebar and fullscreen with reverse hysteresis', () => {
    assert.equal(WORKBENCH_SIDEBAR_RESTORE_RATIO, 0.55);
    assert.equal(WORKBENCH_MAXIMIZE_RESTORE_RATIO, 0.75);
    assert.equal(
      stage({ workbenchWidth: 560, sidebarAutoCollapsed: true }).sidebarAutoCollapsed,
      true,
    );
    assert.equal(
      stage({ workbenchWidth: 550, sidebarAutoCollapsed: true }).sidebarAutoCollapsed,
      false,
    );
    assert.equal(stage({ workbenchWidth: 760, maximized: true }).maximized, true);
    assert.equal(stage({ workbenchWidth: 750, maximized: true }).maximized, false);
  });

  it('lets drag exceed the old 0.55 / 900px cap and follow the maximize ratio chain', () => {
    assert.equal(clampWorkbenchWidth(900, 1600, 320), 900);
    assert.equal(clampWorkbenchWidth(1280, 1600, 320), 1280);
    assert.equal(clampWorkbenchWidth(1600, 1600, 320), 1600);
    assert.match(contextSource, /WORKBENCH_SIDEBAR_COLLAPSE_RATIO/);
    assert.match(contextSource, /WORKBENCH_MAXIMIZE_RATIO/);
    assert.match(contextSource, /0\.6/);
    assert.match(contextSource, /0\.8/);
    assert.doesNotMatch(contextSource, /WORKBENCH_MAX_VW_RATIO/);
    assert.match(panelSource, /WORKBENCH_MAXIMIZE_RATIO/);
    assert.doesNotMatch(panelSource, /WORKBENCH_MAX_VW_RATIO/);
    assert.doesNotMatch(panelSource, /0\.55/);
  });
});
