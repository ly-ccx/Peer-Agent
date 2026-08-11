// S2b: full-resolution single-window capture via Electron desktopCapturer.
// Run: ../../apps/desktop/node_modules/.bin/electron s2-capture-electron.mjs
import { app, desktopCapturer, screen } from 'electron';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const outDir = fileURLToPath(new URL('./out/', import.meta.url));

app.whenReady().then(async () => {
  const report = { method: 'desktopCapturer window source, full-res thumbnail' };
  try {
    const disp = screen.getPrimaryDisplay();
    const want = {
      width: Math.round(disp.size.width * disp.scaleFactor),
      height: Math.round(disp.size.height * disp.scaleFactor),
    };
    report.display = { size: disp.size, scaleFactor: disp.scaleFactor, request: want };

    const t0 = process.hrtime.bigint();
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: want,
      fetchWindowIcons: false,
    });
    report.getSourcesMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    report.windowSourceCount = sources.length;

    // Pick the first non-Peer window as "foreign frontmost-ish" target.
    const target = sources.find(s => !/peer agent/i.test(s.name)) ?? sources[0];
    if (!target) throw new Error('no window sources');
    report.target = { id: target.id, name: target.name };

    const t1 = process.hrtime.bigint();
    const png = target.thumbnail.toPNG();
    report.encodeMs = Math.round(Number(process.hrtime.bigint() - t1) / 1e6);
    report.imageSize = target.thumbnail.getSize();
    report.pngBytes = png.length;
    const file = `${outDir}s2b-${target.id.replace(/[^a-z0-9]/gi, '_')}.png`;
    writeFileSync(file, png);
    report.file = file;
    report.totalMs = report.getSourcesMs + report.encodeMs;
  } catch (err) {
    report.error = String(err?.message ?? err);
  }
  console.log(JSON.stringify(report, null, 2));
  writeFileSync(`${outDir}s2b-report.json`, JSON.stringify(report, null, 2));
  app.quit();
});
