import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

import { parsePeerArgv, formatPeerHelp } from './cli-argv.ts';
import { CLI_EXIT } from './cli-exit.ts';
import { completionScript } from './cli-completions.ts';
import { formatDoctorReport, inspectPeerDoctor } from './cli-doctor.ts';
import { formatSessionMarkdown, redactExportedText, runPeerExport } from './cli-export.ts';
import { formatModelLines, selectableModelRows } from './cli-model-lines.ts';
import { formatSessionList, runPeerSessions, type CliSessionStore } from './cli-sessions.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('basic shell argv', () => {
  test('parses the six shell commands', () => {
    expect(parsePeerArgv(['sessions'])).toEqual({ kind: 'sessions', sessions: { action: 'list' } });
    expect(parsePeerArgv(['sessions', 'resume', 'abc'])).toEqual({
      kind: 'sessions', sessions: { action: 'resume', id: 'abc' },
    });
    expect(parsePeerArgv(['sessions', 'delete', '--yes', 'abc'])).toEqual({
      kind: 'sessions', sessions: { action: 'delete', id: 'abc', yes: true },
    });
    expect(parsePeerArgv(['models'])).toEqual({ kind: 'models' });
    expect(parsePeerArgv(['doctor'])).toEqual({ kind: 'doctor' });
    expect(parsePeerArgv(['completions', 'zsh'])).toEqual({ kind: 'completions', shell: 'zsh' });
    expect(parsePeerArgv(['export', 'abc', '--output', 'out.md', '--force'])).toEqual({
      kind: 'export', sessionId: 'abc', outputPath: 'out.md', force: true,
    });
  });

  test('rejects unsafe session delete and unknown shells', () => {
    expect(parsePeerArgv(['sessions', 'delete'])).toMatchObject({ kind: 'error', exitCode: CLI_EXIT.usage });
    expect(parsePeerArgv(['completions', 'powershell'])).toMatchObject({ kind: 'error' });
    expect(parsePeerArgv(['export'])).toMatchObject({ kind: 'error' });
    expect(formatPeerHelp('root')).toContain('peer sessions');
    expect(formatPeerHelp('sessions')).toContain('--yes');
  });
});

describe('models, completions, and doctor', () => {
  test('prints selectable models without dropping the provider', () => {
    const lines = formatModelLines(selectableModelRows([
      { providerId: 'a', modelId: 'same', displayName: 'A', available: true },
      { providerId: 'b', modelId: 'same', displayName: 'B', available: false },
    ]));
    expect(lines).toBe('a\tsame\tA');
    expect(lines).not.toContain('secret');
  });

  test('completion scripts name the shell commands and stay on stdout shape', () => {
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const script = completionScript(shell);
      expect(script).toContain('sessions');
      expect(script).toContain('doctor');
      expect(script).not.toContain('login');
    }
  });

  test('doctor fails when the credential helper is missing and does not require a tty', () => {
    const root = mkdtempSync(join(tmpdir(), 'peer-doctor-'));
    roots.push(root);
    const peer = join(root, 'peer');
    writeFileSync(peer, '');
    const report = inspectPeerDoctor({
      env: { PEER_AGENT_HOME: join(root, 'data') },
      execPath: peer,
      stdinIsTTY: false,
      version: '0.1.0-rc.36',
    });
    expect(formatDoctorReport(report)).toContain('terminal: not a tty');
    expect(report.checks.find((check) => check.name === 'credential helper')?.ok).toBe(false);
    expect(report.checks.find((check) => check.name === 'data root')?.ok).toBe(true);
  });
});

describe('sessions and export', () => {
  function store(): CliSessionStore & { deleted: string[] } {
    const deleted: string[] = [];
    const records = [{ id: 's1', title: 'Hello\nthere', updatedAt: '2026-11-06T00:00:00.000Z' }];
    return {
      deleted,
      listConversations: () => records,
      readSessionMeta: (id) => records.find((record) => record.id === id) ?? null,
      getConversation: (id) => records.find((record) => record.id === id) ?? null,
      deleteConversation: (id) => { deleted.push(id); },
    };
  }

  test('lists id, time, and title without message text', async () => {
    const lines: string[] = [];
    const code = await runPeerSessions({ action: 'list' }, {
      store: store(),
      stdout: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(formatSessionList([{ id: 's1', title: 'Hello\nthere', updatedAt: '2026-11-06T00:00:00.000Z' }]))
      .toBe('2026-11-06T00:00:00.000Z\ts1\tHello there');
    expect(lines.join('\n')).not.toContain('tool');
  });

  test('delete asks on a tty, requires --yes otherwise, and cascades plans', async () => {
    const plans: string[] = [];
    const denied = store();
    expect(await runPeerSessions({ action: 'delete', id: 's1', yes: false }, {
      store: denied, stdinIsTTY: false, plans: { deletePlanByConversation: () => {} },
    })).toBe(CLI_EXIT.usage);
    expect(denied.deleted).toEqual([]);

    const removed = store();
    const lines: string[] = [];
    expect(await runPeerSessions({ action: 'delete', id: 's1', yes: true }, {
      store: removed,
      plans: { deletePlanByConversation: (id) => { plans.push(id); } },
      stdout: (line) => lines.push(line),
    })).toBe(0);
    expect(removed.deleted).toEqual(['s1']);
    expect(plans).toEqual(['s1']);
    expect(lines.join('\n')).toContain('Deleted session s1');

    expect(await runPeerSessions({ action: 'delete', id: 'missing', yes: true }, {
      store: removed, plans: { deletePlanByConversation: () => { throw new Error('should not run'); } },
    })).toBe(CLI_EXIT.runtime);
  });

  test('export keeps visible text, redacts secrets, and refuses to overwrite', async () => {
    expect(redactExportedText('token sk-abcdefghi and Bearer abc.def')).toContain('[redacted]');
    const markdown = formatSessionMarkdown({
      id: 's1',
      title: 'Notes',
      messages: [
        { role: 'user', content: 'hello sk-abcdefghi' },
        { role: 'tool', content: 'secret tool output' },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      ],
    });
    expect(markdown).toContain('## user');
    expect(markdown).toContain('[redacted]');
    expect(markdown).not.toContain('secret tool output');

    const root = mkdtempSync(join(tmpdir(), 'peer-export-'));
    roots.push(root);
    const output = join(root, 'out.md');
    writeFileSync(output, 'keep');
    const stderr: string[] = [];
    const code = await runPeerExport({ sessionId: 's1', outputPath: output, force: false }, {
      readSession: () => ({ id: 's1', title: 'Notes', messages: [{ role: 'user', content: 'hello' }] }),
      stderr: (line) => stderr.push(line),
    });
    expect(code).toBe(CLI_EXIT.usage);
    expect(readFileSync(output, 'utf8')).toBe('keep');
    expect(stderr.join('\n')).toContain('--force');
  });
});
