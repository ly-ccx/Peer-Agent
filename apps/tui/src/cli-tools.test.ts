import { describe, expect, test } from 'bun:test';

import { resolveExecToolAllowlist } from './cli-tools.ts';

describe('resolveExecToolAllowlist', () => {
  test('expands bash,file aliases to current capability ids', () => {
    const resolved = resolveExecToolAllowlist(['bash', 'file']);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.capabilityIds).toEqual([
      'local.shell.exec',
      'local.shell.stop',
      'local.file.read',
      'local.file.list',
      'local.file.search',
      'local.file.edit',
      'local.file.write',
    ]);
  });

  test('accepts canonical tool names and capability ids', () => {
    const resolved = resolveExecToolAllowlist(['read_file', 'local.shell.exec']);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.capabilityIds).toEqual(['local.file.read', 'local.shell.exec']);
  });

  test('rejects unknown tokens', () => {
    expect(resolveExecToolAllowlist(['web'])).toEqual({
      ok: false,
      message: 'peer exec: unknown --tools token "web"',
    });
  });
});
