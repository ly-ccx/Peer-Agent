// E2E: run the REAL appshot-service (production defaults) inside Electron main.
import { app, systemPreferences } from 'electron';
import { createAppshotService } from '../../apps/desktop/electron/main/appshot-service.mjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const outDir = fileURLToPath(new URL('./out/', import.meta.url));

app.whenReady().then(async () => {
  const logs = [];
  const service = createAppshotService({
    getScreenPermissionStatus: () => systemPreferences.getMediaAccessStatus('screen'),
    artifactsDir: outDir + 'e2e-artifacts',
    log: (line) => logs.push(line),
  });
  const t0 = Date.now();
  const result = await service.capture();
  const wallMs = Date.now() - t0;
  const report = { wallMs, logs, result };
  console.log(JSON.stringify(report, null, 2));
  writeFileSync(outDir + 'e2e-report.json', JSON.stringify(report, null, 2));
  app.quit();
});
