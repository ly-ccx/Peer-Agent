import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveMacAppIconPath as resolveMacAppIconPathImpl } from './mac-app-icon.mjs';

/**
 * 已安装编辑器探测 + 「用指定程序打开某个路径」。
 *
 * 该模块只回答两件事：
 * 1) 本机装了哪些候选编辑器（detect）；
 * 2) 用某个候选编辑器打开一个绝对路径（launch）。
 *
 * 它不知道「默认程序是谁」，也不知道调用方是文件预览还是别的界面 —— 默认值归属
 * settings，路径合法性归属 open-path-application-service。
 */

/** macOS 候选编辑器目录：仅按「已知编辑器」探测，不枚举整个 /Applications。 */
export const MAC_EDITOR_CANDIDATES = Object.freeze([
  Object.freeze({ id: 'vscode', name: 'Visual Studio Code', app: 'Visual Studio Code.app' }),
  Object.freeze({ id: 'cursor', name: 'Cursor', app: 'Cursor.app' }),
  Object.freeze({ id: 'zed', name: 'Zed', app: 'Zed.app' }),
  Object.freeze({ id: 'sublime-text', name: 'Sublime Text', app: 'Sublime Text.app' }),
  Object.freeze({ id: 'webstorm', name: 'WebStorm', app: 'WebStorm.app' }),
  Object.freeze({ id: 'intellij-idea', name: 'IntelliJ IDEA', app: 'IntelliJ IDEA.app' }),
  Object.freeze({ id: 'windsurf', name: 'Windsurf', app: 'Windsurf.app' }),
  Object.freeze({ id: 'trae', name: 'Trae', app: 'Trae.app' }),
  Object.freeze({ id: 'nova', name: 'Nova', app: 'Nova.app' }),
  Object.freeze({ id: 'bbedit', name: 'BBEdit', app: 'BBEdit.app' }),
  Object.freeze({ id: 'textmate', name: 'TextMate', app: 'TextMate.app' }),
  Object.freeze({ id: 'xcode', name: 'Xcode', app: 'Xcode.app' }),
  Object.freeze({ id: 'obsidian', name: 'Obsidian', app: 'Obsidian.app' }),
]);

/** Windows 候选编辑器：按可执行文件相对 program-files / localAppData 的位置探测。 */
export const WINDOWS_EDITOR_CANDIDATES = Object.freeze([
  Object.freeze({
    id: 'vscode',
    name: 'Visual Studio Code',
    exeCandidates: Object.freeze([
      'Microsoft VS Code\\Code.exe',
      'Programs\\Microsoft VS Code\\Code.exe',
    ]),
  }),
  Object.freeze({
    id: 'cursor',
    name: 'Cursor',
    exeCandidates: Object.freeze(['Programs\\cursor\\Cursor.exe', 'cursor\\Cursor.exe']),
  }),
  Object.freeze({
    id: 'sublime-text',
    name: 'Sublime Text',
    exeCandidates: Object.freeze(['Sublime Text\\sublime_text.exe']),
  }),
  Object.freeze({
    id: 'notepad-plus-plus',
    name: 'Notepad++',
    exeCandidates: Object.freeze(['Notepad++\\notepad++.exe']),
  }),
]);

function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function normalizeTarget(absPath, platform) {
  if (!absPath || typeof absPath !== 'string') return { ok: false, reason: 'invalid_path' };
  // 按目标平台的路径语义判断，否则 win32 路径在 posix 宿主上会被误判为相对路径。
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const target = pathApi.normalize(absPath);
  if (!pathApi.isAbsolute(target)) return { ok: false, reason: 'not_absolute' };
  return { ok: true, target };
}

/**
 * @param {object} deps
 * @param {string} [deps.platform] process.platform
 * @param {(command: string, args: readonly string[]) => Promise<{ ok: boolean, message?: string }>} deps.spawnDetached
 *   拉起子进程（不等待退出）。由调用方注入，便于测试与保持主进程边界。
 * @param {(candidatePath: string) => boolean} [deps.exists] 存在性判断，默认 fs.existsSync。
 * @param {(appPath: string) => (string | null)} [deps.readBundleId] 读取 macOS bundle id。
 * @param {(appOrExePath: string) => Promise<string | null>} [deps.readAppIcon]
 *   读取本机 App / 可执行文件的真实图标（data URL）。由宿主注入，模块不碰 Electron。
 * @param {Record<string, string | undefined>} [deps.env] 环境变量（Windows 探测用）。
 */
export function createEditorLaunchService({
  platform = process.platform,
  spawnDetached,
  exists = existsSync,
  readBundleId = () => null,
  readAppIcon = async () => null,
  resolveMacAppIconPath = resolveMacAppIconPathImpl,
  env = process.env,
} = {}) {
  const spawn = assertFunction(spawnDetached, 'spawnDetached');
  const fileExists = assertFunction(exists, 'exists');
  const bundleIdOf = assertFunction(readBundleId, 'readBundleId');
  const iconOf = assertFunction(readAppIcon, 'readAppIcon');
  const resolveIconPath = assertFunction(resolveMacAppIconPath, 'resolveMacAppIconPath');

  function detectMac() {
    const bases = ['/Applications'];
    const home = env?.HOME;
    if (home) bases.push(path.join(home, 'Applications'));

    const found = [];
    for (const candidate of MAC_EDITOR_CANDIDATES) {
      for (const base of bases) {
        const appPath = path.join(base, candidate.app);
        if (!fileExists(appPath)) continue;
        found.push(
          Object.freeze({
            id: candidate.id,
            name: candidate.name,
            appPath,
            bundleId: bundleIdOf(appPath) || null,
          }),
        );
        break;
      }
    }
    return found;
  }

  function detectWindows() {
    const bases = [
      env?.LOCALAPPDATA,
      env?.ProgramFiles,
      env?.['ProgramFiles(x86)'],
      env?.ProgramW6432,
    ].filter((value) => typeof value === 'string' && value.length > 0);

    const found = [];
    for (const candidate of WINDOWS_EDITOR_CANDIDATES) {
      let exePath = null;
      for (const base of bases) {
        for (const relative of candidate.exeCandidates) {
          const full = path.win32.join(base, relative);
          if (fileExists(full)) {
            exePath = full;
            break;
          }
        }
        if (exePath) break;
      }
      if (exePath) {
        found.push(
          Object.freeze({ id: candidate.id, name: candidate.name, exePath, bundleId: null }),
        );
      }
    }
    return found;
  }

  return Object.freeze({
    /** 本机已安装的候选编辑器；顺序即候选表顺序（稳定，便于 UI 展示）。 */
    detect() {
      if (platform === 'darwin') return Object.freeze(detectMac());
      if (platform === 'win32') return Object.freeze(detectWindows());
      return Object.freeze([]);
    },

    /**
     * 探测结果加上本机真实 App 图标。
     * 图标读失败时 iconDataUrl 为 null，UI 不得再用字母/符号冒充。
     */
    async detectWithIcons() {
      const editors = this.detect();
      return Object.freeze(
        await Promise.all(
          editors.map(async (editor) => {
            // Prefer the .app CFBundleIconFile icns. getFileIcon(.app) often returns empty.
            const iconPath =
              (editor.appPath && resolveIconPath(editor.appPath)) ||
              editor.appPath ||
              editor.exePath;
            let iconDataUrl = null;
            if (iconPath) {
              try {
                iconDataUrl = (await iconOf(iconPath)) || null;
              } catch {
                iconDataUrl = null;
              }
            }
            return Object.freeze({ ...editor, iconDataUrl });
          }),
        ),
      );
    },

    /** 该 editorId 是否在本机可用。 */
    isAvailable(editorId) {
      if (!editorId || typeof editorId !== 'string') return false;
      return this.detect().some((editor) => editor.id === editorId);
    },

    /**
     * 用指定编辑器打开 absPath（文件或目录同形）。
     * 不做工作区归属校验 —— 那是 open-path-application-service 的职责。
     */
    async launch({ editorId, absPath } = {}) {
      const normalized = normalizeTarget(absPath, platform);
      if (!normalized.ok) return normalized;
      const { target } = normalized;

      if (!editorId || typeof editorId !== 'string') {
        return { ok: false, reason: 'invalid_editor' };
      }

      const editor = this.detect().find((item) => item.id === editorId);
      if (!editor) return { ok: false, reason: 'editor_not_found' };

      try {
        if (platform === 'darwin') {
          // 优先 bundle id：用户把 App 改名/移动后仍能命中。
          const args = editor.bundleId
            ? ['-b', editor.bundleId, target]
            : ['-a', editor.appPath, target];
          const result = await spawn('/usr/bin/open', args);
          if (!result?.ok) {
            return { ok: false, reason: 'launch_failed', message: result?.message || '' };
          }
          return { ok: true, editorId: editor.id };
        }

        if (platform === 'win32') {
          const result = await spawn(editor.exePath, [target]);
          if (!result?.ok) {
            return { ok: false, reason: 'launch_failed', message: result?.message || '' };
          }
          return { ok: true, editorId: editor.id };
        }

        return { ok: false, reason: 'unsupported_platform' };
      } catch (error) {
        return { ok: false, reason: 'error', message: error?.message || String(error) };
      }
    },
  });
}
