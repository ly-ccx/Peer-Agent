import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const PREFIXES = ['projectAgent.', 'modelRouting.', 'developer.'];
export function checkProjectTranslations(source) {
  const tree = ts.createSourceFile('i18n.ts', source, ts.ScriptTarget.Latest, true);
  let resources;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'resources') resources = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(resources && ts.isObjectLiteralExpression(resources), 'locale resource object required');
  const locales = new Map(resources.properties.filter(ts.isPropertyAssignment).map(locale => [locale.name.text,
    new Map(locale.initializer.properties.filter(ts.isPropertyAssignment).filter(p => PREFIXES.some(prefix => p.name.text?.startsWith(prefix)))
      .map(p => [p.name.text, ts.isStringLiteral(p.initializer) ? p.initializer.text : null]))]));
  const zh = locales.get('zh-CN'), en = locales.get('en-US');
  assert.ok(zh && en, 'both explicit locales required');
  assert.deepEqual([...zh.keys()].sort(), [...en.keys()].sort(), 'namespace key sets differ');
  const placeholders = value => [...value.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
  for (const [key, value] of zh) {
    assert.ok(typeof value === 'string' && value.trim() && typeof en.get(key) === 'string' && en.get(key).trim(), key + ': empty/nonliteral translation');
    assert.deepEqual(placeholders(value), placeholders(en.get(key)), key + ': placeholders differ');
  }
  return { keys: zh.size, namespaces: Object.fromEntries(PREFIXES.map(prefix => [prefix, [...zh.keys()].filter(key => key.startsWith(prefix)).length])) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(checkProjectTranslations(readFileSync(new URL('../../../packages/i18n/src/index.ts', import.meta.url), 'utf8'))));
}
