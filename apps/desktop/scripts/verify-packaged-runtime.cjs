const { readdirSync, statSync } = require('node:fs');
const path = require('node:path');
const { extractFile, listPackage } = require('@electron/asar');

const WORKSPACE_SCOPE = '@peer-agent/';
const repoRoot = path.resolve(__dirname, '../../..');
const defaultOutputDirectory = path.join(repoRoot, 'dist-electron');

function collectArchives(targetPath) {
  if (!statSync(targetPath).isDirectory()) {
    return path.basename(targetPath) === 'app.asar' ? [targetPath] : [];
  }

  return readdirSync(targetPath, { withFileTypes: true }).flatMap((entry) => {
    const childPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) return collectArchives(childPath);
    return entry.name === 'app.asar' ? [childPath] : [];
  });
}

function readArchiveJson(archivePath, filePath) {
  return JSON.parse(extractFile(archivePath, filePath).toString('utf8'));
}

function runtimeExportTarget(packageJson) {
  const rootExport = packageJson.exports?.['.'] ?? packageJson.exports;
  if (typeof rootExport === 'string') return rootExport;
  if (rootExport && typeof rootExport === 'object') {
    for (const condition of ['node', 'default', 'import', 'require']) {
      if (typeof rootExport[condition] === 'string') return rootExport[condition];
    }
  }
  return packageJson.main;
}

function mainProcessWorkspaceImports(archivePath) {
  const imports = new Set();
  const importPattern = /(?:from\s*|import\s*\()\s*['"](@peer-agent\/[^/'"]+)/g;

  for (const archiveEntry of listPackage(archivePath)) {
    if (!archiveEntry.startsWith('/electron/') || !archiveEntry.endsWith('.mjs')) continue;
    if (archiveEntry.includes('.test.')) continue;

    const source = extractFile(archivePath, archiveEntry.slice(1)).toString('utf8');
    for (const match of source.matchAll(importPattern)) imports.add(match[1]);
  }

  return [...imports].sort();
}

function assertArchiveRuntime(archivePath) {
  const workspaceDependencies = mainProcessWorkspaceImports(archivePath);

  for (const packageName of workspaceDependencies) {
    const packageDirectory = `node_modules/${packageName}`;
    const packageJson = readArchiveJson(archivePath, `${packageDirectory}/package.json`);
    const target = runtimeExportTarget(packageJson);
    if (!target) continue;

    const targetPath = path.posix.join(packageDirectory, target);
    try {
      extractFile(archivePath, targetPath);
    } catch (error) {
      throw new Error(
        `${archivePath}: runtime entry for ${packageName} is missing: ${targetPath}`,
        { cause: error },
      );
    }
  }

  console.log(`[packaged-runtime] verified ${workspaceDependencies.length} main-process workspace imports in ${archivePath}`);
}

const targets = process.argv.slice(2);
const roots = targets.length > 0 ? targets.map((target) => path.resolve(target)) : [defaultOutputDirectory];
const archives = roots.flatMap(collectArchives);

if (archives.length === 0) {
  throw new Error(`No app.asar archives found under: ${roots.join(', ')}`);
}

for (const archivePath of archives) assertArchiveRuntime(archivePath);
