#!/usr/bin/env node
// S1: frontmost window resolution via osascript (System Events).
// Measures per-call latency and prints fields needed by AppshotPayload.source.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';

const pexec = promisify(execFile);

const SCRIPT = `
tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set appName to name of frontApp
  set appPid to unix id of frontApp
  set bid to bundle identifier of frontApp
  try
    set win to front window of frontApp
    set winTitle to name of win
    set winPos to position of win
    set winSize to size of win
    return appName & "|" & appPid & "|" & bid & "|" & winTitle & "|" & (item 1 of winPos) & "," & (item 2 of winPos) & "|" & (item 1 of winSize) & "," & (item 2 of winSize)
  on error errMsg
    return appName & "|" & appPid & "|" & bid & "|<no-window:" & errMsg & ">||"
  end try
end tell`;

async function once() {
  const t0 = process.hrtime.bigint();
  const { stdout } = await pexec('osascript', ['-e', SCRIPT], { timeout: 5000 });
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  const [appName, pid, bundleId, windowTitle, pos, size] = stdout.trim().split('|');
  return { ms: Math.round(ms * 10) / 10, appName, pid: Number(pid), bundleId, windowTitle, pos, size };
}

const runs = [];
for (let i = 0; i < 5; i++) runs.push(await once());
const sorted = [...runs].map(r => r.ms).sort((a, b) => a - b);
const result = {
  method: 'osascript System Events',
  runs,
  medianMs: sorted[Math.floor(sorted.length / 2)],
  note: 'run while another app is frontmost for a meaningful sample',
};
console.log(JSON.stringify(result, null, 2));
writeFileSync(new URL('./out/s1-osascript.json', import.meta.url), JSON.stringify(result, null, 2));
