import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appUrl = new URL('../App.tsx', import.meta.url);
const shellCssUrl = new URL('./shell.css', import.meta.url);
const capabilityCssUrl = new URL(
  '../capabilities/capability-workbench.css',
  import.meta.url,
);

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing ${selector}`);
  const bodyStart = css.indexOf('{', start) + 1;
  const end = css.indexOf('}', bodyStart);
  assert.notEqual(end, -1, `unterminated ${selector}`);
  return css.slice(bodyStart, end);
}

test('automation and plugins use the same clipped primary page shell as workbench', async () => {
  const [app, css] = await Promise.all([
    readFile(appUrl, 'utf8'),
    readFile(shellCssUrl, 'utf8'),
  ]);

  assert.match(
    app,
    /activePage === 'automations'[\s\S]*?<section className="primary-page-shell"[\s\S]*?<AutomationCenter/,
  );
  assert.match(
    app,
    /activePage === 'home'[\s\S]*?<section className="primary-page-shell task-overview-page-layer"/,
  );
  // 插件页直接把 CapabilitiesPanel 挂在共享壳下，不再包 tools-page 中间层。
  assert.match(
    app,
    /activePage === 'tools'[\s\S]*?<section className="primary-page-shell"[\s\S]*?<CapabilitiesPanel \/>/,
  );
  assert.doesNotMatch(
    app,
    /activePage === 'tools'[\s\S]*?tools-page settings-content/,
  );

  const shell = ruleBody(css, '.primary-page-shell');
  assert.match(shell, /height:\s*100%/);
  assert.match(shell, /overflow:\s*hidden/);
  assert.match(shell, /background:\s*var\(--za-app-bg\)/);
  assert.match(shell, /border-radius:\s*var\(--radius-lg\)/);

  // 共享壳直接约束 capability-workbench，而不是中间 tools-page。
  assert.match(
    css,
    /\.primary-page-shell > \.automation-center,\s*\.primary-page-shell > \.capability-workbench \{/,
  );
  assert.doesNotMatch(css, /\.primary-page-shell > \.tools-page/);
});

test('plugin workbench paints only through the shared shell background', async () => {
  const css = await readFile(capabilityCssUrl, 'utf8');

  const workbench = ruleBody(css, '.capability-workbench');
  assert.match(workbench, /background:\s*transparent/);
  assert.doesNotMatch(workbench, /background:[^;]*--za-(?:thread|app|sidebar)-bg/);

  const detailPanel = ruleBody(css, '.capability-detail-panel');
  assert.match(detailPanel, /background:\s*transparent/);
  assert.match(detailPanel, /border-left:\s*1px solid var\(--za-line\)/);
  assert.doesNotMatch(css, /background:[^;]*--za-sidebar-bg/);
});
