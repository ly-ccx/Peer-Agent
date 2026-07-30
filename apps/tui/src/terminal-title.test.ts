import { describe, expect, test } from 'bun:test';

import { formatTerminalTitle } from './terminal-title.ts';

describe('formatTerminalTitle', () => {
  test('uses workspace basename first, VS Code style', () => {
    expect(formatTerminalTitle('/Users/me/Documents/MiaoYan/peer-knowledge')).toBe(
      'peer-knowledge — Peer',
    );
  });

  test('handles trailing slash', () => {
    expect(formatTerminalTitle('/Users/me/projects/demo/')).toBe('demo — Peer');
  });

  test('falls back to Peer for root path', () => {
    expect(formatTerminalTitle('/')).toBe('Peer');
  });

  test('falls back to Peer for empty input', () => {
    expect(formatTerminalTitle('')).toBe('Peer');
    expect(formatTerminalTitle('   ')).toBe('Peer');
  });
});
