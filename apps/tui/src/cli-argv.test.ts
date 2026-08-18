import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_EXEC_MAX_TURNS,
  formatPeerHelp,
  parsePeerArgv,
  shouldRefuseInteractiveTui,
} from './cli-argv.ts';
import { CLI_EXIT } from './cli-exit.ts';

describe('parsePeerArgv', () => {
  test('empty argv starts the interactive TUI', () => {
    expect(parsePeerArgv([])).toEqual({ kind: 'tui' });
  });

  test('prints root help', () => {
    expect(parsePeerArgv(['--help'])).toEqual({ kind: 'help', topic: 'root' });
    expect(parsePeerArgv(['-h'])).toEqual({ kind: 'help', topic: 'root' });
  });

  test('prints exec help', () => {
    expect(parsePeerArgv(['exec', '--help'])).toEqual({ kind: 'help', topic: 'exec' });
    expect(parsePeerArgv(['exec', '-h'])).toEqual({ kind: 'help', topic: 'exec' });
  });

  test('version wins over other args', () => {
    expect(parsePeerArgv(['exec', '--version'])).toEqual({ kind: 'version' });
    expect(parsePeerArgv(['-v'])).toEqual({ kind: 'version' });
  });

  test('parses exec defaults', () => {
    expect(parsePeerArgv(['exec', 'list files'])).toEqual({
      kind: 'exec',
      options: {
        access: 'session',
        tools: undefined,
        outputFormat: 'text',
        provider: undefined,
        model: undefined,
        effort: undefined,
        mode: 'chat',
        workspace: undefined,
        maxTurns: DEFAULT_EXEC_MAX_TURNS,
        promptParts: ['list files'],
      },
    });
  });

  test('parses exec flags including inline values', () => {
    const parsed = parsePeerArgv([
      'exec',
      '--access=full',
      '--tools',
      'bash,file',
      '--output-format',
      'json',
      '--provider=openai-1',
      '--model',
      'gpt-5.4',
      '--effort=max',
      '--mode',
      'plan',
      '--workspace=/tmp/ws',
      '--max-turns',
      '80',
      '--',
      'fix',
      'tests',
    ]);
    expect(parsed).toEqual({
      kind: 'exec',
      options: {
        access: 'full',
        tools: ['bash', 'file'],
        outputFormat: 'json',
        provider: 'openai-1',
        model: 'gpt-5.4',
        effort: 'max',
        mode: 'plan',
        workspace: '/tmp/ws',
        maxTurns: 80,
        promptParts: ['fix', 'tests'],
      },
    });
  });

  test('rejects unknown exec flags and bad values', () => {
    expect(parsePeerArgv(['exec', '--nope'])).toMatchObject({
      kind: 'error',
      exitCode: CLI_EXIT.usage,
    });
    expect(parsePeerArgv(['exec', '--access', 'skip'])).toMatchObject({
      kind: 'error',
      message: 'peer exec: --access must be ask, session, or full',
    });
    expect(parsePeerArgv(['exec', '--max-turns', '0'])).toMatchObject({
      kind: 'error',
      message: 'peer exec: --max-turns must be a positive integer',
    });
  });
});

describe('formatPeerHelp', () => {
  test('root help does not start a session and mentions exec', () => {
    const help = formatPeerHelp('root', 'peer 0.0.0-test');
    expect(help).toContain('peer 0.0.0-test');
    expect(help).toContain('peer exec');
    expect(help).not.toContain('OpenTUI');
  });

  test('exec help documents default session and required full for evals', () => {
    const help = formatPeerHelp('exec', 'peer 0.0.0-test');
    expect(help).toContain('--access ask|session|full');
    expect(help).toContain('default: session');
    expect(help).toContain('--access full');
    expect(help).toContain('--provider <id>');
    expect(help).toContain('provider::model');
    expect(help).toContain('Do not join with /');
  });
});

describe('shouldRefuseInteractiveTui', () => {
  test('refuses when stdout is not a TTY', () => {
    expect(shouldRefuseInteractiveTui(false)).toBe(true);
    expect(shouldRefuseInteractiveTui(undefined)).toBe(true);
    expect(shouldRefuseInteractiveTui(true)).toBe(false);
  });
});
