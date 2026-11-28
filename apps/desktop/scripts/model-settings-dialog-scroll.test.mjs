import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// Run explicitly with Node and Chrome installed, like the other Chromium layout probes.
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite'))('esbuild');
const renderer = new URL('../renderer/src/', import.meta.url);
const css = ['styles/tokens.css', 'styles/overlay.css', 'ui/forms/forms.css', 'styles/llm-settings.css']
  .map(path => readFileSync(new URL(path, renderer), 'utf8')).join('\n');

test('model settings scrolls to its last section with header and footer pinned, before and during save', async () => {
  const { outputFiles } = await build({
    stdin: { resolveDir: fileURLToPath(renderer), loader: 'tsx', contents: `
      import { createRoot } from 'react-dom/client';
      import { createI18n } from '@peer-agent/i18n';
      import { ModelSettingsDialog } from './app/components/ModelSettingsDialog';
      import { UnsavedChangesProvider } from './ui/forms/UnsavedChanges';
      const i18n = createI18n('en-US');
      const root = createRoot(document.getElementById('root'));
      root.render(<UnsavedChangesProvider i18n={i18n}>
        <ModelSettingsDialog i18n={i18n} model={{ model: 'test-model', supportsReasoning: true }}
          onClose={() => root.unmount()} onSave={() => new Promise(() => {})} />
      </UnsavedChangesProvider>);
    ` },
    bundle: true, jsx: 'automatic', loader: { '.css': 'empty' }, write: false,
    plugins: [{ name: 'vite-raw', setup(builder) {
      builder.onResolve({ filter: /\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw' }));
      builder.onLoad({ filter: /.*/, namespace: 'raw' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }));
    } }],
  });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    for (const width of [900, 400]) {
      await page.setViewportSize({ width, height: 480 });
      await page.setContent(`<style>*{box-sizing:border-box}${css}</style><div id="root"></div>`);
      await page.addScriptTag({ content: outputFiles[0].text });
      const dialog = page.getByRole('dialog', { name: 'Model settings' });
      const body = dialog.locator('.llm-model-settings-body');
      const save = dialog.getByRole('button', { name: 'Save model settings' });
      await save.waitFor();
      for (const saving of [false, true]) {
        if (saving) {
          await save.click();
          await dialog.getByRole('button', { name: 'Saving' }).waitFor();
          await page.keyboard.press('Escape');
        }
        assert.equal(await dialog.locator('input').first().isDisabled(), saving);
        const geometry = await body.evaluate(node => {
          const header = node.previousElementSibling;
          const footer = node.nextElementSibling;
          const metadata = node.querySelector('.llm-metadata-source');
          node.scrollTop = 0;
          const headerTop = header.getBoundingClientRect().top;
          const footerBottom = footer.getBoundingClientRect().bottom;
          node.scrollTop = node.scrollHeight;
          return {
            clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop,
            headerPinned: header.getBoundingClientRect().top === headerTop && headerTop >= 0,
            footerPinned: footer.getBoundingClientRect().bottom === footerBottom && footerBottom <= window.innerHeight,
            metadataVisible: metadata.getBoundingClientRect().bottom <= node.getBoundingClientRect().bottom + 1,
          };
        });
        console.log(JSON.stringify({ width, saving, ...geometry }));
        assert.ok(geometry.clientHeight > 0 && geometry.scrollHeight > geometry.clientHeight);
        assert.ok(geometry.scrollTop > 0 && Math.abs(geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop) <= 1);
        assert.ok(geometry.headerPinned && geometry.footerPinned && geometry.metadataVisible);
      }
    }
  } finally {
    await browser.close();
  }
});
