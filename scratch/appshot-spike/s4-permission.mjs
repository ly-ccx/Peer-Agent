// S4: Screen Recording permission status probe (Electron main process).
// Run: ../../node_modules/.bin/electron s4-permission.mjs
// Prints getMediaAccessStatus('screen') and, if granted, tries a tiny desktopCapturer call.
import { app, systemPreferences, desktopCapturer } from 'electron';
import { writeFileSync } from 'node:fs';

app.whenReady().then(async () => {
  const report = { platform: process.platform, electron: process.versions.electron };
  try {
    report.screenStatus = systemPreferences.getMediaAccessStatus('screen');
    // Also probe camera/microphone for comparison of API behavior.
    report.cameraStatus = systemPreferences.getMediaAccessStatus('camera');

    if (report.screenStatus === 'granted') {
      const t0 = process.hrtime.bigint();
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 320, height: 200 },
        fetchWindowIcons: false,
      });
      report.desktopCapturerMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
      report.windowSourceCount = sources.length;
      report.sampleSources = sources.slice(0, 5).map(s => ({
        id: s.id, name: s.name, thumbEmpty: s.thumbnail.isEmpty(),
        thumbSize: s.thumbnail.getSize(),
      }));
    }
  } catch (err) {
    report.error = String(err?.message ?? err);
  }
  console.log(JSON.stringify(report, null, 2));
  writeFileSync(new URL('./out/s4-report.json', import.meta.url), JSON.stringify(report, null, 2));
  app.quit();
});
