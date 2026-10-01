import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkProjectTranslations } from './check-project-agent-i18n.mjs';
const source = readFileSync(new URL('../../../packages/i18n/src/index.ts', import.meta.url), 'utf8');
test('project namespaces exist explicitly in both locales, without fallback masking missing keys', () => {
  const result = checkProjectTranslations(source); assert.ok(result.keys > 100);
  assert.throws(() => checkProjectTranslations(source.replace("    'projectAgent.host.title':", "    'removed.host.title':")), /key sets differ/);
  assert.throws(() => checkProjectTranslations(source.replace('Messages support up to 100000', 'Messages {missing} support up to 100000')), /placeholders differ/);
});
