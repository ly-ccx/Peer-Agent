// T3.1 probe: two captures in the SAME Electron process — does warmup absorb the EDR/Gatekeeper cost?
import { app, systemPreferences } from 'electron';
import { createAppshotService } from '../../apps/desktop/electron/main/appshot-service.mjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const outDir = fileURLToPath(new URL('./out/', import.meta.url));
app.whenReady().then(async () => {
  const service = createAppshotService({
    getScreenPermissionStatus: () => systemPreferences.getMediaAccessStatus('screen'),
    artifactsDir: outDir + 'e2e-artifacts',
  });
  const t0 = Date.now();
  await service.warmup();
  const warmupMs = Date.now() - t0;
  const t1 = Date.now();
  const r1 = await service.capture();
  const cap1Ms = Date.now() - t1;
  const t2 = Date.now();
  const r2 = await service.capture();
  const cap2Ms = Date.now() - t2;
  const report = { warmupMs, cap1Ms, cap1Ok: r1.ok, cap2Ms, cap2Ok: r2.ok };
  console.log(JSON.stringify(report, null, 2));
  writeFileSync(outDir + 'e2e-twice-report.json', JSON.stringify(report, null, 2));
  app.quit();
});
