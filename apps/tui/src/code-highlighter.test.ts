import { describe, expect, test } from 'bun:test';

import { highlightCode, normalizeLanguage } from './code-highlighter.ts';

function kindsOf(source: string, language: string): string[] {
  return highlightCode(source, language).map((token) => `${token.kind}:${token.text}`);
}

function hasKind(source: string, language: string, kind: string, text: string): boolean {
  return highlightCode(source, language).some((token) => token.kind === kind && token.text.includes(text));
}

describe('code-highlighter', () => {
  test('normalizes common language aliases', () => {
    expect(normalizeLanguage('TypeScript')).toBe('ts');
    expect(normalizeLanguage('tsx title="x"')).toBe('ts');
    expect(normalizeLanguage('python3')).toBe('python');
    expect(normalizeLanguage('bash')).toBe('shell');
    expect(normalizeLanguage('c++')).toBe('cpp');
  });

  test('highlights TypeScript keywords, types, strings, comments, and numbers', () => {
    const source = [
      'type Result = { status: \'ok\' };',
      '// done',
      'const value = 42;',
      'function run() { return true; }',
    ].join('\n');
    expect(hasKind(source, 'ts', 'keyword', 'type')).toBe(true);
    expect(hasKind(source, 'ts', 'type', 'Result')).toBe(true);
    expect(hasKind(source, 'ts', 'string', "'ok'")).toBe(true);
    expect(hasKind(source, 'ts', 'comment', '// done')).toBe(true);
    expect(hasKind(source, 'ts', 'number', '42')).toBe(true);
    expect(hasKind(source, 'ts', 'keyword', 'const')).toBe(true);
    expect(hasKind(source, 'ts', 'function', 'run')).toBe(true);
    expect(hasKind(source, 'ts', 'literal', 'true')).toBe(true);
  });

  test('highlights Python def/import and hash comments', () => {
    const source = 'def greet(name):\n    # hi\n    return f"hello {name}"';
    expect(hasKind(source, 'python', 'keyword', 'def')).toBe(true);
    expect(hasKind(source, 'python', 'function', 'greet')).toBe(true);
    expect(hasKind(source, 'python', 'comment', '# hi')).toBe(true);
    expect(hasKind(source, 'python', 'string', 'f"hello {name}"')).toBe(true);
  });

  test('highlights SQL keywords case-insensitively', () => {
    const source = 'SELECT id FROM users WHERE active = TRUE;';
    expect(hasKind(source, 'sql', 'keyword', 'SELECT')).toBe(true);
    expect(hasKind(source, 'sql', 'keyword', 'FROM')).toBe(true);
    expect(hasKind(source, 'sql', 'keyword', 'WHERE')).toBe(true);
    expect(hasKind(source, 'sql', 'literal', 'TRUE') || hasKind(source, 'sql', 'keyword', 'TRUE')).toBe(true);
  });

  test('highlights JSON properties and strings distinctly', () => {
    const source = '{ "name": "peer", "count": 3, "ok": true }';
    expect(hasKind(source, 'json', 'property', '"name"')).toBe(true);
    expect(hasKind(source, 'json', 'string', '"peer"')).toBe(true);
    expect(hasKind(source, 'json', 'number', '3')).toBe(true);
    expect(hasKind(source, 'json', 'literal', 'true')).toBe(true);
  });

  test('highlights shell keywords and comments', () => {
    const source = 'if [ -f package.json ]; then\n  # build\n  echo "ok"\nfi';
    expect(hasKind(source, 'bash', 'keyword', 'if')).toBe(true);
    expect(hasKind(source, 'bash', 'keyword', 'then')).toBe(true);
    expect(hasKind(source, 'bash', 'comment', '# build')).toBe(true);
    expect(hasKind(source, 'bash', 'string', '"ok"')).toBe(true);
  });

  test('unknown language still tokenizes strings and // comments without throwing', () => {
    const source = 'foo // bar\nname = "x"';
    const tokens = highlightCode(source, 'not-a-real-lang');
    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens.some((token) => token.kind === 'comment')).toBe(true);
    expect(tokens.some((token) => token.kind === 'string')).toBe(true);
    expect(tokens.map((token) => token.text).join('')).toBe(source);
  });

  test('token text reconstructs the original source for highlighted languages', () => {
    const source = 'const x = 1;\n/* c */\nreturn x;';
    expect(highlightCode(source, 'js').map((token) => token.text).join('')).toBe(source);
    expect(kindsOf(source, 'js').some((entry) => entry.startsWith('keyword:'))).toBe(true);
  });

  test('diff language is left plain for the dedicated diff renderer', () => {
    const source = '+added\n-removed';
    const tokens = highlightCode(source, 'diff');
    expect(tokens).toEqual([{ kind: 'plain', text: source }]);
  });
});
