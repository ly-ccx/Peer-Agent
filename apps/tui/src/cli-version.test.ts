import { describe, expect, test } from 'bun:test';

import {
  formatPeerVersionLine,
  handleCliVersionArgs,
  resolvePeerCliVersion,
  shouldPrintVersionAndExit,
} from './cli-version.ts';

describe('cli-version', () => {
  test('formats single-line peer <semver>', () => {
    expect(formatPeerVersionLine('0.0.1-beta.37')).toBe('peer 0.0.1-beta.37');
  });

  test('prefers explicit env override over package.json', () => {
    expect(
      resolvePeerCliVersion({ PEER_CLI_VERSION: '9.9.9-test' } as NodeJS.ProcessEnv),
    ).toBe('9.9.9-test');
  });

  test('falls back to package.json / compiled version when override env unset', () => {
    // Empty override object skips env.PEER_CLI_VERSION and uses compiled/live/package.
    const version = resolvePeerCliVersion({} as NodeJS.ProcessEnv);
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('detects --version and -v', () => {
    expect(shouldPrintVersionAndExit(['--version'])).toBe(true);
    expect(shouldPrintVersionAndExit(['-v'])).toBe(true);
    expect(shouldPrintVersionAndExit(['--help'])).toBe(false);
    expect(shouldPrintVersionAndExit([])).toBe(false);
  });

  test('handleCliVersionArgs prints and returns true for --version', () => {
    const lines: string[] = [];
    const handled = handleCliVersionArgs(
      ['--version'],
      { PEER_CLI_VERSION: '0.0.1-beta.37' } as NodeJS.ProcessEnv,
      (line) => lines.push(line),
    );
    expect(handled).toBe(true);
    expect(lines).toEqual(['peer 0.0.1-beta.37']);
  });

  test('handleCliVersionArgs returns false for normal args', () => {
    const lines: string[] = [];
    const handled = handleCliVersionArgs(
      ['hello'],
      { PEER_CLI_VERSION: '0.0.1-beta.37' } as NodeJS.ProcessEnv,
      (line) => lines.push(line),
    );
    expect(handled).toBe(false);
    expect(lines).toEqual([]);
  });
});
