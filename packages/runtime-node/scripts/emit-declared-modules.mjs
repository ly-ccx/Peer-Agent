import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

// A sibling declaration makes TypeScript skip the .mjs implementation during project emit.
// Preserve that runtime module and its declared interface, including rewritten .ts imports.
const source = new URL('../src/', import.meta.url);
const output = new URL('../dist/', import.meta.url);
async function emitDeclaredModules(relative = '') {
  const entries = await readdir(new URL(relative, source), { withFileTypes: true });
  for (const entry of entries) {
    const name = `${relative}${entry.name}`;
    if (entry.isDirectory()) { await emitDeclaredModules(`${name}/`); continue; }
    if (!entry.name.endsWith('.d.mts')) continue;
    const runtime = name.replace(/\.d\.mts$/, '.mjs');
    let code;
    try { code = await readFile(new URL(runtime, source), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const emitted = ts.transpileModule(code, {
      fileName: runtime,
      compilerOptions: { allowJs: true, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
        rewriteRelativeImportExtensions: true },
      reportDiagnostics: true,
    });
    const errors = (emitted.diagnostics ?? []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
    if (errors.length) throw Error(errors.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'));
    await mkdir(new URL(relative, output), { recursive: true });
    await writeFile(new URL(runtime, output), emitted.outputText);
    await copyFile(new URL(name, source), new URL(name, output));
  }
}
await emitDeclaredModules();
