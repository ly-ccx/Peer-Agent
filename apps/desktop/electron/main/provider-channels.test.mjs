import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHANNEL_IDS,
  listChannelDescriptors,
  resolveChannel,
  validateCustomHeaders,
  listServiceTemplates,
  resolveServiceTemplateId,
} from './provider-channels.mjs';

describe('provider channel registry', () => {
  it('uses the official Grok display name', () => {
    const grok = listChannelDescriptors().find((channel) => channel.id === 'grok');
    assert.equal(grok?.label, 'Grok 官方');
  });

  it('registers and resolves DeepSeek as an independent official channel', () => {
    assert.equal(CHANNEL_IDS.DEEPSEEK, 'deepseek');
    const descriptor = listChannelDescriptors().find((channel) => channel.id === CHANNEL_IDS.DEEPSEEK);

    assert.equal(descriptor?.label, 'DeepSeek 官方');
    assert.equal(descriptor?.defaultWire, 'openai-chat');
    assert.deepEqual(descriptor?.allowedWires, ['openai-chat']);
    assert.equal(descriptor?.authMethods.api_key.wire, 'openai-chat');
    assert.equal(descriptor?.defaults.baseUrl, 'https://api.deepseek.com');
    assert.equal(descriptor?.defaults.model, 'deepseek-chat');

    const resolved = resolveChannel({
      channelId: CHANNEL_IDS.DEEPSEEK,
      authMethod: 'api_key',
      apiKey: 'deepseek-test-key',
    });
    assert.equal(resolved.wire, 'openai-chat');
    assert.equal(resolved.baseUrl, 'https://api.deepseek.com');
    assert.equal(resolved.endpoint, 'https://api.deepseek.com/chat/completions');
    assert.equal(resolved.headers.Authorization, 'Bearer deepseek-test-key');
    assert.throws(
      () => resolveChannel({
        channelId: CHANNEL_IDS.DEEPSEEK,
        authMethod: 'api_key',
        wireOverride: 'openai-responses',
        apiKey: 'deepseek-test-key',
      }),
      /unsupported_wire:deepseek:openai-responses/,
    );
  });

  it('resolves ChatGPT OAuth through OpenAI official responses wire only', () => {
    const resolved = resolveChannel({
      channelId: 'openai',
      authMethod: 'oauth_chatgpt',
      apiKey: 'access-token',
      accountId: 'acct_1',
    });

    assert.equal(resolved.wire, 'openai-responses');
    assert.equal(resolved.endpoint, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(resolved.headers.Authorization, 'Bearer access-token');
    assert.equal(resolved.headers['chatgpt-account-id'], 'acct_1');
  });

  it('resolves Grok subscription through the Grok Build Responses API', () => {
    const resolved = resolveChannel({
      channelId: 'grok',
      authMethod: 'oauth_grok',
      apiKey: 'grok-access-token',
      model: 'grok-4.5',
    });

    assert.equal(resolved.wire, 'openai-responses');
    assert.equal(resolved.endpoint, 'https://cli-chat-proxy.grok.com/v1/responses');
    assert.equal(resolved.headers.Authorization, 'Bearer grok-access-token');
    assert.equal(resolved.headers['X-XAI-Token-Auth'], 'xai-grok-cli');
    assert.equal(resolved.headers['x-grok-client-surface'], 'grok-build');
    assert.equal(resolved.supportsReasoning, true);
    assert.deepEqual(resolved.reasoningEffortLevels, ['low', 'medium', 'high']);
    assert.equal(resolved.reasoningDefaultEffort, 'high');
    assert.equal(resolved.reasoningParamStyle, 'openai-effort');
    // default/off 必须投影到 high，避免编码层落到 OpenAI 通用 medium。
    assert.equal(resolved.reasoningEffortMap?.default, 'high');
    assert.equal(resolved.reasoningEffortMap?.off, 'high');
    assert.equal(resolved.reasoningEffortMap?.medium, 'medium');
  });

  it('rejects OAuth wire override to chat completions', () => {
    assert.throws(
      () => resolveChannel({
        channelId: 'openai',
        authMethod: 'oauth_chatgpt',
        wireOverride: 'openai-chat',
        apiKey: 'access-token',
      }),
      /unsupported_wire:openai:openai-chat/,
    );
  });

  it('allows OpenAI-compatible users to explicitly choose responses wire', () => {
    const resolved = resolveChannel({
      channelId: 'openai-compatible',
      authMethod: 'api_key',
      wireOverride: 'openai-responses',
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'sk-test',
    });

    assert.equal(resolved.wire, 'openai-responses');
    assert.equal(resolved.endpoint, 'https://gateway.example/v1/responses');
  });

  it('rejects custom headers that override auth or protocol-required headers', () => {
    assert.throws(
      () => validateCustomHeaders({ Authorization: 'Bearer other' }),
      /custom_header_protected:authorization/,
    );
    assert.throws(
      () => validateCustomHeaders({ 'Content-Type': 'text/plain' }),
      /custom_header_protected:content-type/,
    );
  });

  it('uses descriptor data, not host sniffing, for Anthropic adaptive reasoning', () => {
    const resolved = resolveChannel({
      channelId: 'anthropic-compatible',
      baseUrl: 'https://idealab.alibaba-inc.com/api/anthropic',
      apiKey: 'key',
      supportsReasoning: true,
      reasoningParamStyle: 'anthropic-adaptive-effort',
    });

    assert.equal(resolved.wire, 'anthropic-messages');
    assert.equal(resolved.reasoningParamStyle, 'anthropic-adaptive-effort');
    assert.equal(resolved.endpoint, 'https://idealab.alibaba-inc.com/api/anthropic/v1/messages');
  });

  it('carries provider-specific reasoning effort maps through resolution', () => {
    const reasoningEffortMap = {
      minimal: 'high',
      low: 'high',
      medium: 'high',
      high: 'high',
      xhigh: 'max',
    };
    const resolved = resolveChannel({
      channelId: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'key',
      supportsReasoning: true,
      reasoningParamStyle: 'openai-effort',
      reasoningEffortMap,
    });

    assert.equal(resolved.reasoningParamStyle, 'openai-effort');
    assert.deepEqual(resolved.reasoningEffortMap, reasoningEffortMap);
  });

  it('resolves Gemini endpoints with API key query auth', () => {
    const resolved = resolveChannel({
      channelId: 'google-ai',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.0-flash',
      apiKey: 'gemini-key',
    });

    assert.equal(resolved.wire, 'gemini');
    assert.equal(
      resolved.endpoint,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=gemini-key',
    );
    assert.equal(
      resolved.testEndpoint,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=gemini-key',
    );
    assert.deepEqual(resolved.headers, { 'Content-Type': 'application/json' });
  });

  it('resolves Gemini subscription with Code Assist OAuth endpoint', () => {
    const resolved = resolveChannel({
      channelId: 'google-ai',
      authMethod: 'oauth_google',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.0-flash',
      apiKey: 'oauth-access-token',
      oauthProjectId: 'peer-project',
    });

    assert.equal(resolved.wire, 'gemini');
    assert.equal(resolved.baseUrl, 'https://cloudcode-pa.googleapis.com');
    assert.equal(
      resolved.endpoint,
      'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
    );
    assert.equal(
      resolved.testEndpoint,
      'https://cloudcode-pa.googleapis.com/v1internal:generateContent',
    );
    assert.equal(resolved.oauthProjectId, 'peer-project');
    assert.equal(resolved.headers.Authorization, 'Bearer oauth-access-token');
    assert.equal(resolved.headers['x-goog-user-project'], undefined);
  });

  it('resolves Qoder through the private API wire without static headers or API key', () => {
    const resolved = resolveChannel({
      channelId: 'qoder',
      authMethod: 'qoder_local_auth',
      model: 'auto',
    });

    assert.equal(resolved.wire, 'qoder-private');
    assert.equal(resolved.endpoint, 'https://api2-v2.qoder.sh/model/v1/chat/completions');
    assert.deepEqual(resolved.headers, {});
    assert.equal(resolved.supportsReasoning, false);
    assert.equal(resolved.descriptor.capabilities.toolUse, false);
  });
});

describe('service templates', () => {
  it('returns P0 catalog with distinct access methods', () => {
    const templates = listServiceTemplates();
    assert.ok(templates.length >= 9);
    assert.ok(templates.some((item) => item.id === 'openai-api'));
    assert.ok(templates.some((item) => item.id === 'openai-chatgpt'));
    assert.ok(templates.some((item) => item.id === 'openai-compatible'));
    const deepseek = templates.find((item) => item.id === 'deepseek-api');
    assert.equal(deepseek?.brand, 'DeepSeek');
    assert.equal(deepseek?.title, 'DeepSeek');
    assert.equal(deepseek?.accessCategory, 'official_api');
    assert.equal(deepseek?.channelId, CHANNEL_IDS.DEEPSEEK);
    assert.equal(deepseek?.authMethod, 'api_key');
    assert.equal(deepseek?.defaults.baseUrl, 'https://api.deepseek.com');
    assert.equal(deepseek?.defaults.model, 'deepseek-chat');
    assert.equal(
      resolveServiceTemplateId({ channelId: CHANNEL_IDS.DEEPSEEK, authMethod: 'api_key' }),
      'deepseek-api',
    );
    assert.equal(
      resolveServiceTemplateId({ channelId: 'openai', authMethod: 'oauth_chatgpt' }),
      'openai-chatgpt',
    );
    assert.equal(
      resolveServiceTemplateId({ channelId: 'openai', authMethod: 'api_key' }),
      'openai-api',
    );
  });
});
