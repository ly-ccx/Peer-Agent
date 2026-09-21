// 实验源码/产物隔离：实验改动和重建只发生在独立工作目录。
//
// 为什么：实验室会话此前绑日常仓库，Electron 也从日常 apps/desktop 启动。
// 模型改源码或重建会改写用户正在用的代码和共用 dist。
//
// 本模块只负责目录与会话绑定。启动仍走 lab-experiment.mjs，
// 但启动根必须是隔离后的 desktopDir，而不是日常 apps/desktop。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const ISOLATED_WORKSPACE = 'isolated-workspace';
export const ISOLATED_DIST = 'isolated-dist';

const SKIP_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-electron',
  '.vite',
  'coverage',
  'target',
  '.peer-tmp',
  '.qoder',
]);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function copyTree(source, destination, { skipNames = SKIP_DIR_NAMES } = {}) {
  ensureDir(destination);
  const entries = fs.readdirSync(source, { withFileTypes: true });
  for (const entry of entries) {
    if (skipNames.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to, { skipNames });
      continue;
    }
    if (entry.isSymbolicLink()) continue;
    if (!entry.isFile()) continue;
    fs.copyFileSync(from, to);
  }
}

function hashFileIfExists(file) {
  if (!fs.existsSync(file)) return null;
  return sha256(fs.readFileSync(file));
}

export function defaultIsolateRoot(labHome) {
  return path.join(labHome, 'isolated-workspace');
}

export function isolatePaths(isolateRoot) {
  return {
    kind: ISOLATED_WORKSPACE,
    workspaceRoot: isolateRoot,
    desktopDir: path.join(isolateRoot, 'apps', 'desktop'),
    distDir: path.join(isolateRoot, 'apps', 'desktop', 'dist'),
    identityFile: path.join(isolateRoot, '.peer-lab-isolate.json'),
  };
}

export function fileHash(file) {
  return hashFileIfExists(file);
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

// 只链日常仓库已有的 node_modules，不拷贝。
// Electron 从隔离 desktopDir 启动时，模块解析仍要找到 @peer-agent/*；
// 相对链接会落到日常 packages，主进程代码保持共用，源码/产物隔离不受影响。
export function linkIsolatedNodeModules({ sourceRoot, isolated } = {}) {
  if (!sourceRoot || !isolated?.workspaceRoot || !isolated?.desktopDir) {
    throw new Error('linkIsolatedNodeModules 需要 sourceRoot 和 isolated.workspaceRoot/desktopDir');
  }
  const resolvedSource = path.resolve(sourceRoot);
  const pairs = [
    {
      from: path.join(resolvedSource, 'node_modules'),
      to: path.join(isolated.workspaceRoot, 'node_modules'),
    },
    {
      from: path.join(resolvedSource, 'apps', 'desktop', 'node_modules'),
      to: path.join(isolated.desktopDir, 'electron', 'node_modules'),
    },
  ];
  // 预览构建从 apps/desktop 解析 @vitejs/plugin-react。
  // 不能把整棵 node_modules 链到会话工作区根（macOS 监视会跟着日常 pnpm 树走），
  // 所以在真实目录里逐项链接包；electron/node_modules 仍整目录链接给主进程解析。
  const dailyDesktopModules = path.join(resolvedSource, 'apps', 'desktop', 'node_modules');
  const isolatedDesktopModules = path.join(isolated.desktopDir, 'node_modules');
  const stale = lstatOrNull(isolatedDesktopModules);
  if (stale?.isSymbolicLink()) fs.unlinkSync(isolatedDesktopModules);
  else if (stale && !stale.isDirectory()) {
    throw new Error(`拒绝覆盖已有 node_modules：${isolatedDesktopModules}`);
  }
  const links = [];
  if (fs.existsSync(dailyDesktopModules)) {
    ensureDir(isolatedDesktopModules);
    for (const entry of fs.readdirSync(dailyDesktopModules, { withFileTypes: true })) {
      const from = path.join(dailyDesktopModules, entry.name);
      const to = path.join(isolatedDesktopModules, entry.name);
      const existing = lstatOrNull(to);
      if (existing?.isSymbolicLink() || existing?.isFile()) fs.unlinkSync(to);
      else if (existing) {
        throw new Error(`拒绝覆盖已有依赖项：${to}`);
      }
      const type = entry.isDirectory() || entry.isSymbolicLink()
        ? (process.platform === 'win32' ? 'junction' : 'dir')
        : 'file';
      fs.symlinkSync(from, to, type);
      links.push({ from, to });
    }
  }
  for (const pair of pairs) {
    if (!fs.existsSync(pair.from)) continue;
    const existing = lstatOrNull(pair.to);
    if (existing?.isSymbolicLink()) fs.unlinkSync(pair.to);
    else if (existing) {
      throw new Error(`拒绝覆盖已有 node_modules：${pair.to}`);
    }
    fs.symlinkSync(pair.from, pair.to, process.platform === 'win32' ? 'junction' : 'dir');
    links.push(pair);
  }
  return links;
}

function credentialHelperFileName() {
  return process.platform === 'win32' ? 'peer-credential-helper.exe' : 'peer-credential-helper';
}

export function dailyCredentialHelperPath(sourceRoot) {
  if (!sourceRoot) throw new Error('dailyCredentialHelperPath 需要 sourceRoot');
  const filename = credentialHelperFileName();
  const resolvedSource = path.resolve(sourceRoot);
  for (const profile of ['debug', 'release']) {
    const candidate = path.join(resolvedSource, 'target', profile, filename);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// 隔离副本跳过 target/，所以开发态 helper 不会跟着过去。
// 桌面凭据客户端按 repositoryRoot/target/{debug|release}/peer-credential-helper 查找，
// 隔离 Electron 的仓库根是 isolated-workspace，必须把日常 helper 接到同一相对路径。
export function linkIsolatedCredentialHelper({ sourceRoot, isolated } = {}) {
  if (!sourceRoot || !isolated?.workspaceRoot) {
    throw new Error('linkIsolatedCredentialHelper 需要 sourceRoot 和 isolated.workspaceRoot');
  }
  const filename = credentialHelperFileName();
  const resolvedSource = path.resolve(sourceRoot);
  const links = [];
  for (const profile of ['debug', 'release']) {
    const from = path.join(resolvedSource, 'target', profile, filename);
    if (!fs.existsSync(from)) continue;
    const toDir = path.join(isolated.workspaceRoot, 'target', profile);
    const to = path.join(toDir, filename);
    ensureDir(toDir);
    const existing = lstatOrNull(to);
    if (existing?.isSymbolicLink() || existing?.isFile()) fs.unlinkSync(to);
    else if (existing) {
      throw new Error(`拒绝覆盖已有 credential helper：${to}`);
    }
    fs.symlinkSync(from, to);
    links.push({ from, to, profile });
  }
  return links;
}

export function createIsolatedWorkspace({
  sourceRoot,
  labHome,
  isolateRoot = defaultIsolateRoot(labHome),
} = {}) {
  if (!sourceRoot || !labHome) {
    throw new Error('createIsolatedWorkspace 需要 sourceRoot 和 labHome');
  }
  const resolvedSource = path.resolve(sourceRoot);
  const resolvedIsolate = path.resolve(isolateRoot);
  if (resolvedIsolate === resolvedSource || resolvedIsolate.startsWith(`${resolvedSource}${path.sep}`)) {
    throw new Error('隔离目录不能落在日常仓库内部');
  }

  const paths = isolatePaths(resolvedIsolate);
  ensureDir(paths.workspaceRoot);
  copyTree(resolvedSource, paths.workspaceRoot);
  ensureDir(paths.distDir);
  const linkedModules = linkIsolatedNodeModules({ sourceRoot: resolvedSource, isolated: paths });
  const linkedHelpers = linkIsolatedCredentialHelper({ sourceRoot: resolvedSource, isolated: paths });

  const identity = {
    kind: ISOLATED_WORKSPACE,
    distKind: ISOLATED_DIST,
    sourceRoot: resolvedSource,
    workspaceRoot: paths.workspaceRoot,
    desktopDir: paths.desktopDir,
    distDir: paths.distDir,
    linkedModules,
    linkedHelpers,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(paths.identityFile, `${JSON.stringify(identity, null, 2)}\n`);
  return { ...paths, identity, linkedModules, linkedHelpers };
}

export function bindLabSessionToIsolatedWorkspace({ labHome, isolated } = {}) {
  if (!labHome || !isolated?.workspaceRoot) {
    throw new Error('bindLabSessionToIsolatedWorkspace 需要 labHome 和 isolated.workspaceRoot');
  }
  const file = path.join(labHome, 'settings.json');
  let settings = {};
  if (fs.existsSync(file)) {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  // 会话绑隔离后的 apps/desktop，不要绑整仓根。
  // 整仓副本会让实验窗口去索引/监视整个仓库，界面会卡到点不了。
  const sessionPath = isolated.desktopDir ?? path.join(isolated.workspaceRoot, 'apps', 'desktop');
  const workspace = {
    path: sessionPath,
    name: 'Peer-Agent-lab-isolate',
    addedAt: new Date().toISOString(),
    linkedFolders: [],
  };
  const others = Array.isArray(settings.workspaces)
    ? settings.workspaces.filter((item) => item?.path !== sessionPath && item?.path !== isolated.workspaceRoot)
    : [];
  settings.workspaces = [workspace, ...others];
  settings.activeWorkspace = sessionPath;
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return {
    file,
    activeWorkspace: settings.activeWorkspace,
    workspaces: settings.workspaces,
  };
}

export function prepareLabIsolation({
  sourceRoot,
  labHome,
  isolateRoot = defaultIsolateRoot(labHome),
} = {}) {
  const isolated = createIsolatedWorkspace({ sourceRoot, labHome, isolateRoot });
  const session = bindLabSessionToIsolatedWorkspace({ labHome, isolated });
  return {
    isolated,
    session,
    launch: {
      desktopDir: isolated.desktopDir,
      workspaceRoot: isolated.workspaceRoot,
      distDir: isolated.distDir,
    },
    evidence: {
      kind: ISOLATED_WORKSPACE,
      distKind: ISOLATED_DIST,
      sourceRoot: path.resolve(sourceRoot),
      workspaceRoot: isolated.workspaceRoot,
      desktopDir: isolated.desktopDir,
      distDir: isolated.distDir,
      activeWorkspace: session.activeWorkspace,
      identityFile: isolated.identityFile,
      linkedModules: isolated.linkedModules ?? [],
      linkedHelpers: isolated.linkedHelpers ?? [],
    },
  };
}

export function writeIsolatedDist(isolated, files = {}) {
  if (!isolated?.distDir) throw new Error('writeIsolatedDist 需要 isolated.distDir');
  ensureDir(isolated.distDir);
  const written = [];
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(isolated.distDir, relative);
    ensureDir(path.dirname(full));
    fs.writeFileSync(full, content);
    written.push(full);
  }
  return written;
}

export function injectIsolatedSource(isolated, relativePath, mutate) {
  if (!isolated?.workspaceRoot) throw new Error('injectIsolatedSource 需要 isolated.workspaceRoot');
  const full = path.join(isolated.workspaceRoot, relativePath);
  const before = fs.readFileSync(full, 'utf8');
  const after = mutate(before);
  fs.writeFileSync(full, after);
  return { file: full, beforeHash: sha256(before), afterHash: sha256(after) };
}

const TITLE_CROP_PANEL = path.join(
  'apps',
  'desktop',
  'renderer',
  'src',
  'workbench',
  'BackgroundRuntimePanel.tsx',
);
const TITLE_CROP_SOURCE_FROM = '<header className="background-runtime-header" data-testid="background-runtime-state" data-read-state={readState}>';
const TITLE_CROP_SOURCE_TO = '<header className="background-runtime-header" data-testid="background-runtime-state" data-read-state={readState} style={{ height: \'16px\', overflow: \'hidden\', whiteSpace: \'nowrap\', lineHeight: \'16px\' }}>';
const TITLE_CROP_DIST_FROM = 'className:"background-runtime-header","data-testid":"background-runtime-state"';
const TITLE_CROP_DIST_TO = 'className:"background-runtime-header",style:{height:"16px",overflow:"hidden",whiteSpace:"nowrap",lineHeight:"16px"},"data-testid":"background-runtime-state"';

// 只改隔离源码和隔离产物。日常仓库必须保持干净。
// 必须在 prepare + seedIsolatedRendererDist 之后调用，否则会被干净副本盖掉。
export function injectIsolatedTitleCrop(isolated) {
  const source = injectIsolatedSource(isolated, TITLE_CROP_PANEL, (text) => {
    if (text.includes("height: '16px'")) return text;
    if (!text.includes(TITLE_CROP_SOURCE_FROM)) {
      throw new Error('隔离源码找不到后台运行标题节点，无法植入裁切缺陷');
    }
    return text.replace(TITLE_CROP_SOURCE_FROM, TITLE_CROP_SOURCE_TO);
  });
  const distHits = [];
  if (isolated?.distDir && fs.existsSync(isolated.distDir)) {
    for (const name of fs.readdirSync(isolated.distDir, { recursive: true })) {
      if (!String(name).endsWith('.js')) continue;
      const full = path.join(isolated.distDir, name);
      if (!fs.statSync(full).isFile()) continue;
      const before = fs.readFileSync(full, 'utf8');
      if (!before.includes(TITLE_CROP_DIST_FROM)) continue;
      if (!before.includes('height:"16px"')) {
        fs.writeFileSync(full, before.replaceAll(TITLE_CROP_DIST_FROM, TITLE_CROP_DIST_TO));
      }
      distHits.push(full);
    }
  }
  if (distHits.length === 0) {
    throw new Error('隔离产物找不到后台运行标题节点，无法植入裁切缺陷');
  }
  return { source, distHits };
}

export function withTempLabHome(prefix = 'peer-lab-isolate-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
