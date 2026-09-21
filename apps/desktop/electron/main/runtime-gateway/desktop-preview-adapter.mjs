import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { readdirSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { DESKTOP_PREVIEW_PROTOCOL as protocol } from '@peer-agent/protocol';
import { createPreviewKeepAlive, previewSessionIsOpen } from './desktop-preview-lifecycle.mjs';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const entry = fileURLToPath(new URL('../desktop-preview-entry.mjs', import.meta.url));
const ignore = new Set(['node_modules', '.git', 'target', 'dist', 'build', 'release']);
export function fingerprintPreviewSources(workspaceRoot) {
  const hash = createHash('sha256');
  const visit = (relative) => {
    const full = path.join(workspaceRoot, relative);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error('preview-source-symlink');
    if (stat.isDirectory()) {
      for (const name of readdirSync(full).sort()) if (!ignore.has(name) && !name.startsWith('.env')) visit(path.join(relative, name));
    } else { hash.update(relative); hash.update(readFileSync(full)); }
  };
  for (const relative of ['apps/desktop/electron', 'apps/desktop/renderer', 'packages', 'capabilities', 'pnpm-lock.yaml', 'apps/desktop/package.json', 'apps/desktop/vite.config.ts']) visit(relative);
  return hash.digest('hex');
}
export function fingerprintPreviewBuild(workspaceRoot) {
  const hash = createHash('sha256');
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name); const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error('preview-build-symlink');
      if (stat.isDirectory()) visit(full); else { hash.update(path.relative(workspaceRoot, full)); hash.update(readFileSync(full)); }
    }
  };
  visit(path.join(workspaceRoot, 'apps/desktop/dist'));
  for (const name of readdirSync(path.join(workspaceRoot, 'packages')).sort()) {
    const dir = path.join(workspaceRoot, 'packages', name, 'dist');
    try { if (lstatSync(dir).isDirectory()) visit(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return hash.digest('hex');
}

/** Owned child processes only. A preview is isolation from daily data, not an OS sandbox. */
export function createDesktopPreviewAdapter({ workspaceRoot, build = true } = {}) {
  const root = realpathSync(workspaceRoot);
  const sessions = new Map();
  const opening = new Set();
  function childEnv(home, instanceId, buildFingerprint) {
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
      TMPDIR: path.join(home, 'tmp'), XDG_CONFIG_HOME: path.join(home, 'config'),
      XDG_CACHE_HOME: path.join(home, 'cache'), XDG_DATA_HOME: path.join(home, 'data'),
      PEER_PREVIEW_HOME: home, PEER_PREVIEW_INSTANCE: instanceId, PEER_PREVIEW_BUILD: buildFingerprint };
    for (const key of ['SystemRoot', 'WINDIR', 'DISPLAY', 'WAYLAND_DISPLAY', 'LANG']) if (process.env[key]) env[key] = process.env[key];
    return env;
  }
  async function close(conversationId) {
    const s = sessions.get(conversationId);
    if (!s) return { closed: false };
    if (s.child.exitCode === null && s.child.signalCode === null) {
      const exit = new Promise(resolve => s.child.once('exit', resolve));
      s.keepalive?.stop();
      if (s.child.connected) s.child.send({ protocol, action: 'close', requestId: randomUUID() }, () => {});
      const kill = setTimeout(() => s.child.kill('SIGTERM'), 3000);
      const hardKill = setTimeout(() => s.child.kill('SIGKILL'), 6000);
      await exit; clearTimeout(kill); clearTimeout(hardKill);
    }
    sessions.delete(conversationId);
    await rm(s.home, { recursive: true, force: true });
    return { closed: true, instanceId: s.instanceId, pid: s.child.pid };
  }
  async function open(conversationId, signal) {
    const existing = sessions.get(conversationId);
    if (existing && !previewSessionIsOpen(existing)) await close(conversationId);
    if (sessions.has(conversationId) || opening.has(conversationId)) throw new Error('preview-already-open');
    if (root !== realpathSync(path.resolve(path.dirname(entry), '../../../..'))) throw new Error('preview-workspace-mismatch');
    opening.add(conversationId);
    let home;
    try {
      signal?.throwIfAborted();
      const sourceFingerprint = fingerprintPreviewSources(root);
      if (build) await run('pnpm', ['--filter', '@peer-agent/desktop', 'build'], {
        cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, signal, timeout: 180000, maxBuffer: 8 * 1024 * 1024,
      });
      if (sourceFingerprint !== fingerprintPreviewSources(root)) throw new Error('preview-source-changed-during-build');
      const buildFingerprint = fingerprintPreviewBuild(root);
      home = await mkdtemp(path.join(os.tmpdir(), 'peer-product-preview-'));
      await mkdir(path.join(home, 'tmp'));
      const instanceId = randomUUID();
      const electronPackage = path.dirname(require.resolve('electron/package.json'));
      const executable = path.join(electronPackage, 'dist', readFileSync(path.join(electronPackage, 'path.txt'), 'utf8').trim());
      const child = spawn(executable, [entry], { cwd: root, env: childEnv(home, instanceId, buildFingerprint),
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      const s = { child, home, instanceId, buildFingerprint, sourceFingerprint };
      sessions.set(conversationId, s);
      s.keepalive = createPreviewKeepAlive(() => {
        if (!previewSessionIsOpen(s) || !s.child.connected) { s.keepalive?.stop(); return; }
        s.child.send({ protocol, action: 'keepalive', requestId: randomUUID() }, () => {});
      });
      // Drain without storing arbitrary application/credential logs.
      child.stderr.on('data', () => {});
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('preview-readiness-timeout')), 45000);
        const abort = () => finish(new Error('preview-cancelled'));
        const failed = () => finish(new Error('preview-child-exited'));
        const message = (m) => {
          if (m?.protocol !== protocol || m.instanceId !== instanceId) return;
          if (m.status === 'ready' && m.buildFingerprint === buildFingerprint) finish();
          if (m.status === 'failed') finish(new Error(m.error));
        };
        function finish(error) {
          clearTimeout(timer); child.off('message', message); child.off('exit', failed); child.off('error', failed);
          signal?.removeEventListener('abort', abort); error ? reject(error) : resolve();
        }
        child.on('message', message); child.once('exit', failed); child.once('error', failed);
        signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      });
      return { instanceId, buildFingerprint, sourceFingerprint, pid: child.pid };
    } catch (error) {
      if (sessions.has(conversationId)) await close(conversationId);
      else if (home) await rm(home, { recursive: true, force: true });
      throw error;
    } finally { opening.delete(conversationId); }
  }
  async function observe(conversationId, signal, scene = 'application') {
    if (!['application', 'background-runtime'].includes(scene)) throw new Error('preview-scene-invalid');
    const s = sessions.get(conversationId);
    if (!previewSessionIsOpen(s)) throw new Error('preview-not-open');
    if (s.sourceFingerprint !== fingerprintPreviewSources(root) || s.buildFingerprint !== fingerprintPreviewBuild(root)) throw new Error('preview-stale-build');
    signal?.throwIfAborted();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('preview-observe-timeout')), 20000);
      const abort = () => finish(new Error('preview-cancelled'));
      const failed = () => finish(new Error('preview-child-exited'));
      const message = (m) => {
        if (m?.protocol !== protocol || m.instanceId !== s.instanceId || m.requestId !== requestId) return;
        if (m.status !== 'observed' || m.buildFingerprint !== s.buildFingerprint) finish(new Error(m.error || 'preview-invalid-observation'));
        else if (m.scene !== scene) finish(new Error('preview-scene-mismatch'));
        else finish(null, { ...m, sourceFingerprint: s.sourceFingerprint });
      };
      function finish(error, result) {
        clearTimeout(timeout); s.child.off('message', message); s.child.off('exit', failed); signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(result);
      }
      s.child.on('message', message); s.child.once('exit', failed); signal?.addEventListener('abort', abort, { once: true });
      s.child.send({ protocol, action: 'observe', requestId, scene }, error => { if (error) finish(new Error('preview-disconnected')); });
    });
  }
  return { open, observe, close, get: id => sessions.get(id), closeAll: () => Promise.all([...sessions.keys()].map(close)) };
}
