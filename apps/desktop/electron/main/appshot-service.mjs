import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const pexec = promisify(execFile);

/**
 * Appshot service (P0a): capture the frontmost app window as a local PNG artifact.
 *
 * Contract: peer-knowledge ADR 59 (Appshots capability boundary & evidence chain).
 * - Observe-only. No model-visible tool. Callers are user-gesture paths only
 *   (global hotkey, settings "test capture"), never the chat tool runtime.
 * - permission_denied MUST come from preflight, not from parsing screencapture
 *   stderr (spike S4: denied and not-capturable produce identical CLI errors).
 * - The PNG lands as a local artifact file referenced by `local-appshot-artifact://<id>`;
 *   the full image is never inlined into logs or conversation storage.
 * - Logs must not contain window titles or image bytes (ADR 59 decision 4).
 *
 * All effectful dependencies are injectable for tests; production defaults use
 * Electron systemPreferences + macOS CLI tools per spike S1/S2.
 */

export const APPSHOT_ARTIFACT_SCHEME = 'local-appshot-artifact://';

/** Swift one-shot window enumeration (spike S2). Kept as data for injection/tests. */
const WINDOW_LIST_SWIFT = `
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

async function defaultResolveFrontmost() {
  const { stdout } = await pexec('osascript', ['-e',
    'tell application "System Events" to tell (first application process whose frontmost is true) to return (name & "|" & unix id & "|" & bundle identifier)',
  ], { timeout: 5000 });
  const [appName, pid, bundleId] = stdout.trim().split('|');
  return { appName, pid: Number(pid), bundleId };
}

async function defaultListWindows({ scratchDir }) {
  await mkdir(scratchDir, { recursive: true });
  const src = path.join(scratchDir, 'appshot-winlist.swift');
  const bin = path.join(scratchDir, 'appshot-winlist-bin');

  // T3.1: compile once, then reuse the binary. Warm runs are ~30ms vs ~3.7s
  // for `swift` source interpretation (measured 2026-07-30). First-ever run
  // of a fresh binary pays a one-time Gatekeeper scan (~10s), so we compile
  // eagerly at service init via warmup() where possible.
  let binOk = false;
  try {
    await stat(bin);
    binOk = true;
  } catch {
    try {
      await writeFile(src, WINDOW_LIST_SWIFT, 'utf8');
      await pexec('swiftc', ['-O', src, '-o', bin], { timeout: 120000 });
      binOk = true;
    } catch {
      binOk = false; // fall back to interpreted swift below
    }
  }

  if (binOk) {
    try {
      const { stdout } = await pexec(bin, [], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
      return JSON.parse(stdout);
    } catch {
      // Binary may be quarantined/broken; fall through to interpreted path.
    }
  }

  await writeFile(src, WINDOW_LIST_SWIFT, 'utf8');
  const { stdout } = await pexec('swift', [src], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function defaultCaptureWindow({ windowId, outFile }) {
  await pexec('screencapture', ['-x', '-o', `-l${windowId}`, outFile], { timeout: 15000 });
}

/**
 * @param {object} deps
 * @param {() => string} deps.getScreenPermissionStatus  e.g. () => systemPreferences.getMediaAccessStatus('screen')
 * @param {string} deps.artifactsDir                     base dir for appshot artifacts
 * @param {(line: string) => void} [deps.log]            sanitized logger
 * @param {() => Promise<{appName:string,pid:number,bundleId?:string}>} [deps.resolveFrontmost]
 * @param {(args:{scratchDir:string}) => Promise<Array<object>>} [deps.listWindows]
 * @param {(args:{windowId:number,outFile:string}) => Promise<void>} [deps.captureWindow]
 * @param {(pid:number) => boolean} [deps.isSelfPid]     defaults to comparing with process.pid
 */
export function createAppshotService({
  getScreenPermissionStatus,
  artifactsDir,
  log = () => {},
  resolveFrontmost = defaultResolveFrontmost,
  listWindows = defaultListWindows,
  captureWindow = defaultCaptureWindow,
  isSelfPid = (pid) => pid === process.pid,
}) {
  if (typeof getScreenPermissionStatus !== 'function') throw new Error('getScreenPermissionStatus required');
  if (!artifactsDir) throw new Error('artifactsDir required');

  /**
   * T3.1: pre-compile the window-list binary and run it once so the one-time
   * Gatekeeper scan happens at app startup, not on the user's first hotkey.
   * Silent best-effort: failure just means first capture falls back to the
   * interpreted path.
   */
  async function warmup() {
    try {
      await listWindows({ scratchDir: artifactsDir });
      log('appshot: warmup done');
      return true;
    } catch {
      log('appshot: warmup failed (will fall back lazily)');
      return false;
    }
  }

  /** @returns {Promise<import('@peer-agent/protocol').AppshotResult>} */
  async function capture() {
    const startedAt = Date.now();

    // 1. Permission preflight (ADR 59: the only source of permission_denied).
    const permission = getScreenPermissionStatus();
    if (permission !== 'granted') {
      log(`appshot: preflight permission=${permission}`);
      return { ok: false, code: 'permission_denied', detail: `screen permission is ${permission}` };
    }

    // 2. Resolve frontmost app.
    let front;
    try {
      front = await resolveFrontmost();
    } catch (err) {
      log('appshot: frontmost resolution failed');
      return { ok: false, code: 'no_window', detail: 'cannot resolve frontmost application' };
    }
    if (!front || !Number.isFinite(front.pid)) {
      return { ok: false, code: 'no_window', detail: 'frontmost application unknown' };
    }
    if (isSelfPid(front.pid)) {
      log('appshot: refused, peer is frontmost');
      return { ok: false, code: 'peer_frontmost', detail: 'peer agent window is frontmost' };
    }

    // 3. Locate the frontmost window via window list.
    let windows;
    try {
      windows = await listWindows({ scratchDir: artifactsDir });
    } catch (err) {
      log('appshot: window enumeration failed');
      return { ok: false, code: 'no_window', detail: 'window enumeration failed' };
    }
    const target = (windows ?? []).find((w) => w.pid === front.pid);
    if (!target) {
      log(`appshot: no on-screen window for pid=${front.pid}`);
      return { ok: false, code: 'no_window', detail: 'frontmost app has no on-screen window' };
    }

    // 4. Capture. Permission already verified, so CLI failure here means the
    //    window itself is not capturable (spike S4 error-ambiguity finding).
    const appshotId = randomUUID();
    const dayDir = path.join(artifactsDir, new Date().toISOString().slice(0, 10));
    const outFile = path.join(dayDir, `appshot-${appshotId}.png`);
    try {
      await mkdir(dayDir, { recursive: true });
      await captureWindow({ windowId: target.windowId, outFile });
    } catch (err) {
      log(`appshot: capture failed windowId=${target.windowId}`);
      return { ok: false, code: 'window_not_capturable', detail: 'screencapture could not image this window' };
    }

    let byteSize = 0;
    try {
      byteSize = (await stat(outFile)).size;
    } catch {
      return { ok: false, code: 'window_not_capturable', detail: 'capture produced no file' };
    }
    if (byteSize === 0) {
      return { ok: false, code: 'window_not_capturable', detail: 'capture produced empty file' };
    }

    const durationMs = Date.now() - startedAt;
    // Log line intentionally omits window title and any image data (ADR 59).
    log(`appshot: captured app=${front.appName} bytes=${byteSize} ms=${durationMs}`);

    return {
      ok: true,
      payload: {
        appshotId,
        capturedAt: new Date().toISOString(),
        source: {
          appName: front.appName,
          bundleId: front.bundleId,
          pid: front.pid,
          windowId: target.windowId,
          windowTitle: target.title || undefined,
          bounds: { x: target.x, y: target.y, width: target.width, height: target.height },
        },
        visual: {
          artifactRef: `${APPSHOT_ARTIFACT_SCHEME}${appshotId}`,
          filePath: outFile,
          width: Math.round(target.width),
          height: Math.round(target.height),
          mimeType: 'image/png',
          byteSize,
        },
        text: { mode: 'none' },
        captureDurationMs: durationMs,
      },
    };
  }

  return { capture, warmup };
}
