import { describe, expect, test } from 'bun:test';

import { encodeExecJson, isAuthFailureReason } from './cli-output.ts';

describe('encodeExecJson', () => {
  test('emits the P0 fields and stays jq-parseable', () => {
    const json = encodeExecJson({
      sessionId: 'conv-1',
      ok: true,
      result: 'done',
      error: null,
      turns: 2,
      durationMs: 15,
    });
    const parsed = JSON.parse(json) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(json).toContain('"sessionId":"conv-1"');
    expect(json).not.toContain('evidence');
  });
});

describe('isAuthFailureReason', () => {
  test('detects credential and model-config failures', () => {
    expect(isAuthFailureReason('Desktop credential is locked')).toBe(true);
    expect(isAuthFailureReason('missing model configuration')).toBe(true);
    expect(isAuthFailureReason('provider_stream_error')).toBe(false);
  });
});
