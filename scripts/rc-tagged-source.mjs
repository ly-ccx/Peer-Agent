import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from '../packages/protocol/node_modules/typescript/lib/typescript.js';

/** Isolate actual tagged source and its runtime dependency graph, without current-package fallbacks. */
export function createTaggedSource({ repository, ref, directory }) {
  const commit = execFileSync('git', ['rev-parse', `${ref}^{commit}`], { cwd: repository, encoding: 'utf8' }).trim();
  const sources = new Map(), readFiles = new Map(), packages = new Map(); let loaded = false;
  const show = file => {
    const source = execFileSync('git', ['show', `${commit}:${file}`], { cwd: repository, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
    readFiles.set(file, { file, sha256: createHash('sha256').update(source).digest('hex') });
    return source;
  };
  const find = requested => {
    for (const file of [requested, requested.replace(/\.js$/, '.ts')]) {
      try { return [file, show(file)]; } catch { /* Try the original TypeScript input. */ }
    }
    throw Error(`Tagged source missing: ${ref}:${requested}`);
  };
  const output = file => path.join(directory, file.replace(/\.ts$/, '.js'));
  function exported(requested, wanted, visited = new Set()) {
    const [file, source] = find(requested), key = file + ':' + wanted;
    if (visited.has(key)) return null; visited.add(key);
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    for (const node of tree.statements) {
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
        const child = path.posix.normalize(path.posix.join(path.posix.dirname(file), node.moduleSpecifier.text));
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          const element = node.exportClause.elements.find(element => !element.isTypeOnly && element.name.text === wanted);
          if (element) return { sourceFile: child, originalName: element.propertyName?.text ?? wanted };
        } else if (!node.exportClause) {
          const result = exported(child, wanted, visited); if (result) return result;
        }
      }
      if (node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
        && (node.name?.text === wanted || ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(tree) === wanted))) {
        return { sourceFile: file, originalName: wanted };
      }
    }
    return null;
  }
  function loadPackage(name, requested) {
    if (!name.startsWith('@peer-agent/')) throw Error(`Unexpected tagged external dependency: ${name}`);
    const packageName = name.slice('@peer-agent/'.length);
    let records = packages.get(name);
    if (!records) { records = new Map(); packages.set(name, records); }
    const indexFile = `packages/${packageName}/src/index.ts`;
    for (const wanted of requested) {
      if (records.has(wanted)) continue;
      const entry = exported(indexFile, wanted);
      if (!entry) throw Error(`Tagged public export missing: ${ref}:${name}:${wanted}`);
      records.set(wanted, entry); copy(entry.sourceFile);
    }
    const packageDir = path.join(directory, 'node_modules', name); mkdirSync(packageDir, { recursive: true });
    writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name, type: 'module', exports: './index.mjs' }));
    writeFileSync(path.join(packageDir, 'index.mjs'), [...records].map(([name, entry]) => {
      const [real] = find(entry.sourceFile);
      return `export { ${entry.originalName} as ${name} } from ${JSON.stringify(pathToFileURL(output(real)).href)};`;
    }).join('\n') + '\n');
  }
  function copy(requested) {
    const [file, raw] = find(requested);
    if (sources.has(file)) return output(file);
    if (loaded) throw Error('Prepare the complete tagged entry graph before importing; ESM exports are immutable after load');
    sources.set(file, { file, sha256: createHash('sha256').update(raw).digest('hex') });
    const code = file.endsWith('.ts') ? ts.transpileModule(raw, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true,
    } }).outputText : raw;
    const destination = output(file); mkdirSync(path.dirname(destination), { recursive: true }); writeFileSync(destination, code);
    const tree = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
    for (const node of tree.statements) {
      if ((!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) || !node.moduleSpecifier) continue;
      const name = node.moduleSpecifier.text;
      if (name.startsWith('node:')) continue;
      if (name.startsWith('.')) { copy(path.posix.normalize(path.posix.join(path.posix.dirname(file), name))); continue; }
      const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
      if (!bindings || (!ts.isNamedImports(bindings) && !ts.isNamedExports(bindings))) throw Error(`Unsupported tagged import: ${name}`);
      loadPackage(name, bindings.elements.map(element => element.propertyName?.text ?? element.name.text));
    }
    return destination;
  }
  mkdirSync(directory, { recursive: true }); writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}\n');
  return { commit, prepare: entries => entries.forEach(copy), import: entry => { const file=copy(entry); loaded=true; return import(pathToFileURL(file).href); },
    evidence: () => ({ ref, commit, sourceFiles: [...readFiles.values()], toolchain: `TypeScript ${ts.version}; runtime named exports routed to unchanged same-tag modules` }) };
}
