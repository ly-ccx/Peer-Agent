#!/usr/bin/env node
// S2: single-window capture via macOS `screencapture -l<CGWindowID>`.
// Also resolves CGWindowID for the frontmost app, which S1's osascript path cannot give.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pexec = promisify(execFile);
const outDir = fileURLToPath(new URL('./out/', import.meta.url));

// Step 1: frontmost app pid via osascript.
async function frontmostPid() {
  const { stdout } = await pexec('osascript', ['-e',
    'tell application "System Events" to return unix id of (first application process whose frontmost is true)'], { timeout: 5000 });
  return Number(stdout.trim());
}

// Step 2: enumerate windows via CoreGraphics through Swift, filter by pid.
// Uses `swift` if available; falls back to reporting unavailability.
const SWIFT_SRC = `
import CoreGraphics
import Foundation
let opts = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { exit(2) }
var out: [[String: Any]] = []
for w in list {
  guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
  guard let num = w[kCGWindowNumber as String] as? Int else { continue }
  let pid = w[kCGWindowOwnerPID as String] as? Int ?? -1
  let owner = w[kCGWindowOwnerName as String] as? String ?? ""
  let name = w[kCGWindowName as String] as? String ?? ""
  var bx = 0.0, by = 0.0, bw = 0.0, bh = 0.0
  if let b = w[kCGWindowBounds as String] as? [String: Any] {
    bx = (b["X"] as? Double) ?? 0; by = (b["Y"] as? Double) ?? 0
    bw = (b["Width"] as? Double) ?? 0; bh = (b["Height"] as? Double) ?? 0
  }
  out.append(["windowId": num, "pid": pid, "owner": owner, "title": name,
              "x": bx, "y": by, "width": bw, "height": bh])
}
let data = try JSONSerialization.data(withJSONObject: out, options: [])
print(String(data: data, encoding: .utf8)!)
`;

async function listWindows() {
  const src = `${outDir}winlist.swift`;
  writeFileSync(src, SWIFT_SRC);
  const t0 = process.hrtime.bigint();
  const { stdout } = await pexec('swift', [src], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { windows: JSON.parse(stdout), listMs: Math.round(ms) };
}

async function capture(windowId, label) {
  const png = `${outDir}s2-${label}-${windowId}.png`;
  const t0 = process.hrtime.bigint();
  await pexec('screencapture', ['-x', '-o', `-l${windowId}`, png], { timeout: 15000 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const ok = existsSync(png);
  return { png, ok, bytes: ok ? statSync(png).size : 0, captureMs: Math.round(ms * 10) / 10 };
}

const report = { method: 'screencapture -l<CGWindowID> + CGWindowListCopyWindowInfo(swift)' };
try {
  const pid = await frontmostPid();
  report.frontmostPid = pid;
  const { windows, listMs } = await listWindows();
  report.windowListMs = listMs;
  report.windowCount = windows.length;
  const mine = windows.filter(w => w.pid === pid);
  report.frontmostWindows = mine;
  const target = mine[0] ?? windows[0];
  report.target = target;
  if (target) {
    report.capture = await capture(target.windowId, 'frontmost');
    // second run to observe warm latency
    report.captureWarm = await capture(target.windowId, 'frontmost-warm');
  }
} catch (err) {
  report.error = String(err?.message ?? err);
}
console.log(JSON.stringify(report, null, 2));
writeFileSync(`${outDir}s2-report.json`, JSON.stringify(report, null, 2));
