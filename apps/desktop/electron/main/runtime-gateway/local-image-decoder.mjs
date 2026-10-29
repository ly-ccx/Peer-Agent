import { randomUUID } from 'node:crypto';

/** Private byte-only decoder Adapter; no file, model script or network authority. */
export async function decodeDesktopImage(bytes, mediaType, { signal } = {}) {
  const { nativeImage, BrowserWindow } = await import('electron');
  if (mediaType === 'image/png' || mediaType === 'image/jpeg') {
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new Error('Invalid image');
    const { width, height } = image.getSize();
    return { width, height };
  }
  // nativeImage only decodes PNG/JPEG. Chromium validates the first GIF/WebP frame.
  const window = new BrowserWindow({ show: false, width: 1, height: 1, skipTaskbar: true,
    webPreferences: { partition: `image-decoder-${randomUUID()}`, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  window.webContents.session.webRequest.onBeforeRequest((_request, callback) => callback({ cancel: true }));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const destroy = () => { if (!window.isDestroyed()) window.destroy(); };
  let timer;
  let onAbort;
  try {
    const interrupted = new Promise((_resolve, reject) => {
      timer = setTimeout(() => { destroy(); reject(new Error('Image decode timed out')); }, 10_000);
      onAbort = () => { destroy(); reject(new Error('Image decode cancelled')); };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    const decoding = (async () => {
      await window.loadURL('about:blank');
      return window.webContents.executeJavaScript(`(async () => {
        const binary = atob(${JSON.stringify(bytes.toString('base64'))});
        const data = Uint8Array.from(binary, c => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([data], { type: ${JSON.stringify(mediaType)} }));
        try { return { width: bitmap.width, height: bitmap.height }; } finally { bitmap.close(); }
      })()`);
    })();
    return await Promise.race([decoding, interrupted]);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort); destroy();
  }
}
