import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { RuntimeSdkEvent } from '@peer-agent/runtime-sdk';

import { createTuiHost, type PendingApproval } from './tui-host.ts';

const workspaces: string[] = [];

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-tui-'));
  workspaces.push(workspaceRoot);
  return workspaceRoot;
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspaceRoot) => rm(workspaceRoot, { recursive: true, force: true })));
});

describe('TUI Runtime host', () => {
  test('runs a real file capability through the governed Runtime and publishes events', async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(path.join(workspaceRoot, 'note.txt'), 'hello from Bun', 'utf8');
    const host = createTuiHost(workspaceRoot);
    const events: RuntimeSdkEvent[] = [];
    const unsubscribe = host.subscribe((event) => events.push(event));

    const execution = await host.executeRead('note.txt');
    unsubscribe();

    expect(execution.result.status).toBe('completed');
    expect((execution.result.output as { content?: string }).content).toBe('hello from Bun');
    expect(execution.result.evidence).toBeTruthy();
    expect(events.some((event) => event.type === 'tool.started')).toBe(true);
    expect(events.some((event) => event.type === 'tool.completed')).toBe(true);
  });

  test('runs a read-only shell capability without approval', async () => {
    const workspaceRoot = await createWorkspace();
    const host = createTuiHost(workspaceRoot);
    const approvals: PendingApproval[] = [];
    const unsubscribe = host.subscribeApproval((approval) => {
      if (approval) approvals.push(approval);
    });

    const execution = await host.executeShell('printf bun-compatible');
    unsubscribe();

    expect(execution.result.status).toBe('completed');
    expect((execution.result.output as { stdout?: string }).stdout).toBe('bun-compatible');
    expect(approvals).toHaveLength(0);
  });

  test('surfaces shell approval and records an allow decision', async () => {
    const workspaceRoot = await createWorkspace();
    const host = createTuiHost(workspaceRoot);
    let approvalObserved = false;
    const unsubscribe = host.subscribeApproval((approval: PendingApproval | null) => {
      if (approval) {
        approvalObserved = true;
        approval.resolve('allow');
      }
    });

    const execution = await host.executeShell('touch approved.txt');
    unsubscribe();

    expect(approvalObserved).toBe(true);
    expect(execution.result.status).toBe('completed');
    expect(
      (execution.result.permissionGrant as { decision?: string } | undefined)?.decision,
    ).toBe('allow');
    expect(await Bun.file(path.join(workspaceRoot, 'approved.txt')).exists()).toBe(true);
  });

  test('denies a requested shell capability without executing it', async () => {
    const workspaceRoot = await createWorkspace();
    const host = createTuiHost(workspaceRoot);
    const unsubscribe = host.subscribeApproval((approval) => approval?.resolve('deny'));

    const execution = await host.executeShell('touch denied.txt');
    unsubscribe();

    expect(execution.result.status).toBe('denied');
    expect(
      (execution.result.permissionGrant as { decision?: string } | undefined)?.decision,
    ).toBe('deny');
    expect(await Bun.file(path.join(workspaceRoot, 'denied.txt')).exists()).toBe(false);
  });
});
