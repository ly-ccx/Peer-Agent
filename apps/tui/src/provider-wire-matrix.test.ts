import { describe, expect, test } from 'bun:test';
const { CHANNEL_IDS, getChannelDescriptor, resolveOpenCodeGoWire } = await import(
  new URL('../../desktop/electron/main/provider-channels.mjs', import.meta.url).href,
) as {CHANNEL_IDS:Record<string,string>; getChannelDescriptor(id:string):{defaultWire:string}; resolveOpenCodeGoWire(model:string):string};

import {
  assertTuiWireSupported,
  formatTuiWireMatrix,
  resolveTuiWire,
  TUI_SUPPORTED_WIRES,
} from './provider-wire-matrix.ts';

describe('resolveTuiWire', () => {
  test('every desktop API-key channel uses its declared protocol, including model-dependent Go', () => {
    for (const channelId of Object.values(CHANNEL_IDS)) {
      const descriptor = getChannelDescriptor(channelId);
      for (const model of ['glm-5.3-flash', 'claude-sonnet-4', 'gpt-5.6-luna']) {
        const expected = channelId.startsWith('opencode-go') ? resolveOpenCodeGoWire(model) : descriptor.defaultWire;
        expect(resolveTuiWire({channelId,model,authMethod:'api_key'})).toMatchObject({kind:'supported',wire:expected});
      }
    }
    expect(resolveTuiWire({channelId:'opencode-go',model:'glm-5.3-flash',wireOverride:'gemini'}).kind).toBe('unsupported');
    expect(resolveTuiWire({channelId:'openai',wireOverride:'openai-responses'})).toMatchObject({kind:'supported',wire:'openai-responses'});
  });
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
