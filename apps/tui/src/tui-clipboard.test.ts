import { describe, expect, test } from 'bun:test';

import { copyTextToClipboard, selectionCopyNotice } from './tui-clipboard.ts';

describe('tui clipboard', () => {
  test('rejects empty selection', async () => {
    const result = await copyTextToClipboard('', {
      platformName: 'darwin',
      spawnCommand: async () => true,
    });
    expect(result.ok).toBe(false);
    expect(result.method).toBe('none');
  });

  test('uses pbcopy on macOS', async () => {
    const calls: Array<{ command: string; args: readonly string[]; input: string }> = [];
    const result = await copyTextToClipboard('hello', {
      platformName: 'darwin',
      spawnCommand: async (command, args, input) => {
        calls.push({ command, args, input });
        return true;
      },
    });
    expect(result).toEqual({ ok: true, method: 'pbcopy' });
    expect(calls).toEqual([{ command: 'pbcopy', args: [], input: 'hello' }]);
  });

  test('falls back to xsel after xclip fails on linux', async () => {
    const commands: string[] = [];
    const result = await copyTextToClipboard('payload', {
      platformName: 'linux',
      spawnCommand: async (command) => {
        commands.push(command);
        return command === 'xsel';
      },
    });
    expect(result).toEqual({ ok: true, method: 'xsel' });
    expect(commands).toEqual(['xclip', 'xsel']);
  });

  test('falls back to OSC52 when native tools fail', async () => {
    let osc = '';
    const result = await copyTextToClipboard('via-osc', {
      platformName: 'darwin',
      spawnCommand: async () => false,
      writeOsc52: (text) => {
        osc = text;
        return true;
      },
    });
    expect(result).toEqual({ ok: true, method: 'osc52' });
    expect(osc).toBe('via-osc');
  });

  test('formats success and failure notices', () => {
    expect(selectionCopyNotice({ ok: true, method: 'pbcopy' }, 1)).toBe('Copied 1 character');
    expect(selectionCopyNotice({ ok: true, method: 'pbcopy' }, 12)).toBe('Copied 12 characters');
    expect(selectionCopyNotice({ ok: false, method: 'none', error: 'empty selection' }, 0))
      .toBe('Copy failed: empty selection');
  });
});
