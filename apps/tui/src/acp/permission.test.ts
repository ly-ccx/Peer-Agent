import { expect, test } from 'bun:test';
import type { RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { requestAcpApproval } from './permission.ts';

for (const sessions of [1, 2]) {
  for (const optionId of ['allow-once', 'deny', 'unknown']) {
    test(`permission ${optionId} / ${sessions} isolated sessions`, async () => {
      const responses = await Promise.all(Array.from({ length: sessions }, () => requestAcpApproval(async () => ({ outcome: { outcome: 'selected', optionId } }), new AbortController().signal)));
      expect(responses).toEqual(Array(sessions).fill(optionId === 'allow-once' ? 'allow-once' : 'deny'));
    });
  }
}
for (const firstDecision of ['allow-once', 'deny', 'unknown', 'cancel']) {
  for (const secondDecision of ['allow-once', 'deny', 'unknown']) {
    test(`mixed concurrent approvals / ${firstDecision} x ${secondDecision}`, async () => {
      const firstAbort = new AbortController();
      const replies: ((response: RequestPermissionResponse) => void)[] = [];
      const first = requestAcpApproval(() => new Promise((resolve) => replies.push(resolve)), firstAbort.signal);
      const second = requestAcpApproval(() => new Promise((resolve) => replies.push(resolve)), new AbortController().signal);
      await Promise.resolve();
      // Reverse response order; cancellation and late approval affect only the first request.
      replies[1]!({ outcome: { outcome: 'selected', optionId: secondDecision } });
      if (firstDecision === 'cancel') firstAbort.abort();
      replies[0]!({ outcome: { outcome: 'selected', optionId: firstDecision === 'cancel' ? 'allow-once' : firstDecision } });
      expect(await first).toBe(firstDecision === 'allow-once' ? 'allow-once' : 'deny');
      expect(await second).toBe(secondDecision === 'allow-once' ? 'allow-once' : 'deny');
    });
  }
}

for (const interruption of ['cancel', 'disconnect', 'timeout', 'error', 'client-cancelled']) {
  test(`pending approval fails closed / ${interruption}`, async () => {
    const abort = new AbortController();
    let reply!: (value: RequestPermissionResponse) => void;
    const pending = requestAcpApproval(() => {
      if (interruption === 'error') throw new Error('client error');
      if (interruption === 'client-cancelled') return Promise.resolve({ outcome: { outcome: 'cancelled' } });
      return new Promise((resolve) => { reply = resolve; });
    }, abort.signal, 5);
    await Promise.resolve();
    if (interruption === 'cancel' || interruption === 'disconnect') abort.abort();
    expect(await pending).toBe('deny');
    reply?.({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect(await pending).toBe('deny');
  });
}
