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
    assert.deepEqual(resolved.reasoningEffortLevels, ['low', 'medium', 'high', 'xhigh']);
    assert.equal(resolved.reasoningDefaultEffort, 'high');
    assert.equal(resolved.reasoningParamStyle, 'openai-effort');
    // default/off 必须投影到 high，避免编码层落到 OpenAI 通用 medium。
    // xhigh 对 grok-4.6+ 直通；grok-4.5 由官方把 xhigh 当 high。
    assert.equal(resolved.reasoningEffortMap?.default, 'high');
    assert.equal(resolved.reasoningEffortMap?.off, 'high');
    assert.equal(resolved.reasoningEffortMap?.medium, 'medium');
    assert.equal(resolved.reasoningEffortMap?.xhigh, 'xhigh');
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
    assert.equal(kimi?.defaults.baseUrl, 'https://api.kimi.com/coding/v1');
    assert.equal(moonshot?.defaults.baseUrl, 'https://api.moonshot.cn/v1');
    assert.equal(kimi?.defaults.model, 'k3');
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
      model: 'k3',
    });
    assert.equal(resolvedKimi.wire, 'openai-chat');
    assert.equal(resolvedKimi.endpoint, 'https://api.kimi.com/coding/v1/chat/completions');
    assert.equal(resolvedKimi.headers.Authorization, 'Bearer kimi-key');

    const resolvedMoonshot = resolveChannel({
      channelId: CHANNEL_IDS.MOONSHOT,
      authMethod: 'api_key',
      apiKey: 'moonshot-key',
      model: 'kimi-k3',
    });
    assert.equal(resolvedMoonshot.wire, 'openai-chat');
    assert.equal(resolvedMoonshot.endpoint, 'https://api.moonshot.cn/v1/chat/completions');

    // K3 官方多档：off/low/default/max，default 映射 high，max 映射 max。
    for (const resolved of [resolvedKimi, resolvedMoonshot]) {
      assert.equal(resolved.reasoningParamStyle, 'openai-effort');
      assert.deepEqual(resolved.reasoningEffortLevels, ['off', 'low', 'default', 'max']);
      assert.equal(resolved.reasoningDefaultEffort, 'default');
      assert.equal(resolved.reasoningEffortMap?.off, 'none');
      assert.equal(resolved.reasoningEffortMap?.low, 'low');
      assert.equal(resolved.reasoningEffortMap?.default, 'high');
      assert.equal(resolved.reasoningEffortMap?.max, 'max');
    }
  });

  it('registers OpenRouter as a third-party OpenAI Chat channel', () => {
    assert.equal(CHANNEL_IDS.OPENROUTER, 'openrouter');
    const descriptor = listChannelDescriptors().find((channel) => channel.id === CHANNEL_IDS.OPENROUTER);
    assert.ok(descriptor);
    assert.equal(descriptor?.label, 'OpenRouter');
    assert.equal(descriptor?.defaultWire, 'openai-chat');
    assert.deepEqual(descriptor?.allowedWires, ['openai-chat']);
    assert.equal(descriptor?.defaults.baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(descriptor?.defaults.model, 'openai/gpt-4o');

    const templates = listServiceTemplates();
    const template = templates.find((item) => item.id === 'openrouter-api');
    assert.ok(template);
    assert.equal(template?.accessCategory, 'third_party');
    assert.equal(template?.channelId, CHANNEL_IDS.OPENROUTER);
    assert.equal(template?.defaults.baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(resolveServiceTemplateId({
      channelId: CHANNEL_IDS.OPENROUTER,
      authMethod: 'api_key',
    }), 'openrouter-api');

    const resolved = resolveChannel({
      channelId: CHANNEL_IDS.OPENROUTER,
      authMethod: 'api_key',
      apiKey: 'or-key',
    });
    assert.equal(resolved.wire, 'openai-chat');
    assert.equal(resolved.baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(resolved.endpoint, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(resolved.headers.Authorization, `Bearer ${'or-key'}`);
    assert.equal(resolved.headers['HTTP-Referer'], 'https://github.com/ly-ccx/Peer-Agent');
    assert.equal(resolved.headers['X-Title'], 'Peer Agent');
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

  it('exposes a single OpenCode Go subscription template with model-based wire routing', () => {
    const templates = listServiceTemplates();
    const go = templates.find((item) => item.id === 'opencode-go');
    assert.ok(go);
    assert.equal(templates.filter((item) => String(item.id).startsWith('opencode-go')).length, 1);
    assert.equal(go?.accessCategory, 'third_party');
    assert.equal(go?.channelId, CHANNEL_IDS.OPENCODE_GO);
    assert.equal(go?.defaults.baseUrl, 'https://opencode.ai/zen/go/v1');
    assert.equal(go?.defaults.model, 'gpt-5.6-luna');

    const resolvedDefault = resolveChannel({
      channelId: CHANNEL_IDS.OPENCODE_GO,
      authMethod: 'api_key',
      apiKey: 'go-key',
      model: 'gpt-5.6-luna',
    });
    assert.equal(resolvedDefault.channelId, CHANNEL_IDS.OPENCODE_GO);
    assert.equal(resolvedDefault.wire, 'openai-responses');
    assert.equal(resolvedDefault.endpoint, 'https://opencode.ai/zen/go/v1/responses');
    assert.equal(resolvedDefault.headers.Authorization, 'Bearer go-key');
    assert.equal(resolvedDefault.capabilities.reasoning.paramStyle, 'openai-effort');

    const resolvedClaude = resolveChannel({
      channelId: CHANNEL_IDS.OPENCODE_GO,
      authMethod: 'api_key',
      apiKey: 'go-key',
      model: 'claude-sonnet-4-5',
    });
    assert.equal(resolvedClaude.wire, 'anthropic-messages');
    assert.equal(resolvedClaude.endpoint, 'https://opencode.ai/zen/go/v1/messages');
    assert.equal(resolvedClaude.legacyProvider, 'anthropic');
    assert.equal(resolvedClaude.capabilities.reasoning.paramStyle, 'anthropic-enabled-budget');

    // Official docs: glm / kimi / deepseek / grok use chat/completions, not responses.
    const resolvedGlm = resolveChannel({
      channelId: CHANNEL_IDS.OPENCODE_GO,
      authMethod: 'api_key',
      apiKey: 'go-key',
      model: 'glm-5.2',
    });
    assert.equal(resolvedGlm.wire, 'openai-chat');
    assert.equal(resolvedGlm.endpoint, 'https://opencode.ai/zen/go/v1/chat/completions');
    assert.equal(resolvedGlm.headers.Authorization, 'Bearer go-key');
    assert.equal(resolvedGlm.capabilities.reasoning.paramStyle, 'openai-effort');

    // GLM-5.3 系是常开思考模型（上游 400 [1210]：仅接受 low/high/max）：
    // 按模型档位契约覆盖 wire 级默认，off/default 收敛为 low，xhigh 收敛为 max。
    const resolvedGlmFlash = resolveChannel({
      channelId: CHANNEL_IDS.OPENCODE_GO,
      authMethod: 'api_key',
      apiKey: 'go-key',
      model: 'glm-5.3-flash',
    });
    assert.equal(resolvedGlmFlash.wire, 'openai-chat');
    assert.deepEqual(resolvedGlmFlash.reasoningEffortMap, {
      off: 'low',
      low: 'low',
      default: 'low',
      medium: 'high',
      high: 'high',
      max: 'max',
      xhigh: 'max',
    });
    assert.deepEqual(resolvedGlmFlash.reasoningEffortLevels, ['off', 'low', 'default', 'high', 'xhigh']);
    assert.equal(resolvedGlmFlash.reasoningDefaultEffort, 'low');

    // glm-5.2 不在常开思考模型名单内，保持 wire 级默认（无按模型 effortMap）。
    assert.equal(resolvedGlm.reasoningEffortMap, undefined);

    for (const model of ['kimi-k3', 'deepseek-v4-flash', 'grok-4.5', 'mimo-v2.5', 'hy3-preview']) {
      const resolved = resolveChannel({
        channelId: CHANNEL_IDS.OPENCODE_GO,
        authMethod: 'api_key',
        apiKey: 'go-key',
        model,
      });
      assert.equal(resolved.wire, 'openai-chat', model);
      assert.equal(resolved.endpoint, 'https://opencode.ai/zen/go/v1/chat/completions', model);
    }

    // MiniMax / Qwen on Go use Anthropic Messages.
    for (const model of ['minimax-m2.5', 'qwen3.5-plus']) {
      const resolved = resolveChannel({
        channelId: CHANNEL_IDS.OPENCODE_GO,
        authMethod: 'api_key',
        apiKey: 'go-key',
        model,
      });
      assert.equal(resolved.wire, 'anthropic-messages', model);
      assert.equal(resolved.endpoint, 'https://opencode.ai/zen/go/v1/messages', model);
    }

    // Legacy dual-entry channel ids still resolve to the single Go channel.
    const legacyOpenAi = resolveChannel({
      channelId: CHANNEL_IDS.OPENCODE_GO_OPENAI,
      authMethod: 'api_key',
      model: 'gpt-5.6-luna',
    });
    assert.equal(legacyOpenAi.channelId, CHANNEL_IDS.OPENCODE_GO);
    assert.equal(legacyOpenAi.endpoint, 'https://opencode.ai/zen/go/v1/responses');

    const legacyAnthropic = resolveChannel({
      channelId: CHANNEL_IDS.OPENCODE_GO_ANTHROPIC,
      authMethod: 'api_key',
      model: 'claude-opus-4-6',
    });
    assert.equal(legacyAnthropic.channelId, CHANNEL_IDS.OPENCODE_GO);
    assert.equal(legacyAnthropic.wire, 'anthropic-messages');
    assert.equal(legacyAnthropic.endpoint, 'https://opencode.ai/zen/go/v1/messages');

    // Explicit wireOverride still wins over model auto-routing.
    const forced = resolveChannel({
      channelId: CHANNEL_IDS.OPENCODE_GO,
      authMethod: 'api_key',
      model: 'claude-sonnet-4-5',
      wireOverride: 'openai-responses',
    });
    assert.equal(forced.wire, 'openai-responses');
    assert.equal(forced.endpoint, 'https://opencode.ai/zen/go/v1/responses');
  });
});
