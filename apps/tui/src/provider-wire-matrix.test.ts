import { describe, expect, test } from 'bun:test';

import {
  assertTuiWireSupported,
  formatTuiWireMatrix,
  resolveTuiWire,
  TUI_SUPPORTED_WIRES,
} from './provider-wire-matrix.ts';

describe('resolveTuiWire', () => {
  test('maps OAuth auth methods to correct wires', () => {
    expect(resolveTuiWire({ authMethod: 'oauth_chatgpt' })).toMatchObject({
      kind: 'supported',
      wire: 'openai-responses',
    });
    expect(resolveTuiWire({ authMethod: 'oauth_grok' })).toMatchObject({
      kind: 'supported',
      wire: 'openai-responses',
    });
    expect(resolveTuiWire({ authMethod: 'oauth_google' })).toMatchObject({
      kind: 'supported',
      wire: 'gemini',
    });
    expect(resolveTuiWire({ authMethod: 'qoder_local_auth' })).toMatchObject({
      kind: 'supported',
      wire: 'qoder-private',
    });
  });

  test('maps Anthropic channels to messages wire, not openai-chat', () => {
    expect(resolveTuiWire({ channelId: 'anthropic', authMethod: 'api_key' })).toMatchObject({
      kind: 'supported',
      wire: 'anthropic-messages',
    });
    expect(resolveTuiWire({ channelId: 'anthropic-compatible', authMethod: 'api_key' })).toMatchObject({
      kind: 'supported',
      wire: 'anthropic-messages',
    });
  });

  test('maps Google AI / Gemini to gemini wire (not openai-compatible)', () => {
    expect(resolveTuiWire({ channelId: 'google-ai', authMethod: 'api_key' })).toMatchObject({
      kind: 'supported',
      wire: 'gemini',
    });
    expect(resolveTuiWire({ authMethod: 'oauth_google', channelId: 'google-ai' })).toMatchObject({
      kind: 'supported',
      wire: 'gemini',
    });
  });

  test('maps Qoder to private wire', () => {
    expect(resolveTuiWire({ channelId: 'qoder', authMethod: 'api_key' })).toMatchObject({
      kind: 'supported',
      wire: 'qoder-private',
    });
  });

  test('keeps true OpenAI-compatible channels on chat completions', () => {
    expect(resolveTuiWire({ channelId: 'openai-compatible', authMethod: 'api_key' })).toMatchObject({
      kind: 'supported',
      wire: 'openai-chat',
    });
    expect(resolveTuiWire({ channelId: 'openai', authMethod: 'api_key' })).toMatchObject({
      kind: 'supported',
      wire: 'openai-chat',
    });
  });

  test('fails closed for unknown channel instead of fake-compatible', () => {
    const decision = resolveTuiWire({ channelId: 'some-future-channel', authMethod: 'api_key' });
    expect(decision.kind).toBe('unsupported');
    if (decision.kind === 'unsupported') {
      expect(decision.code).toContain('unsupported_channel');
      expect(decision.reason).toContain('some-future-channel');
    }
    expect(() => assertTuiWireSupported({ channelId: 'some-future-channel' })).toThrow(/no wire mapping/i);
  });

  test('documents supported wire set and matrix text', () => {
    expect(TUI_SUPPORTED_WIRES).toContain('gemini');
    expect(TUI_SUPPORTED_WIRES).toContain('anthropic-messages');
    expect(formatTuiWireMatrix()).toContain('oauth_google');
    expect(formatTuiWireMatrix()).toContain('unsupported');
  });
});
