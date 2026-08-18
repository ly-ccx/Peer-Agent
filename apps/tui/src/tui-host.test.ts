import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { RuntimeSdkEvent } from '@peer-agent/runtime-sdk';

import {
  createTuiHost,
  type CreateTuiHostOptions,
  type PendingApproval,
  type TuiExecutionContext,
  type TuiHost,
} from './tui-host.ts';

const workspaces: string[] = [];
const liveHosts: TuiHost[] = [];

function createHost(options: string | CreateTuiHostOptions): TuiHost {
  const host = createTuiHost(options);
  liveHosts.push(host);
  return host;
}

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-tui-'));
  workspaces.push(workspaceRoot);
  return workspaceRoot;
}

function sessionContext(sessionId: string, turnIndex = 0): TuiExecutionContext {
  return {
    sessionId,
    conversationId: sessionId,
    streamId: `${sessionId}:stream:${turnIndex}`,
    turnId: `${sessionId}:turn:${turnIndex}`,
    turnIndex,
    signal: new AbortController().signal,
  };
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms.`);
}

afterEach(async () => {
  await Promise.all(liveHosts.splice(0).map((host) => host.dispose()));
  await Promise.all(workspaces.splice(0).map((workspaceRoot) => rm(workspaceRoot, { recursive: true, force: true })));
});

describe('TUI Runtime host', () => {
  test('uses the desktop ask level by default and updates the runtime permission truth', async () => {
    const workspaceRoot = await createWorkspace();
    const host = createHost(workspaceRoot);

    expect(host.getAccessLevel()).toBe('ask_before_local');
    expect(host.setAccessLevel('full_local')).toBe('full_local');
    expect(host.getAccessLevel()).toBe('full_local');
    expect(host.setAccessLevel('invalid')).toBe('ask_before_local');
  });

  test('projects read-only tools for plan and explorer while retaining write tools for chat and goal', async () => {
    const workspaceRoot = await createWorkspace();
    const userDataPath = await createWorkspace();
    const skillDir = path.join(userDataPath, 'skills', 'host-test-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: Host Test Skill',
      'description: Tests Skill projection in TUI host',
      '---',
      '',
      '# Host Test Skill',
    ].join('\n'));
    await writeFile(path.join(userDataPath, 'mcp-registry.json'), JSON.stringify({
      version: 1,
      servers: [{
        id: 'host-test-mcp',
        displayName: 'Host Test MCP',
        enabled: true,
        transport: 'streamable_http',
        url: 'https://example.invalid/mcp',
        policy: { trusted: true, visibleByDefault: true, requirePermission: false },
        health: { status: 'ready' },
        tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
      }],
    }));
    const host = createHost({ workspaceRoot, userDataPath });
    const capabilities = (
      mode: 'chat' | 'plan' | 'goal' | 'explorer' | 'compact' | 'system',
    ) => host.capabilitiesForMode?.(mode) ?? [];
    const toolNames = (
      mode: 'chat' | 'plan' | 'goal' | 'explorer' | 'compact' | 'system',
    ) => (host.toolDefinitionsForMode?.(mode) ?? []).map((tool) => tool.capabilityId);

    // Agent is represented by the legacy chat wire mode and must receive the
    // same Goal planning tools as Desktop Agent mode.
    expect(capabilities('chat')).toEqual(expect.arrayContaining([
      'local.file.read',
      'local.file.list',
      'local.file.write',
      'local.shell.exec',
      'local.shell.stop',
      'local.goal.create_plan',
      'local.goal.update_task',
      'local.goal.get_plan',
      'local.goal.explore',
    ]));
    // Goal mode keeps chat write/shell tools and adds shared Desktop goal tools.
    expect(capabilities('goal')).toEqual(expect.arrayContaining([
      'local.file.read',
      'local.file.list',
      'local.file.write',
      'local.shell.exec',
      'local.shell.stop',
      'local.goal.create_plan',
      'local.goal.update_task',
      'local.goal.get_plan',
    ]));
    // Plan mode stays read-only for local files, but projects goal plan tools.
    expect(capabilities('plan')).toEqual(expect.arrayContaining([
      'local.file.read',
      'local.file.list',
      'local.goal.create_plan',
      'local.goal.update_task',
      'local.goal.get_plan',
    ]));
    expect(capabilities('explorer')).toEqual(expect.arrayContaining([
      'local.file.read',
      'local.file.list',
    ]));
    expect(capabilities('chat').some((id) => id.startsWith('local.skill.'))).toBe(true);
    expect(capabilities('chat').some((id) => id.startsWith('local.mcp.'))).toBe(true);

    // Model-visible tool definitions must use the same projected set. Returning
    // the unfiltered provider catalog would re-expose write/shell in plan mode.
    expect([...toolNames('chat')]).toEqual([...capabilities('chat')]);
    expect([...toolNames('plan')]).toEqual([...capabilities('plan')]);
    expect([...toolNames('goal')]).toEqual([...capabilities('goal')]);
    expect([...toolNames('explorer')]).toEqual([...capabilities('explorer')]);
    expect([...toolNames('compact')]).toEqual([...capabilities('compact')]);
    expect([...toolNames('system')]).toEqual([...capabilities('system')]);
    expect(toolNames('plan')).not.toContain('local.file.write');
    expect(toolNames('plan')).not.toContain('local.shell.exec');
    expect(toolNames('plan')).not.toContain('local.shell.stop');
    expect(toolNames('plan')).not.toContain('local.goal.explore');
    expect(toolNames('explorer')).not.toContain('local.shell.stop');
    expect(toolNames('chat')).toContain('local.goal.create_plan');
    expect(toolNames('chat')).toContain('local.goal.update_task');
    expect(toolNames('chat')).toContain('local.goal.get_plan');
    expect(toolNames('chat')).toContain('local.goal.explore');
    expect(toolNames('goal')).toContain('local.goal.create_plan');
    expect(toolNames('goal')).toContain('local.goal.explore');
    expect(toolNames('goal')).toContain('local.shell.exec');
    expect(toolNames('goal')).toContain('local.shell.stop');
    expect(toolNames('compact')).toEqual([]);
    expect(toolNames('system')).toEqual([]);
  });

  test('rejects non-projected write and shell capabilities before approval in plan and explorer', async () => {
    const workspaceRoot = await createWorkspace();
    const host = createHost(workspaceRoot);
    let approvalCount = 0;
    const unsubscribe = host.subscribeApproval((approval) => {
      if (approval) approvalCount += 1;
    });

    const planWrite = await host.execute(
      'local.file.write',
      { path: 'blocked-plan.txt', content: 'blocked' },
      { ...sessionContext('plan-session'), mode: 'plan' },
    );
    const explorerShell = await host.executeShell(
      'touch blocked-explorer.txt',
      { ...sessionContext('explorer-session'), mode: 'explorer' },
    );
    unsubscribe();

    expect(planWrite.result.status).toBe('denied');
    expect((planWrite.result.error as { code?: string } | undefined)?.code).toBe('capability_not_projected');
    expect(explorerShell.result.status).toBe('denied');
    expect((explorerShell.result.error as { code?: string } | undefined)?.code).toBe('capability_not_projected');
    expect(approvalCount).toBe(0);
    expect(await Bun.file(path.join(workspaceRoot, 'blocked-plan.txt')).exists()).toBe(false);
    expect(await Bun.file(path.join(workspaceRoot, 'blocked-explorer.txt')).exists()).toBe(false);
  });

  test('runs a real file capability through the governed Runtime and publishes events', async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(path.join(workspaceRoot, 'note.txt'), 'hello from Bun', 'utf8');
    const host = createHost(workspaceRoot);
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

  test('uses the caller session context for Runtime events and Provider execution', async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(path.join(workspaceRoot, 'session.txt'), 'session scoped', 'utf8');
    const host = createHost(workspaceRoot);
    const events: RuntimeSdkEvent[] = [];
    const unsubscribe = host.subscribe((event) => events.push(event));
    const signal = new AbortController().signal;

    const execution = await host.executeRead('session.txt', {
      sessionId: 'host-session',
      conversationId: 'host-conversation',
      streamId: 'host-stream',
      turnId: 'host-session:turn:3',
      turnIndex: 3,
      signal,
    });
    unsubscribe();

    expect(execution.result.status).toBe('completed');
    expect((execution.result.output as { content?: string }).content).toBe('session scoped');
    const toolEvents = events.filter((event) =>
      event.type === 'tool.started' || event.type === 'tool.completed',
    );
    expect(toolEvents.length).toBeGreaterThanOrEqual(2);
    expect(toolEvents.every((event) => event.sessionId === 'host-session')).toBe(true);
    expect(toolEvents.every((event) => event.streamId === undefined)).toBe(true);
  });

  test('runs a read-only shell capability without approval', async () => {
    const workspaceRoot = await createWorkspace();
    const host = createHost(workspaceRoot);
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

  test('stops a chat background shell from goal through the shared task manager', async () => {
    const workspaceRoot = await createWorkspace();
    const userDataPath = await createWorkspace();
    const host = createHost({ workspaceRoot, userDataPath, accessLevel: 'full_local' });
    const conversationId = 'cross-mode-shell';
    const chatContext: TuiExecutionContext = {
      ...sessionContext(conversationId, 0),
      mode: 'chat',
    };
    const goalContext: TuiExecutionContext = {
      ...sessionContext(conversationId, 1),
      mode: 'goal',
    };
    let taskId: string | undefined;
    let stopped = false;

    try {
      const started = await host.execute('local.shell.exec', {
        command: `node -e "process.stdout.write('tui-shell-ready\\n'); setInterval(() => {}, 1000)"`,
        background: true,
        timeoutMs: 10_000,
      }, chatContext);
      expect(started.result.status).toBe('completed');
      const startedOutput = started.result.output as {
        taskId?: string;
        status?: string;
        startedAt?: string;
        artifactRef?: string;
        artifactRefs?: readonly string[];
        localPath?: string;
      };
      taskId = startedOutput.taskId;
      expect(taskId).toMatch(/^shell_[0-9a-f-]{36}$/i);
      expect(startedOutput.status).toBe('running');
      expect(startedOutput.artifactRef).toBe(`local-shell-artifact://${taskId}`);
      expect(startedOutput.artifactRefs).toEqual([
        `local-shell-artifact://${taskId}/stdout`,
        `local-shell-artifact://${taskId}/stderr`,
        `local-shell-artifact://${taskId}/metadata`,
      ]);
      expect(startedOutput.localPath).toBeUndefined();

      const artifactDir = path.join(
        userDataPath,
        'shell-artifacts',
        startedOutput.startedAt!.slice(0, 10),
        taskId!,
      );
      const stdoutPath = path.join(artifactDir, 'stdout.txt');
      await waitFor(async () => (await readFile(stdoutPath, 'utf8')).includes('tui-shell-ready'));

      const stoppedExecution = await host.execute('local.shell.stop', {
        taskId,
        reason: 'cross_mode_test',
      }, goalContext);
      expect(stoppedExecution.result.status).toBe('completed');
      const stoppedOutput = stoppedExecution.result.output as {
        taskId?: string;
        stopped?: boolean;
        status?: string;
        reason?: string;
        artifactRef?: string;
        artifactRefs?: readonly string[];
      };
      stopped = stoppedOutput.stopped === true;
      expect(stoppedOutput).toMatchObject({
        taskId,
        stopped: true,
        status: 'cancelled',
        reason: 'cross_mode_test',
        artifactRef: startedOutput.artifactRef,
      });
      expect(stoppedOutput.artifactRefs).toEqual(startedOutput.artifactRefs);
      expect(await readFile(stdoutPath, 'utf8')).toContain('tui-shell-ready');

      const metadata = JSON.parse(await readFile(path.join(artifactDir, 'metadata.json'), 'utf8')) as {
        taskId?: string;
        status?: string;
        stopReason?: string;
        completedAt?: string;
      };
      expect(metadata).toMatchObject({
        taskId,
        status: 'cancelled',
        stopReason: 'cross_mode_test',
      });
      expect(metadata.completedAt).toBeTruthy();
    } finally {
      if (taskId && !stopped) {
        await host.execute('local.shell.stop', {
          taskId,
          reason: 'test_cleanup',
        }, goalContext);
      }
    }
  });

  test('surfaces shell approval and records an allow decision', async () => {
    const workspaceRoot = await createWorkspace();
    const host = createHost(workspaceRoot);
    let approvalObserved = false;
    const unsubscribe = host.subscribeApproval((approval: PendingApproval | null) => {
      if (approval) {
        approvalObserved = true;
        approval.resolve('allow-once');
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

  test('matches desktop approve-for-me behavior for workspace writes and low-risk shell', async () => {
    const workspaceRoot = await createWorkspace();
    const host = createHost({ workspaceRoot, accessLevel: 'session_local' });
    const approvals: PendingApproval[] = [];
    const unsubscribe = host.subscribeApproval((approval) => {
      if (approval) approvals.push(approval);
    });

    const fileExecution = await host.execute(
      'local.file.write',
      { path: 'session-file.txt', content: 'approved by desktop policy' },
      sessionContext('session-local-file'),
    );
    const shellExecution = await host.executeShell(
      'touch session-shell.txt',
      sessionContext('session-local-shell'),
    );
    unsubscribe();

    expect(fileExecution.result.status).toBe('completed');
    expect(shellExecution.result.status).toBe('completed');
    expect(approvals).toHaveLength(0);
    expect(await Bun.file(path.join(workspaceRoot, 'session-file.txt')).text()).toBe('approved by desktop policy');
    expect(await Bun.file(path.join(workspaceRoot, 'session-shell.txt')).exists()).toBe(true);
  });

  test('matches desktop full-access behavior without bypassing irreversible hard gates', async () => {
    const workspaceRoot = await createWorkspace();
    const host = createHost({ workspaceRoot, accessLevel: 'full_local' });
    const approvals: PendingApproval[] = [];
    const unsubscribe = host.subscribeApproval((approval) => {
      if (approval) approvals.push(approval);
    });

    const fileExecution = await host.execute(
      'local.file.write',
      { path: 'full-file.txt', content: 'full access' },
      sessionContext('full-local-file'),
    );
    const shellExecution = await host.executeShell(
      'touch full-shell.txt',
      sessionContext('full-local-shell'),
    );
    const deniedExecution = await host.executeShell(
      'rm -rf full-file.txt',
      sessionContext('full-local-denied'),
    );
    unsubscribe();

    expect(fileExecution.result.status).toBe('completed');
    expect(shellExecution.result.status).toBe('completed');
    expect(deniedExecution.result.status).toBe('denied');
    expect(approvals).toHaveLength(0);
    expect(await Bun.file(path.join(workspaceRoot, 'full-file.txt')).exists()).toBe(true);
    expect(await Bun.file(path.join(workspaceRoot, 'full-shell.txt')).exists()).toBe(true);
  });

  test('denies a requested shell capability without executing it', async () => {
    const workspaceRoot = await createWorkspace();
    const host = createHost(workspaceRoot);
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
    const host = createHost(workspaceRoot);

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
    const host = createHost(workspaceRoot);

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
    const host = createHost(workspaceRoot);
    let promptSource: string | undefined;
    const unsubscribe = host.subscribeApproval((approval) => {
      if (approval) {
        promptSource = approval.prompt.confirmation.kind;
        approval.resolve('allow-once');
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

  test('allow once asks again for the next matching call', async () => {
    const workspaceRoot = await createWorkspace();
    const host = createHost(workspaceRoot);
    const context = sessionContext('once-session');
    let approvalCount = 0;
    const unsubscribe = host.subscribeApproval((approval) => {
      if (!approval) return;
      approvalCount += 1;
      expect(approval.sessionId).toBe('once-session');
      approval.resolve('allow-once');
    });

    const first = await host.executeShell('touch once-1.txt', context);
    const second = await host.executeShell('touch once-2.txt', {
      ...context,
      turnId: 'once-session:turn:1',
      turnIndex: 1,
    });
    unsubscribe();

    expect(first.result.status).toBe('completed');
    expect(second.result.status).toBe('completed');
    expect(approvalCount).toBe(2);
  });

  test('allow for session reuses a capability grant only in the matching session', async () => {
    const workspaceRoot = await createWorkspace();
    const host = createHost(workspaceRoot);
    let approvalCount = 0;
    const unsubscribe = host.subscribeApproval((approval) => {
      if (!approval) return;
      approvalCount += 1;
      approval.resolve(approvalCount === 1 ? 'allow-session' : 'deny');
    });

    const first = await host.executeShell('touch session-1.txt', sessionContext('session-a'));
    const second = await host.executeShell(
      'touch session-2.txt',
      sessionContext('session-a', 1),
    );
    const isolated = await host.executeShell(
      'touch session-b.txt',
      sessionContext('session-b'),
    );
    unsubscribe();

    expect(first.result.status).toBe('completed');
    expect(second.result.status).toBe('completed');
    expect(isolated.result.status).toBe('denied');
    expect(approvalCount).toBe(2);
    expect(await Bun.file(path.join(workspaceRoot, 'session-b.txt')).exists()).toBe(false);
  });

  test('clears session grants when the approval UI unmounts', async () => {
    const workspaceRoot = await createWorkspace();
    const host = createHost(workspaceRoot);
    const context = sessionContext('remount-session');
    const unsubscribeFirst = host.subscribeApproval((approval) => {
      approval?.resolve('allow-session');
    });

    const first = await host.executeShell('touch remount-first.txt', context);
    unsubscribeFirst();

    let promptedAfterRemount = false;
    const unsubscribeSecond = host.subscribeApproval((approval) => {
      if (!approval) return;
      promptedAfterRemount = true;
      approval.resolve('deny');
    });
    const second = await host.executeShell(
      'touch remount-second.txt',
      sessionContext('remount-session', 1),
    );
    unsubscribeSecond();

    expect(first.result.status).toBe('completed');
    expect(second.result.status).toBe('denied');
    expect(promptedAfterRemount).toBe(true);
  });

  test('session allow is isolated by capability within one session', async () => {
    const workspaceRoot = await createWorkspace();
    const host = createHost(workspaceRoot);
    let approvalCount = 0;
    const unsubscribe = host.subscribeApproval((approval) => {
      if (!approval) return;
      approvalCount += 1;
      approval.resolve(approvalCount === 1 ? 'allow-session' : 'deny');
    });
    const context = sessionContext('capability-session');

    const shell = await host.executeShell('touch shell-allowed.txt', context);
    const fileWrite = await host.execute(
      'local.file.write',
      { path: 'file-denied.txt', content: 'must not write' },
      {
        ...context,
        turnId: 'capability-session:turn:1',
        turnIndex: 1,
      },
    );
    unsubscribe();

    expect(shell.result.status).toBe('completed');
    expect(fileWrite.result.status).toBe('denied');
    expect(approvalCount).toBe(2);
    expect(await Bun.file(path.join(workspaceRoot, 'file-denied.txt')).exists()).toBe(false);
  });

  test('fails closed when no approval UI is subscribed', async () => {
    const workspaceRoot = await createWorkspace();
    const host = createHost(workspaceRoot);

    const execution = await host.executeShell(
      'touch unavailable.txt',
      sessionContext('unavailable-session'),
    );

    expect(execution.result.status).toBe('denied');
    expect(await Bun.file(path.join(workspaceRoot, 'unavailable.txt')).exists()).toBe(false);
  });

  test('denies active and queued approvals when the UI unsubscribes', async () => {
    const workspaceRoot = await createWorkspace();
    const host = createHost(workspaceRoot);
    let firstApproval!: PendingApproval;
    let notify!: () => void;
    const shown = new Promise<void>((resolve) => { notify = resolve; });
    const unsubscribe = host.subscribeApproval((approval) => {
      if (!approval || firstApproval) return;
      firstApproval = approval;
      notify();
    });

    const executionA = host.executeShell('touch unmount-a.txt', sessionContext('unmount-a'));
    const executionB = host.executeShell('touch unmount-b.txt', sessionContext('unmount-b'));
    await shown;
    unsubscribe();

    const [resultA, resultB] = await Promise.all([executionA, executionB]);
    expect(resultA.result.status).toBe('denied');
    expect(resultB.result.status).toBe('denied');
    expect(await Bun.file(path.join(workspaceRoot, 'unmount-a.txt')).exists()).toBe(false);
    expect(await Bun.file(path.join(workspaceRoot, 'unmount-b.txt')).exists()).toBe(false);
  });

  test('queues concurrent approvals instead of replacing the active card', async () => {
    const workspaceRoot = await createWorkspace();
    const host = createHost(workspaceRoot);
    const approvals: PendingApproval[] = [];
    let notify!: () => void;
    let nextApproval = new Promise<void>((resolve) => { notify = resolve; });
    const unsubscribe = host.subscribeApproval((approval) => {
      if (!approval) return;
      approvals.push(approval);
      notify();
    });

    const executionA = host.executeShell('touch queue-a.txt', sessionContext('queue-a'));
    const executionB = host.executeShell('touch queue-b.txt', sessionContext('queue-b'));
    await nextApproval;
    expect(approvals.map(({ sessionId }) => sessionId)).toEqual(['queue-a']);

    nextApproval = new Promise<void>((resolve) => { notify = resolve; });
    approvals[0]?.resolve('allow-once');
    await nextApproval;
    expect(approvals.map(({ sessionId }) => sessionId)).toEqual(['queue-a', 'queue-b']);
    approvals[1]?.resolve('allow-once');

    const [resultA, resultB] = await Promise.all([executionA, executionB]);
    unsubscribe();
    expect(resultA.result.status).toBe('completed');
    expect(resultB.result.status).toBe('completed');
  });

  test('keeps concurrent session approval contexts isolated', async () => {
    const workspaceRoot = await createWorkspace();
    const host = createHost(workspaceRoot);
    const observedSessions: string[] = [];
    const unsubscribe = host.subscribeApproval((approval) => {
      if (!approval) return;
      observedSessions.push(approval.sessionId ?? 'missing');
      approval.resolve('allow-session');
    });

    const [sessionA, sessionB] = await Promise.all([
      host.executeShell('touch concurrent-a.txt', sessionContext('concurrent-a')),
      host.executeShell('touch concurrent-b.txt', sessionContext('concurrent-b')),
    ]);
    unsubscribe();

    expect(sessionA.result.status).toBe('completed');
    expect(sessionB.result.status).toBe('completed');
    expect(observedSessions.sort()).toEqual(['concurrent-a', 'concurrent-b']);
  });

  test('session allow cannot loosen an explicit destructive deny', async () => {
    const workspaceRoot = await createWorkspace();
    const host = createHost(workspaceRoot);
    let approvalCount = 0;
    const unsubscribe = host.subscribeApproval((approval) => {
      if (!approval) return;
      approvalCount += 1;
      approval.resolve('allow-session');
    });
    const context = sessionContext('deny-session');

    const allowed = await host.executeShell('touch before-deny.txt', context);
    const denied = await host.executeShell('rm -rf .', {
      ...context,
      turnId: 'deny-session:turn:1',
      turnIndex: 1,
    });
    unsubscribe();

    expect(allowed.result.status).toBe('completed');
    expect(denied.result.status).toBe('denied');
    expect(
      (denied.result.permissionGrant as { decision?: string } | undefined)?.decision,
    ).toBe('deny');
    expect(approvalCount).toBe(1);
  });

  test('session allow cannot loosen a later explicit Hook deny', async () => {
    const workspaceRoot = await createWorkspace();
    let hookCalls = 0;
    const host = createHost({
      workspaceRoot,
      hookRunner: {
        runPreToolUse() {
          hookCalls += 1;
          return hookCalls === 1
            ? [{ hookId: 'ask-first', decision: 'ask', reason: 'approve first call' }]
            : [{ hookId: 'deny-second', decision: 'deny', reason: 'block second call' }];
        },
      },
    });
    let approvalCount = 0;
    const unsubscribe = host.subscribeApproval((approval) => {
      if (!approval) return;
      approvalCount += 1;
      approval.resolve('allow-session');
    });

    const first = await host.executeShell('touch hook-first.txt', sessionContext('hook-deny'));
    const second = await host.executeShell(
      'touch hook-second.txt',
      sessionContext('hook-deny', 1),
    );
    unsubscribe();

    expect(first.result.status).toBe('completed');
    expect(second.result.status).toBe('denied');
    expect(approvalCount).toBe(1);
    expect(
      (second.result.evidence as { hookFinalDecision?: string }).hookFinalDecision,
    ).toBe('deny');
    expect(await Bun.file(path.join(workspaceRoot, 'hook-second.txt')).exists()).toBe(false);
  });

  test('one session grant unifies Hook ask and capability ask for a matching call', async () => {
    const workspaceRoot = await createWorkspace();
    await mkdir(path.join(workspaceRoot, '.peer'), { recursive: true });
    await Bun.write(
      path.join(workspaceRoot, '.peer', 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              match: { capabilityId: 'local.shell.exec' },
              command: `node -e "process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ decision: 'ask', reason: 'confirm hook and capability' })))"`,
            },
          ],
        },
      }),
    );
    const host = createHost(workspaceRoot);
    let approvalCount = 0;
    let promptSource: string | undefined;
    const unsubscribe = host.subscribeApproval((approval) => {
      if (!approval) return;
      approvalCount += 1;
      promptSource = approval.prompt.confirmation.kind;
      approval.resolve('allow-session');
    });

    const execution = await host.executeShell(
      'touch unified.txt',
      sessionContext('unified-session'),
    );
    unsubscribe();

    expect(execution.result.status).toBe('completed');
    expect(promptSource).toBe('hook-approval');
    expect(approvalCount).toBe(1);
    expect(await Bun.file(path.join(workspaceRoot, 'unified.txt')).exists()).toBe(true);
  });

  test('registers real Tool Results in Goal EvidenceIndex without trusting invented refs', async () => {
    const workspaceRoot = await createWorkspace();
    const userDataPath = path.join(workspaceRoot, '.peer-agent-test');
    await writeFile(path.join(workspaceRoot, 'evidence.txt'), 'governed evidence', 'utf8');
    const host = createHost({ workspaceRoot, userDataPath });
    const conversationId = 'evidence-index-session';
    const context = (turnIndex: number): TuiExecutionContext => ({
      ...sessionContext(conversationId, turnIndex),
      mode: 'goal',
    });

    const created = await host.execute('local.goal.create', {
      title: 'Evidence registration',
      goal: 'Complete a task only with a real Tool Result',
      tasks: [{ taskId: 'evidence-task', title: 'Read the governed file' }],
    }, context(0));
    const planId = (created.result.output as { planId?: string }).planId;
    expect(planId).toBeTruthy();

    const invented = await host.execute('local.goal.update', {
      planId,
      taskId: 'evidence-task',
      status: 'completed',
      evidenceRefs: ['tool-result://invented'],
      result: 'must be rejected',
    }, context(1));
    expect(invented.result.status).toBe('failed');

    const read = await host.execute('local.file.read', {
      path: 'evidence.txt',
    }, context(2));
    expect(read.result.status).toBe('completed');
    const evidenceRef = `tool-result://${read.result.toolCallId}`;

    const updated = await host.execute('local.goal.update', {
      planId,
      taskId: 'evidence-task',
      status: 'completed',
      evidenceRefs: [evidenceRef],
      result: 'read completed',
    }, context(3));
    expect(updated.result.status).toBe('success');

    const loaded = await host.execute('local.goal.read', { planId }, context(4));
    const plan = (loaded.result.output as { plan?: any }).plan;
    expect(plan?.tasks?.[0]).toMatchObject({
      taskId: 'evidence-task',
      status: 'completed',
      evidenceRefs: [evidenceRef],
      result: 'read completed',
    });
    expect(plan?.progress).toMatchObject({ total: 1, completed: 1, percent: 100 });
  });

  test('keeps foreground shell cwd across calls and reads numbered line ranges', async () => {
    const workspaceRoot = await createWorkspace();
    await mkdir(path.join(workspaceRoot, 'nested'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'note.txt'), 'one\ntwo\nthree\nfour\n', 'utf8');
    const host = createHost({ workspaceRoot, accessLevel: 'full_local' });
    const context = sessionContext('persist-session');

    const moved = await host.executeShell('cd nested && export PEER_MARK=kept', context);
    expect(moved.result.status).toBe('completed');
    const persisted = await host.execute(
      'local.shell.exec',
      { command: 'printf "%s %s" "$PEER_MARK" "$(basename "$(pwd)")"' },
      context,
    );
    expect(persisted.result.status).toBe('completed');
    expect((persisted.result.output as { stdout?: string }).stdout).toBe('kept nested');

    const ranged = await host.execute(
      'local.file.read',
      { path: 'note.txt', start_line: 2, end_line: 3 },
      context,
    );
    expect(ranged.result.status).toBe('completed');
    expect((ranged.result.output as { content?: string }).content).toBe('2\ttwo\n3\tthree');
    expect((ranged.result.output as { total_lines?: number }).total_lines).toBe(4);
  });
});
