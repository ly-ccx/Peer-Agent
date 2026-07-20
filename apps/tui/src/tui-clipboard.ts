import { spawn } from 'node:child_process';
import { platform } from 'node:os';

export type ClipboardWriteMethod = 'pbcopy' | 'xclip' | 'xsel' | 'osc52' | 'none';

export interface ClipboardWriteResult {
  readonly ok: boolean;
  readonly method: ClipboardWriteMethod;
  readonly error?: string;
}

export interface ClipboardWriterOptions {
  /** Optional OpenTUI OSC52 writer (terminal-native clipboard). */
  readonly writeOsc52?: (text: string) => boolean;
  /** Force a platform for tests. */
  readonly platformName?: NodeJS.Platform;
  /** Injectable process spawner for tests. */
  readonly spawnCommand?: (
    command: string,
    args: readonly string[],
    input: string,
  ) => Promise<boolean>;
}

function defaultSpawn(command: string, args: readonly string[], input: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, [...args], {
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      child.on('error', () => finish(false));
      child.on('close', (code) => finish(code === 0));
      child.stdin?.on('error', () => finish(false));
      child.stdin?.end(input, 'utf8');
    } catch {
      resolve(false);
    }
  });
}

/**
 * Copy plain text to the system clipboard.
 * Prefers native tools (pbcopy/xclip/xsel), then falls back to OSC52 when available.
 */
export async function copyTextToClipboard(
  text: string,
  options: ClipboardWriterOptions = {},
): Promise<ClipboardWriteResult> {
  const value = text ?? '';
  if (value.length === 0) {
    return { ok: false, method: 'none', error: 'empty selection' };
  }

  const spawnCommand = options.spawnCommand ?? defaultSpawn;
  const osName = options.platformName ?? platform();

  if (osName === 'darwin') {
    if (await spawnCommand('pbcopy', [], value)) {
      return { ok: true, method: 'pbcopy' };
    }
  } else if (osName === 'linux' || osName === 'freebsd' || osName === 'openbsd') {
    if (await spawnCommand('xclip', ['-selection', 'clipboard'], value)) {
      return { ok: true, method: 'xclip' };
    }
    if (await spawnCommand('xsel', ['--clipboard', '--input'], value)) {
      return { ok: true, method: 'xsel' };
    }
  }

  if (options.writeOsc52?.(value)) {
    return { ok: true, method: 'osc52' };
  }

  return {
    ok: false,
    method: 'none',
    error: 'no clipboard backend available',
  };
}

export function selectionCopyNotice(result: ClipboardWriteResult, charCount: number): string {
  if (result.ok) {
    return `Copied ${charCount} character${charCount === 1 ? '' : 's'}`;
  }
  return result.error ? `Copy failed: ${result.error}` : 'Copy failed';
}
