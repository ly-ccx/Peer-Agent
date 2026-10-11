// Rasterize the SVG master at native 1x/2x sizes, without resizing a bitmap.
// Build tool only: Electron's SVG renderer matches the desktop runtime.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  execFileSync(electron, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit' });
} else {
  const { app, BrowserWindow } = electron;
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
    try {
      await window.loadURL('data:text/html,<html><body></body></html>');
      const svg = readFileSync(new URL('../build/trayTemplate.svg', import.meta.url), 'utf8');
      for (const scale of [1, 2]) {
        const dataUrl = await window.webContents.executeJavaScript(`(async () => {
          const image = new Image();
          image.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = ${16 * scale};
          canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL('image/png');
        })()`);
        writeFileSync(new URL(`../build/trayTemplate${scale === 2 ? '@2x' : ''}.png`, import.meta.url), Buffer.from(dataUrl.split(',')[1], 'base64'));
      }
    } finally {
      window.destroy();
      app.quit();
    }
  }).catch(error => {
    console.error(error);
    app.exit(1);
  });
}
