// S4b: does a RUNNING Electron process observe TCC screen permission changes?
// Polls getMediaAccessStatus('screen') every 2s for up to 180s, logs transitions.
import { app, systemPreferences, desktopCapturer } from 'electron';
import { appendFileSync } from 'node:fs';

const logFile = new URL('./out/s4-poll.log', import.meta.url);
const log = (line) => {
  const msg = `[${new Date().toISOString()}] ${line}`;
  console.log(msg);
  appendFileSync(logFile, msg + '\n');
};

app.whenReady().then(() => {
  let last = null;
  let checks = 0;
  log(`poll start pid=${process.pid} electron=${process.versions.electron}`);
  const timer = setInterval(async () => {
    checks += 1;
    const status = systemPreferences.getMediaAccessStatus('screen');
    if (status !== last) {
      log(`status change: ${last} -> ${status} (check #${checks})`);
      last = status;
      if (status === 'granted') {
        // Verify capture actually works in the SAME running process, no restart.
        try {
          const sources = await desktopCapturer.getSources({
            types: ['window'], thumbnailSize: { width: 320, height: 200 },
          });
          const nonEmpty = sources.filter(s => !s.thumbnail.isEmpty()).length;
          log(`desktopCapturer in same process: sources=${sources.length} nonEmptyThumbs=${nonEmpty}`);
        } catch (err) {
          log(`desktopCapturer FAILED in same process: ${err.message}`);
        }
        log('CONCLUSION: running process observed grant WITHOUT restart');
        clearInterval(timer);
        app.quit();
      }
    }
    if (checks >= 90) {
      log(`timeout after ${checks} checks, last=${last}`);
      clearInterval(timer);
      app.quit();
    }
  }, 2000);
});
