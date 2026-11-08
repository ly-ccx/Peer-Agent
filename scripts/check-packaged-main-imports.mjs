/**
 * Fail when a module reachable from the Electron main entry would be missing
 * from app.asar.
 *
 * electron-builder copies production node_modules, then drops
 * `node_modules/@peer-agent/<star>/src` (see apps/desktop/electron-builder.yml).
 * Positive patterns put system-context and interactive-content source back.
 * A package export or relative import that still points at excluded source
 * launches as ERR_MODULE_NOT_FOUND. This simulates that file list and walks
 * static imports from the desktop `main` entry. The walk continues through
 * the app and `@peer-agent/*`. Other production dependencies are accepted
 * once the resolved target is in the file list; electron-builder copies those
 * packages as a unit. The check runs in PR CI, before a platform package exists.
 *
 * The pattern rewrite follows app-builder-lib 26 getMainFileMatchers and
 * getNodeModuleFileMatcher: app files need a positive match, node_modules
 * start included and then honor only the negative `files` patterns, and a
 * later positive pattern can put a file back.
 */
import { builtinModules, createRequire } from 'node:module';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(SCRIPT_DIR, '..');

const EXCLUDED_NAMES = '.git,.hg,.svn,CVS,RCS,SCCS,__pycache__,.DS_Store,thumbs.db,.gitignore,.gitkeep,.gitattributes,.npmignore,.idea,.vs,.flowconfig,.jshintrc,.eslintrc,.circleci,.yarn-integrity,.yarn-metadata.json,yarn-error.log,yarn.lock,package-lock.json,npm-debug.log,pnpm-lock.yaml,bun.lock,bun.lockb,appveyor.yml,.travis.yml,circle.yml,.nyc_output,.husky,.github,electron-builder.env';
const EXCLUDED_EXTS = 'iml,hprof,orig,pyc,pyo,rbc,swp,csproj,sln,suo,xproj,cc,d.ts,mk,a,o,obj,forge-meta';
const TOP_LEVEL_EXCLUDED = new Set([
  'karma.conf.js', '.coveralls.yml', 'README.md', 'readme.markdown', 'README', 'readme.md',
  'Readme.md', 'Readme', 'readme', 'test', 'tests', '__tests__', 'powered-test', 'example',
  'examples', '.bin',
]);
const EXCLUDED_FILE_NAMES = new Set([
  '.DS_Store', 'node_modules', 'CHANGELOG.md', 'ChangeLog', 'changelog.md', 'Changelog.md',
  'Changelog', 'binding.gyp', '.npmignore', 'node_gyp_bins',
  ...EXCLUDED_NAMES.split(','),
]);
const NODE_EXCLUDED_EXTS = ['.o', '.obj', '.pdb', '.dll', '.exe', ...EXCLUDED_EXTS.split(',').map((ext) => `.${ext}`)];
const SOURCE_EXTENSIONS = new Set(['.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx', '.mts', '.cts']);
const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const EXPORT_CONDITIONS = new Set(['node', 'import', 'default']);
const BUILTINS = new Set(builtinModules);

let minimatchModule;

function loadMinimatch(desktopDir) {
  if (minimatchModule) return minimatchModule;
  const desktopRequire = createRequire(path.join(desktopDir, 'package.json'));
  const builderPackage = desktopRequire.resolve('electron-builder/package.json');
  const appBuilderPackage = createRequire(builderPackage).resolve('app-builder-lib/package.json');
  minimatchModule = createRequire(appBuilderPackage)('minimatch');
  return minimatchModule;
}

export function parseBuilderFilePatterns(yaml) {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => /^files:\s*(?:#.*)?$/.test(line));
  if (start < 0) throw new Error('electron-builder.yml has no files list');
  const patterns = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = line.match(/^  - (?:"([^"]*)"|'([^']*)'|(\S+))\s*(?:#.*)?$/);
    if (!item) {
      if (/^\S/.test(line)) break;
      throw new Error(`Unsupported electron-builder files entry: ${line}`);
    }
    patterns.push(item[1] ?? item[2] ?? item[3]);
  }
  if (patterns.length === 0) throw new Error('electron-builder.yml files list is empty');
  return patterns;
}

function hasMagic(parsed) {
  const set = parsed.set;
  if (!set || set.length !== 1) return true;
  return set[0].some((part) => typeof part !== 'string');
}

function compilePatterns(patterns, Minimatch) {
  const compiled = [];
  for (const pattern of patterns) {
    const parsed = new Minimatch(pattern, { dot: true });
    compiled.push(parsed);
    if (!pattern.includes('.') && !hasMagic(parsed)) {
      compiled.push(new Minimatch(`${pattern}/**/*`, { dot: true }));
    }
  }
  return compiled;
}

function minimatchAll(filePath, compiled, isDirectory) {
  let match = false;
  for (const pattern of compiled) {
    if (match !== pattern.negate) continue;
    match = pattern.match(filePath, isDirectory && !pattern.negate);
  }
  return match;
}

export function buildPackagingPatterns(userPatterns) {
  const patterns = [...userPatterns];
  const customFirst = [];
  const onlyIgnore = patterns.length > 0 && patterns.every((pattern) => pattern.startsWith('!'));
  if (patterns.length === 0 || onlyIgnore) customFirst.push('**/*');
  else if (!patterns.includes('package.json')) patterns.push('package.json');

  const nodeIndex = patterns.findIndex((pattern) => !pattern.startsWith('!')
    && (pattern.includes('/node_modules') || pattern.includes('node_modules/')));
  if (nodeIndex !== -1) patterns.splice(nodeIndex, 0, '!**/node_modules/**');
  else customFirst.push('!**/node_modules/**');

  customFirst.push('!build{,/**/*}');
  let insertIndex = 0;
  for (let index = patterns.length - 1; index >= 0; index -= 1) {
    if (patterns[index].startsWith('**/')) {
      insertIndex = index + 1;
      break;
    }
  }
  patterns.splice(insertIndex, 0, ...customFirst);
  patterns.push(`!**/*.{${EXCLUDED_EXTS},pdb}`);
  patterns.push('!**/._*');
  patterns.push('!**/electron-builder.{yaml,yml,json,json5,toml,ts}');
  patterns.push(`!**/{${EXCLUDED_NAMES}}`);
  patterns.push('!.yarn{,/**/*}');
  patterns.push('!.editorconfig');
  patterns.push('!.yarnrc.yml');

  const nodePatterns = userPatterns.filter((pattern) => pattern.startsWith('!'));
  if (nodePatterns.length > 0) nodePatterns.unshift('**/*');
  return { appPatterns: patterns, nodePatterns };
}

function nodeExtensionExcluded(name) {
  return NODE_EXCLUDED_EXTS.some((ext) => name.endsWith(ext));
}

export function createPackagePredicate(userPatterns, Minimatch) {
  const { appPatterns, nodePatterns } = buildPackagingPatterns(userPatterns);
  const app = compilePatterns(appPatterns, Minimatch);
  const node = compilePatterns(nodePatterns, Minimatch);

  function packageRoot(asarPath) {
    const parts = asarPath.split('/');
    if (parts[0] !== 'node_modules' || parts.length < 2) return null;
    if (parts[1].startsWith('@')) {
      if (parts.length < 3) return null;
      return parts.slice(0, 3).join('/');
    }
    return parts.slice(0, 2).join('/');
  }

  function nodeCopierIncludes(asarPath) {
    const root = packageRoot(asarPath);
    if (!root || !asarPath.startsWith(`${root}/`)) return false;
    const relative = asarPath.slice(root.length + 1).split('/');
    let current = root;
    for (let index = 0; index < relative.length; index += 1) {
      const name = relative[index];
      current += `/${name}`;
      const isDirectory = index < relative.length - 1;
      if (EXCLUDED_FILE_NAMES.has(name) || name.startsWith('._')) return false;
      if (index === 0 && TOP_LEVEL_EXCLUDED.has(name)) return false;
      if (!isDirectory && nodeExtensionExcluded(name)) return false;
      if (!minimatchAll(current, node, isDirectory)) return false;
    }
    return true;
  }

  return function isPackaged(asarPath) {
    const normalized = asarPath.split(path.sep).join('/');
    if (normalized.startsWith('node_modules/')) {
      return nodeCopierIncludes(normalized) || minimatchAll(normalized, app, false);
    }
    return minimatchAll(normalized, app, false);
  };
}

function isExternal(specifier) {
  if (specifier.startsWith('node:') || specifier.startsWith('bun:') || specifier === 'electron' || specifier.startsWith('electron/')) {
    return true;
  }
  return BUILTINS.has(specifier);
}

function isIdentChar(char) {
  return char != null && /[A-Za-z0-9_$]/.test(char);
}

function readString(source, index) {
  const quote = source[index];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let cursor = index + 1;
  let value = '';
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '\\') {
      value += source[cursor + 1] ?? '';
      cursor += 2;
      continue;
    }
    if (quote === '`' && char === '$' && source[cursor + 1] === '{') {
      return { interpolated: true, end: cursor };
    }
    if (char === quote) return { value, end: cursor + 1 };
    value += char;
    cursor += 1;
  }
  return null;
}

function skipTrivia(source, index) {
  let cursor = index;
  while (cursor < source.length) {
    if (/\s/.test(source[cursor])) {
      cursor += 1;
      continue;
    }
    if (source[cursor] === '/' && source[cursor + 1] === '/') {
      while (cursor < source.length && source[cursor] !== '\n') cursor += 1;
      continue;
    }
    if (source[cursor] === '/' && source[cursor + 1] === '*') {
      cursor += 2;
      while (cursor < source.length && !(source[cursor] === '*' && source[cursor + 1] === '/')) cursor += 1;
      cursor += 2;
      continue;
    }
    break;
  }
  return cursor;
}

function wordAt(source, index, word) {
  if (source.slice(index, index + word.length) !== word) return false;
  return !isIdentChar(source[index + word.length]);
}

function findKeyword(source, index, keyword) {
  let cursor = index;
  let depth = 0;
  while (cursor < source.length) {
    cursor = skipTrivia(source, cursor);
    if (cursor >= source.length) return null;
    const char = source[cursor];
    if (char === "'" || char === '"' || char === '`') {
      const text = readString(source, cursor);
      if (!text) return null;
      cursor = text.end;
      continue;
    }
    if (char === '{') {
      depth += 1;
      cursor += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      cursor += 1;
      continue;
    }
    if (char === ';' && depth <= 0) return null;
    if (depth <= 0 && wordAt(source, cursor, keyword)) return cursor + keyword.length;
    cursor += 1;
  }
  return null;
}

export function listRuntimeSpecifiers(source) {
  const specs = [];
  let index = 0;
  while (index < source.length) {
    index = skipTrivia(source, index);
    if (index >= source.length) break;
    const char = source[index];
    if (char === "'" || char === '"' || char === '`') {
      const text = readString(source, index);
      index = text ? text.end : index + 1;
      continue;
    }
    if (!isIdentChar(char) || (index > 0 && isIdentChar(source[index - 1]))) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < source.length && isIdentChar(source[index])) index += 1;
    const word = source.slice(start, index);
    if (word !== 'import' && word !== 'export' && word !== 'require') continue;

    if (word === 'require') {
      const cursor = skipTrivia(source, index);
      if (source[cursor] !== '(') continue;
      const after = skipTrivia(source, cursor + 1);
      const text = readString(source, after);
      if (text?.value != null) {
        specs.push({ specifier: text.value, dynamic: false });
        index = text.end;
      }
      continue;
    }

    if (word === 'import') {
      const cursor = skipTrivia(source, index);
      if (source[cursor] === '.') continue;
      if (source[cursor] === '(') {
        const after = skipTrivia(source, cursor + 1);
        if (source[after] === "'" || source[after] === '"' || source[after] === '`') {
          const text = readString(source, after);
          if (text?.value != null) specs.push({ specifier: text.value, dynamic: true });
          else if (text?.interpolated) specs.push({ unresolved: 'interpolated import()' });
          if (text) index = text.end;
          continue;
        }
        if (source.slice(after, after + 3) === 'new') {
          let urlIndex = skipTrivia(source, after + 3);
          if (wordAt(source, urlIndex, 'URL')) {
            urlIndex = skipTrivia(source, urlIndex + 3);
            if (source[urlIndex] === '(') {
              urlIndex = skipTrivia(source, urlIndex + 1);
              const text = readString(source, urlIndex);
              if (text?.value != null) {
                const comma = skipTrivia(source, text.end);
                if (source[comma] === ',') {
                  const parent = skipTrivia(source, comma + 1);
                  if (source.slice(parent, parent + 'import.meta.url'.length) === 'import.meta.url') {
                    specs.push({ specifier: text.value, dynamic: true });
                    index = parent + 'import.meta.url'.length;
                    continue;
                  }
                }
              } else if (text?.interpolated) {
                specs.push({ unresolved: 'interpolated import(new URL())' });
                index = text.end;
                continue;
              }
            }
          }
        }
        if (isIdentChar(source[after])) {
          let end = after;
          while (end < source.length && isIdentChar(source[end])) end += 1;
          specs.push({ dynamicIdent: source.slice(after, end) });
          index = end;
        }
        continue;
      }
      if (source[cursor] === "'" || source[cursor] === '"' || source[cursor] === '`') {
        const text = readString(source, cursor);
        if (text?.value != null) {
          specs.push({ specifier: text.value, dynamic: false });
          index = text.end;
        }
        continue;
      }
    }

    const fromAt = findKeyword(source, index, 'from');
    if (fromAt == null) continue;
    const afterFrom = skipTrivia(source, fromAt);
    const text = readString(source, afterFrom);
    if (text?.value != null) {
      specs.push({ specifier: text.value, dynamic: false });
      index = text.end;
    }
  }
  return specs;
}

function literalArrayFor(ident, source) {
  const expression = new RegExp(String.raw`for\s*\(\s*(?:const|let|var)\s+${ident}\s+of\s*\[([^\]]*)\]`, 'g');
  const values = [];
  for (const match of source.matchAll(expression)) {
    for (const literal of match[1].matchAll(/['"`]([^'"`]*)['"`]/g)) values.push(literal[1]);
  }
  return values;
}

function splitPackageSpecifier(specifier) {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    if (parts.length < 2) throw new Error(`Invalid package specifier ${specifier}`);
    const name = parts.slice(0, 2).join('/');
    const rest = parts.slice(2).join('/');
    return { name, subpath: rest ? `./${rest}` : '.' };
  }
  const slash = specifier.indexOf('/');
  if (slash === -1) return { name: specifier, subpath: '.' };
  return { name: specifier.slice(0, slash), subpath: `./${specifier.slice(slash + 1)}` };
}

function findPackageJson(name, startDir) {
  let dir = startDir;
  while (dir) {
    const candidate = path.join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function matchExport(exportsObject, subpath) {
  if (Object.hasOwn(exportsObject, subpath)) return { value: exportsObject[subpath], token: null };
  let best = null;
  for (const [key, value] of Object.entries(exportsObject)) {
    if (!key.includes('*')) continue;
    const star = key.indexOf('*');
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    const token = subpath.slice(prefix.length, subpath.length - suffix.length);
    if (token.startsWith('/') || token.endsWith('/') || token.includes('../')) continue;
    if (best == null || key.length > best.key.length) best = { value, token, key };
  }
  return best;
}

function resolveExportValue(value, token) {
  if (typeof value === 'string') return token == null ? value : value.replaceAll('*', token);
  if (value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = resolveExportValue(item, token);
      if (resolved) return resolved;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (!EXPORT_CONDITIONS.has(key)) continue;
      const resolved = resolveExportValue(nested, token);
      if (resolved) return resolved;
    }
  }
  return null;
}

function resolveSpecifier(specifier, parentFile) {
  const clean = specifier.split('?')[0].split('#')[0];
  if (clean.startsWith('./') || clean.startsWith('../')) {
    const file = path.resolve(path.dirname(parentFile), clean);
    if (!existsSync(file) || !statSync(file).isFile()) {
      throw new Error(`Cannot resolve ${specifier}`);
    }
    return realpathSync(file);
  }
  const { name, subpath } = splitPackageSpecifier(clean);
  const packageJsonPath = findPackageJson(name, path.dirname(parentFile));
  if (!packageJsonPath) throw new Error(`Cannot find package ${name}`);
  const packageRoot = path.dirname(realpathSync(packageJsonPath));
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  let target;
  if (manifest.exports == null) {
    target = subpath === '.' ? (manifest.main || manifest.module || './index.js') : subpath;
  } else if (typeof manifest.exports === 'string') {
    if (subpath !== '.') throw new Error(`${name} does not export ${subpath}`);
    target = manifest.exports;
  } else {
    const matched = matchExport(manifest.exports, subpath);
    if (matched == null) throw new Error(`${name} does not export ${subpath}`);
    target = resolveExportValue(matched.value, matched.token);
  }
  if (typeof target !== 'string') throw new Error(`${name} export ${subpath} has no runtime target`);
  const file = path.resolve(packageRoot, target);
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`${name} export ${subpath} is missing at ${target}`);
  }
  return realpathSync(file);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function collectProductionPackages(desktopDir) {
  const names = new Set();
  const root = readJson(path.join(desktopDir, 'package.json'));
  const queue = [
    ...Object.keys(root.dependencies || {}),
    ...Object.keys(root.optionalDependencies || {}),
  ].map((name) => ({ name, from: desktopDir }));
  while (queue.length > 0) {
    const { name, from } = queue.shift();
    if (names.has(name)) continue;
    const packageJsonPath = findPackageJson(name, from);
    if (!packageJsonPath) continue;
    names.add(name);
    const manifest = readJson(packageJsonPath);
    const nextFrom = path.dirname(packageJsonPath);
    for (const dependency of [
      ...Object.keys(manifest.dependencies || {}),
      ...Object.keys(manifest.optionalDependencies || {}),
    ]) {
      queue.push({ name: dependency, from: nextFrom });
    }
  }
  return names;
}

function locateFile(file, desktopDir) {
  const desktopReal = realpathSync(desktopDir);
  let dir = path.dirname(file);
  while (dir !== path.dirname(dir)) {
    const packageJsonPath = path.join(dir, 'package.json');
    if (existsSync(packageJsonPath)) {
      const manifest = readJson(packageJsonPath);
      if (realpathSync(dir) === desktopReal) {
        return {
          kind: 'app',
          asarPath: path.relative(desktopReal, file).split(path.sep).join('/'),
          name: manifest.name,
        };
      }
      if (typeof manifest.name === 'string' && manifest.name) {
        const relative = path.relative(dir, file).split(path.sep).join('/');
        return {
          kind: 'package',
          name: manifest.name,
          asarPath: `node_modules/${manifest.name}/${relative}`,
        };
      }
    }
    dir = path.dirname(dir);
  }
  return { kind: 'outside', asarPath: null, name: null };
}

function shouldParse(file, located, workspacePrefixes) {
  const extension = path.extname(file);
  if (!SOURCE_EXTENSIONS.has(extension)) return false;
  if (located.kind === 'app') return true;
  if (located.kind === 'package') {
    return workspacePrefixes.some((prefix) => located.name.startsWith(prefix));
  }
  return false;
}

export function checkPackagedMainImports({
  repoRoot: root = repoRoot,
  desktopDir = path.join(root, 'apps/desktop'),
  entry,
  userPatterns,
  workspacePrefixes = ['@peer-agent/'],
} = {}) {
  const patterns = userPatterns ?? parseBuilderFilePatterns(readFileSync(path.join(desktopDir, 'electron-builder.yml'), 'utf8'));
  const { Minimatch } = loadMinimatch(path.join(repoRoot, 'apps/desktop'));
  const isPackaged = createPackagePredicate(patterns, Minimatch);
  const manifest = readJson(path.join(desktopDir, 'package.json'));
  const entryFile = entry ?? path.resolve(desktopDir, manifest.main);
  if (!existsSync(entryFile)) throw new Error(`Main entry does not exist: ${entryFile}`);
  const production = collectProductionPackages(desktopDir);
  const missing = [];
  const warnings = [];
  const seenMissing = new Set();
  const visited = new Set();
  const entryReal = realpathSync(entryFile);
  const queue = [entryReal];
  let checked = 0;

  function record(item) {
    const key = `${item.from}\0${item.specifier}\0${item.asarPath ?? item.reason}`;
    if (seenMissing.has(key)) return;
    seenMissing.add(key);
    missing.push(item);
  }

  function consider(file, from, specifier) {
    const located = locateFile(file, desktopDir);
    let ok = false;
    let reason = 'outside the packaged app and its production dependencies';
    if (located.kind === 'app' || located.kind === 'package') {
      if (located.kind === 'package' && !production.has(located.name)) {
        reason = `${located.name} is not a production dependency of the desktop app`;
      } else if (located.kind === 'package' && TYPESCRIPT_EXTENSIONS.has(path.extname(file))) {
        reason = `TypeScript source in node_modules cannot be loaded: ${located.asarPath}`;
      } else if (!isPackaged(located.asarPath)) {
        reason = `${located.asarPath} is not in the simulated app.asar file list`;
      } else {
        ok = true;
      }
    }
    if (!ok) {
      record({
        from: path.relative(root, from).split(path.sep).join('/'),
        specifier,
        asarPath: located.asarPath,
        reason,
      });
    }
    return located;
  }

  consider(entryReal, entryReal, manifest.main ?? '<main>');

  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    checked += 1;
    const located = locateFile(file, desktopDir);
    if (!shouldParse(file, located, workspacePrefixes)) continue;
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch (error) {
      record({
        from: path.relative(root, file).split(path.sep).join('/'),
        specifier: '<read>',
        asarPath: located.asarPath,
        reason: error.message,
      });
      continue;
    }
    for (const spec of listRuntimeSpecifiers(source)) {
      if (spec.unresolved) {
        warnings.push(`${path.relative(root, file)}: ${spec.unresolved}`);
        continue;
      }
      const values = spec.dynamicIdent ? literalArrayFor(spec.dynamicIdent, source) : [spec.specifier];
      if (spec.dynamicIdent && values.length === 0) {
        warnings.push(`${path.relative(root, file)}: unresolved dynamic import(${spec.dynamicIdent})`);
        continue;
      }
      for (const specifier of values) {
        if (!specifier || isExternal(specifier)) continue;
        let resolved;
        try {
          resolved = resolveSpecifier(specifier, file);
        } catch (error) {
          if (spec.dynamic || spec.dynamicIdent) {
            warnings.push(`${path.relative(root, file)}: optional dynamic import ${specifier} (${error.message})`);
            continue;
          }
          record({
            from: path.relative(root, file).split(path.sep).join('/'),
            specifier,
            asarPath: null,
            reason: error.message,
          });
          continue;
        }
        consider(resolved, file, specifier);
        queue.push(resolved);
      }
    }
  }

  return { missing, warnings, checked };
}

function main() {
  const result = checkPackagedMainImports();
  for (const warning of result.warnings) console.warn(`warning: ${warning}`);
  if (result.missing.length === 0) {
    console.log(`Packaged main import check passed (${result.checked} modules).`);
    return;
  }
  console.error(`Packaged main import check failed. ${result.missing.length} import target(s) would be missing from app.asar:`);
  for (const item of result.missing) {
    console.error(`- ${item.specifier}`);
    console.error(`  from ${item.from}`);
    if (item.asarPath) console.error(`  asar ${item.asarPath}`);
    console.error(`  ${item.reason}`);
  }
  process.exitCode = 1;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) main();
