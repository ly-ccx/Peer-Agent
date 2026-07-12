import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

  test('loads workspace hooks through the shared Node Hook Host and records evidence', async () => {
    const workspaceRoot = await createWorkspace();
    await mkdir(path.join(workspaceRoot, '.peer'), { recursive: true });
    await Bun.write(
      path.join(workspaceRoot, '.peer', 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              match: { capabilityId: 'local.file.read' },
              command: `node -e "process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ decision: 'deny', reason: 'blocked by shared hook' })))"`,
            },
          ],
        },
      }),
    );
    const host = createTuiHost(workspaceRoot);

    const execution = await host.executeRead('missing.txt');

    expect(execution.result.status).toBe('denied');
    const evidence = execution.result.evidence as {
      hooks?: Array<{ decision?: string; reason?: string }>;
      hookFinalDecision?: string;
    };
    expect(evidence.hookFinalDecision).toBe('deny');
    expect(evidence.hooks?.[0]?.decision).toBe('deny');
    expect(evidence.hooks?.[0]?.reason).toBe('blocked by shared hook');
  });

  test('runs PostToolUse after capability execution and appends audit evidence', async () => {
    const workspaceRoot = await createWorkspace();
    await mkdir(path.join(workspaceRoot, '.peer'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'post.txt'), 'post hook input', 'utf8');
    const command = [
      'let input="";',
      'process.stdin.on("data", chunk => input += chunk);',
      'process.stdin.on("end", () => {',
      '  const payload = JSON.parse(input);',
      '  const reason = payload.result?.status === "completed" ? "observed completed result" : "missing result";',
      '  console.log(JSON.stringify({ decision: "allow", reason }));',
      '});',
    ].join(' ');
    await Bun.write(
      path.join(workspaceRoot, '.peer', 'hooks.json'),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              match: { capabilityId: 'local.file.read' },
              command: `node -e ${JSON.stringify(command)}`,
            },
          ],
        },
      }),
    );
    const host = createTuiHost(workspaceRoot);

    const execution = await host.executeRead('post.txt');

    expect(execution.result.status).toBe('completed');
    const evidence = execution.result.evidence as {
      hooks?: Array<{ event?: string; decision?: string; reason?: string }>;
      hookFinalDecision?: string;
    };
    expect(evidence.hookFinalDecision).toBe('allow');
    expect(evidence.hooks?.[0]?.event).toBe('PostToolUse');
    expect(evidence.hooks?.[0]?.decision).toBe('allow');
    expect(evidence.hooks?.[0]?.reason).toBe('observed completed result');
  });

  test('routes a hook ask decision through the TUI approval port', async () => {
    const workspaceRoot = await createWorkspace();
    await mkdir(path.join(workspaceRoot, '.peer'), { recursive: true });
    await Bun.write(
      path.join(workspaceRoot, '.peer', 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              match: { capabilityId: 'local.file.read' },
              command: `node -e "process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ decision: 'ask', reason: 'confirm shared hook' })))"`,
            },
          ],
        },
      }),
    );
    await writeFile(path.join(workspaceRoot, 'approved.txt'), 'approved by hook prompt', 'utf8');
    const host = createTuiHost(workspaceRoot);
    let promptSource: string | undefined;
    const unsubscribe = host.subscribeApproval((approval) => {
      if (approval) {
        promptSource = approval.prompt.confirmation.kind;
        approval.resolve('allow');
      }
    });

    const execution = await host.executeRead('approved.txt');
    unsubscribe();

    expect(promptSource).toBe('hook-approval');
    expect(execution.result.status).toBe('completed');
    expect((execution.result.output as { content?: string }).content).toBe('approved by hook prompt');
    expect(
      (execution.result.evidence as { hookFinalDecision?: string }).hookFinalDecision,
    ).toBe('ask');
  });
});
