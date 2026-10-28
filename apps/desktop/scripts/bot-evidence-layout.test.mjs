import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { _electron } from 'playwright-core';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const { build } = createRequire(require.resolve('vite'))('esbuild');

test('evidence cards own their layout in task and reply containers', async () => {
  const output = mkdtempSync(path.join(os.tmpdir(), 'peer-evidence-layout-'));
  // Render the real component without reply-context ancestors or their styles.
  const fixture = path.join(output, 'render.cjs');
  await build({ stdin: { contents: `
    import { renderToStaticMarkup } from 'react-dom/server';
    import { createI18n } from '@peer-agent/i18n';
    import { EvidenceList } from './project-agent/conversation/EvidenceList';
    export const html = renderToStaticMarkup(<EvidenceList refs={Array.from({length:20},(_,i)=>'record-'+i)} i18n={createI18n('zh-CN')} />);
  `, resolveDir: path.join(desktop, 'renderer/src'), loader: 'tsx' },
    bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', loader: { '.css': 'empty' }, outfile: fixture,
    define: { 'window.peerAgent': 'undefined' },
    plugins: [{ name: 'vite-raw', setup(builder) {
      builder.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw' }));
      builder.onLoad({ filter: /.*/, namespace: 'raw' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }));
    } }] });
  const { html } = require(fixture);
  const assets = path.join(desktop, 'dist/assets');
  const css = readdirSync(assets).filter(name => name.endsWith('.css')).map(name => readFileSync(path.join(assets, name), 'utf8')).join('\n');
  const file = path.join(output, 'fixture.html');
  writeFileSync(file, `<html data-theme="light"><meta charset="utf-8"><style>${css}</style>
    <body><main style="width:360px;padding:20px;background:var(--paper-sheet)">
    <div class="bot-drawer-detail bot-task-detail">${html}</div></main></body></html>`);
  const main = path.join(output, 'main.cjs');
  writeFileSync(main, `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(path.join(output, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({width:760,height:820,show:false}).loadFile(${JSON.stringify(file)}));`);
  const app = await _electron.launch({ executablePath: require('electron'), args: [main] });
  try {
    const page = await app.firstWindow();
    await page.locator('.bot-evidence-list button').first().waitFor();
    for (const container of ['bot-drawer-detail bot-task-detail', 'bot-reply-context-body']) {
      await page.locator('main > div').evaluate((node, value) => { node.className = value; }, container);
      for (const width of [360, 280]) for (const theme of ['dark', 'light']) {
        await page.locator('main').evaluate((node, value) => { node.style.width = `${value}px`; }, width);
        await page.locator('html').evaluate((node, value) => { node.dataset.theme = value; }, theme);
        const geometry = await page.locator('.bot-evidence-list').evaluate(node => {
          const rows = [...node.querySelectorAll('button')];
          const [first, second] = rows.map(row => row.getBoundingClientRect());
          const [icon, copy, arrow] = [...rows[0].children].map(child => child.getBoundingClientRect());
          return { height: first.height, gap: second.top - first.bottom,
            horizontal: icon.right <= copy.left && copy.right <= arrow.left,
            centered: Math.abs(icon.top + icon.height / 2 - arrow.top - arrow.height / 2) < 1,
            fits: node.scrollWidth <= node.clientWidth + 1, scrollable: node.scrollHeight > node.clientHeight };
        });
        assert.ok(geometry.height >= 48 && geometry.height <= 56, JSON.stringify({ container, width, theme, geometry }));
        assert.ok(geometry.gap >= 8 && geometry.horizontal && geometry.centered && geometry.fits && geometry.scrollable);
        const button = page.locator('.bot-evidence-list button').first();
        await button.focus();
        assert.equal(await button.evaluate(node => getComputedStyle(node).outlineStyle), 'solid');
        await page.locator('main').screenshot({ path: path.join(output, `${container.split(' ')[0]}-${width}-${theme}.png`) });
      }
    }
    console.log(`Evidence component screenshots: ${output}`);
  } finally { await app.close(); }
});
