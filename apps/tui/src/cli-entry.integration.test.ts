import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const entry = join(import.meta.dir, 'index.tsx');

async function runPeer(args: string[], stdin = ''): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const process = Bun.spawn(['bun', entry, ...args], {
    cwd: import.meta.dir,
    stdin: new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe('peer CLI entry', () => {
  test('peer --help prints usage and exits 0 without starting TUI', async () => {
    const result = await runPeer(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('peer exec');
    expect(result.stdout).not.toContain('OpenTUI');
    expect(result.stderr).toBe('');
  });

  test('peer exec --help prints exec flags', async () => {
    const result = await runPeer(['exec', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--access ask|session|full');
    expect(result.stdout).toContain('default: session');
  });

  test('non-TTY peer refuses to start the TUI', async () => {
    const result = await runPeer([]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Use `peer exec`');
  });

  test('--access ask fails without a TTY', async () => {
    const result = await runPeer(['exec', '--access', 'ask', 'list files']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('without a TTY');
  });
});
