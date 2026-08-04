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
    assert.equal(descriptor?.defaultWire, 'anthropic-messages');
    assert.deepEqual(descriptor?.allowedWires, ['anthropic-messages']);
    assert.equal(descriptor?.authMethods.api_key.wire, 'anthropic-messages');
    assert.equal(descriptor?.defaults.baseUrl, 'https://api.deepseek.com/anthropic');
    assert.equal(descriptor?.defaults.model, 'deepseek-chat');
    assert.equal(descriptor?.capabilities?.reasoning?.paramStyle, 'anthropic-enabled-output-effort');
    assert.deepEqual(descriptor?.capabilities?.reasoning?.effortLevels, ['off', 'low', 'high', 'max']);
    assert.equal(descriptor?.capabilities?.reasoning?.defaultEffort, 'high');

    const resolved = resolveChannel({
      channelId: CHANNEL_IDS.DEEPSEEK,
      authMethod: 'api_key',
      apiKey: 'deepseek-test-key',
    });
    assert.equal(resolved.wire, 'anthropic-messages');
    assert.equal(resolved.baseUrl, 'https://api.deepseek.com/anthropic');
    assert.equal(resolved.endpoint, 'https://api.deepseek.com/anthropic/v1/messages');
    assert.equal(resolved.headers['x-api-key'], 'deepseek-test-key');
    assert.equal(resolved.headers['anthropic-version'], '2023-06-01');
    assert.equal(resolved.reasoningParamStyle, 'anthropic-enabled-output-effort');
    assert.deepEqual(resolved.reasoningEffortLevels, ['off', 'low', 'high', 'max']);
    assert.equal(resolved.reasoningDefaultEffort, 'high');
    assert.throws(
      () => resolveChannel({
        channelId: CHANNEL_IDS.DEEPSEEK,
        authMethod: 'api_key',
        wireOverride: 'openai-chat',
        apiKey: 'deepseek-test-key',
      }),
      /unsupported_wire:deepseek:openai-chat/,
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
    assert.equal(deepseek?.defaultWire, 'anthropic-messages');
    assert.equal(deepseek?.defaults.baseUrl, 'https://api.deepseek.com/anthropic');
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

  it('exposes GLM Coding Plan CN and Global templates with distinct endpoints', () => {
    const templates = listServiceTemplates();
    const cn = templates.find((item) => item.id === 'glm-coding-plan-cn');
    const global = templates.find((item) => item.id === 'glm-coding-plan-global');
    assert.ok(cn);
    assert.ok(global);
    assert.equal(cn?.accessCategory, 'third_party');
    assert.equal(global?.accessCategory, 'third_party');
    assert.equal(cn?.channelId, CHANNEL_IDS.GLM_CODING_PLAN_CN);
    assert.equal(global?.channelId, CHANNEL_IDS.GLM_CODING_PLAN_GLOBAL);
    assert.equal(cn?.defaults.baseUrl, 'https://open.bigmodel.cn/api/anthropic');
    assert.equal(global?.defaults.baseUrl, 'https://api.z.ai/api/anthropic');
    assert.equal(cn?.defaults.model, 'glm-4.7');
    assert.equal(global?.defaults.model, 'glm-4.7');
    assert.equal(
      resolveServiceTemplateId({ channelId: CHANNEL_IDS.GLM_CODING_PLAN_CN, authMethod: 'api_key' }),
      'glm-coding-plan-cn',
    );
    assert.equal(
      resolveServiceTemplateId({ channelId: CHANNEL_IDS.GLM_CODING_PLAN_GLOBAL, authMethod: 'api_key' }),
      'glm-coding-plan-global',
    );

    const resolvedCn = resolveChannel({
      channelId: CHANNEL_IDS.GLM_CODING_PLAN_CN,
      authMethod: 'api_key',
      model: 'glm-4.7',
    });
    assert.equal(resolvedCn.wire, 'anthropic-messages');
    assert.equal(resolvedCn.endpoint, 'https://open.bigmodel.cn/api/anthropic/v1/messages');

    const resolvedGlobal = resolveChannel({
      channelId: CHANNEL_IDS.GLM_CODING_PLAN_GLOBAL,
      authMethod: 'api_key',
      model: 'glm-5.2',
    });
    assert.equal(resolvedGlobal.wire, 'anthropic-messages');
    assert.equal(resolvedGlobal.endpoint, 'https://api.z.ai/api/anthropic/v1/messages');
  });

  it('exposes Kimi Coding Plan and Moonshot third-party templates', () => {
    const templates = listServiceTemplates();
    const kimi = templates.find((item) => item.id === 'kimi-coding-plan');
    const moonshot = templates.find((item) => item.id === 'moonshot-api');
    assert.ok(kimi);
    assert.ok(moonshot);
    assert.equal(kimi?.accessCategory, 'third_party');
    assert.equal(moonshot?.accessCategory, 'third_party');
    assert.equal(kimi?.channelId, CHANNEL_IDS.KIMI_CODING_PLAN);
    assert.equal(moonshot?.channelId, CHANNEL_IDS.MOONSHOT);
    assert.equal(kimi?.defaults.baseUrl, 'https://api.moonshot.cn/v1');
    assert.equal(moonshot?.defaults.baseUrl, 'https://api.moonshot.cn/v1');
    assert.equal(kimi?.defaults.model, 'kimi-k2.7-code');
    assert.equal(moonshot?.defaults.model, 'kimi-k3');
    assert.equal(
      resolveServiceTemplateId({ channelId: CHANNEL_IDS.KIMI_CODING_PLAN, authMethod: 'api_key' }),
      'kimi-coding-plan',
    );
    assert.equal(
      resolveServiceTemplateId({ channelId: CHANNEL_IDS.MOONSHOT, authMethod: 'api_key' }),
      'moonshot-api',
    );

    const resolvedKimi = resolveChannel({
      channelId: CHANNEL_IDS.KIMI_CODING_PLAN,
      authMethod: 'api_key',
      apiKey: 'kimi-key',
      model: 'kimi-k2.7-code',
    });
    assert.equal(resolvedKimi.wire, 'openai-chat');
    assert.equal(resolvedKimi.endpoint, 'https://api.moonshot.cn/v1/chat/completions');
    assert.equal(resolvedKimi.headers.Authorization, 'Bearer kimi-key');

    const resolvedMoonshot = resolveChannel({
      channelId: CHANNEL_IDS.MOONSHOT,
      authMethod: 'api_key',
      apiKey: 'moonshot-key',
      model: 'kimi-k3',
    });
    assert.equal(resolvedMoonshot.wire, 'openai-chat');
    assert.equal(resolvedMoonshot.endpoint, 'https://api.moonshot.cn/v1/chat/completions');
  });

  it('exposes MiniMax CN and Global coding templates with distinct endpoints', () => {
    const templates = listServiceTemplates();
    const cn = templates.find((item) => item.id === 'minimax-cn');
    const global = templates.find((item) => item.id === 'minimax-global');
    assert.ok(cn);
    assert.ok(global);
    assert.equal(cn?.accessCategory, 'third_party');
    assert.equal(global?.accessCategory, 'third_party');
    assert.equal(cn?.channelId, CHANNEL_IDS.MINIMAX_CN);
    assert.equal(global?.channelId, CHANNEL_IDS.MINIMAX_GLOBAL);
    assert.equal(cn?.defaults.baseUrl, 'https://api.minimaxi.com/anthropic');
    assert.equal(global?.defaults.baseUrl, 'https://api.minimax.io/anthropic');
    assert.equal(cn?.defaults.model, 'MiniMax-M3');
    assert.equal(global?.defaults.model, 'MiniMax-M3');
    assert.equal(
      resolveServiceTemplateId({ channelId: CHANNEL_IDS.MINIMAX_CN, authMethod: 'api_key' }),
      'minimax-cn',
    );
    assert.equal(
      resolveServiceTemplateId({ channelId: CHANNEL_IDS.MINIMAX_GLOBAL, authMethod: 'api_key' }),
      'minimax-global',
    );

    const resolvedCn = resolveChannel({
      channelId: CHANNEL_IDS.MINIMAX_CN,
      authMethod: 'api_key',
      model: 'MiniMax-M3',
    });
    assert.equal(resolvedCn.wire, 'anthropic-messages');
    assert.equal(resolvedCn.endpoint, 'https://api.minimaxi.com/anthropic/v1/messages');

    const resolvedGlobal = resolveChannel({
      channelId: CHANNEL_IDS.MINIMAX_GLOBAL,
      authMethod: 'api_key',
      model: 'MiniMax-M3',
    });
    assert.equal(resolvedGlobal.wire, 'anthropic-messages');
    assert.equal(resolvedGlobal.endpoint, 'https://api.minimax.io/anthropic/v1/messages');
  });

  it('exposes Volcengine Ark coding plan template', () => {
    const templates = listServiceTemplates();
    const ark = templates.find((item) => item.id === 'volcengine-ark');
    assert.ok(ark);
    assert.equal(ark?.accessCategory, 'third_party');
    assert.equal(ark?.channelId, CHANNEL_IDS.VOLCENGINE_ARK);
    assert.equal(ark?.defaults.baseUrl, 'https://ark.cn-beijing.volces.com/api/v3');
    assert.equal(ark?.defaults.model, 'doubao-seed-1-6');
    assert.equal(
      resolveServiceTemplateId({ channelId: CHANNEL_IDS.VOLCENGINE_ARK, authMethod: 'api_key' }),
      'volcengine-ark',
    );

    const resolved = resolveChannel({
      channelId: CHANNEL_IDS.VOLCENGINE_ARK,
      authMethod: 'api_key',
      apiKey: 'ark-key',
      model: 'doubao-seed-1-6',
    });
    assert.equal(resolved.wire, 'openai-chat');
    assert.equal(resolved.endpoint, 'https://ark.cn-beijing.volces.com/api/v3/chat/completions');
    assert.equal(resolved.headers.Authorization, 'Bearer ark-key');
  });

  it('exposes Xiaomi MiMo pay-as-you-go and Token Plan templates', () => {
    const templates = listServiceTemplates();
    const payg = templates.find((item) => item.id === 'xiaomi-mimo');
    const tokenPlan = templates.find((item) => item.id === 'xiaomi-mimo-token-plan');
    assert.ok(payg);
    assert.ok(tokenPlan);
    assert.equal(payg?.accessCategory, 'third_party');
    assert.equal(tokenPlan?.accessCategory, 'third_party');
    assert.equal(payg?.channelId, CHANNEL_IDS.XIAOMI_MIMO);
    assert.equal(tokenPlan?.channelId, CHANNEL_IDS.XIAOMI_MIMO_TOKEN_PLAN);
    assert.equal(payg?.defaults.baseUrl, 'https://api.xiaomimimo.com/v1');
    assert.equal(tokenPlan?.defaults.baseUrl, 'https://token-plan-cn.xiaomimimo.com/v1');
    assert.equal(payg?.defaults.model, 'mimo-v2.5-pro');
    assert.equal(tokenPlan?.defaults.model, 'mimo-v2.5-pro');
    assert.equal(
      resolveServiceTemplateId({ channelId: CHANNEL_IDS.XIAOMI_MIMO, authMethod: 'api_key' }),
      'xiaomi-mimo',
    );
    assert.equal(
      resolveServiceTemplateId({ channelId: CHANNEL_IDS.XIAOMI_MIMO_TOKEN_PLAN, authMethod: 'api_key' }),
      'xiaomi-mimo-token-plan',
    );

    const resolvedPayg = resolveChannel({
      channelId: CHANNEL_IDS.XIAOMI_MIMO,
      authMethod: 'api_key',
      apiKey: 'sk-demo',
      model: 'mimo-v2.5-pro',
    });
    assert.equal(resolvedPayg.wire, 'openai-chat');
    assert.equal(resolvedPayg.endpoint, 'https://api.xiaomimimo.com/v1/chat/completions');

    const resolvedToken = resolveChannel({
      channelId: CHANNEL_IDS.XIAOMI_MIMO_TOKEN_PLAN,
      authMethod: 'api_key',
      apiKey: 'tp-demo',
      model: 'mimo-v2.5-pro',
    });
    assert.equal(resolvedToken.wire, 'openai-chat');
    assert.equal(resolvedToken.endpoint, 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions');
  });

  it('exposes Aliyun Bailian Coding Plan template', () => {
    const templates = listServiceTemplates();
    const bailian = templates.find((item) => item.id === 'aliyun-bailian');
    assert.ok(bailian);
    assert.equal(bailian?.accessCategory, 'third_party');
    assert.equal(bailian?.channelId, CHANNEL_IDS.ALIYUN_BAILIAN);
    assert.equal(bailian?.defaults.baseUrl, 'https://coding.dashscope.aliyuncs.com/v1');
    assert.equal(bailian?.defaults.model, 'qwen3-coder-plus');
    assert.equal(
      resolveServiceTemplateId({ channelId: CHANNEL_IDS.ALIYUN_BAILIAN, authMethod: 'api_key' }),
      'aliyun-bailian',
    );

    const resolved = resolveChannel({
      channelId: CHANNEL_IDS.ALIYUN_BAILIAN,
      authMethod: 'api_key',
      apiKey: 'sk-sp-demo',
      model: 'qwen3-coder-plus',
    });
    assert.equal(resolved.wire, 'openai-chat');
    assert.equal(resolved.endpoint, 'https://coding.dashscope.aliyuncs.com/v1/chat/completions');
    assert.equal(resolved.headers.Authorization, 'Bearer sk-sp-demo');
  });

  it('exposes OpenCode Go OpenAI and Anthropic templates', () => {
    const templates = listServiceTemplates();
    const openai = templates.find((item) => item.id === 'opencode-go-openai');
    const anthropic = templates.find((item) => item.id === 'opencode-go-anthropic');
    assert.ok(openai);
    assert.ok(anthropic);
    assert.equal(openai?.accessCategory, 'third_party');
    assert.equal(anthropic?.accessCategory, 'third_party');
    assert.equal(openai?.channelId, CHANNEL_IDS.OPENCODE_GO_OPENAI);
    assert.equal(anthropic?.channelId, CHANNEL_IDS.OPENCODE_GO_ANTHROPIC);
    assert.equal(openai?.defaults.baseUrl, 'https://opencode.ai/zen/v1');
    assert.equal(anthropic?.defaults.baseUrl, 'https://opencode.ai/zen');
    assert.equal(openai?.defaults.model, 'gpt-5.5');
    assert.equal(anthropic?.defaults.model, 'claude-sonnet-4-5');

    const resolvedOpenAi = resolveChannel({
      channelId: CHANNEL_IDS.OPENCODE_GO_OPENAI,
      authMethod: 'api_key',
      apiKey: 'zen-key',
      model: 'gpt-5.5',
    });
    assert.equal(resolvedOpenAi.wire, 'openai-responses');
    assert.equal(resolvedOpenAi.endpoint, 'https://opencode.ai/zen/v1/responses');
    assert.equal(resolvedOpenAi.headers.Authorization, 'Bearer zen-key');

    const resolvedAnthropic = resolveChannel({
      channelId: CHANNEL_IDS.OPENCODE_GO_ANTHROPIC,
      authMethod: 'api_key',
      model: 'claude-sonnet-4-5',
    });
    assert.equal(resolvedAnthropic.wire, 'anthropic-messages');
    assert.equal(resolvedAnthropic.endpoint, 'https://opencode.ai/zen/v1/messages');
  });
});
