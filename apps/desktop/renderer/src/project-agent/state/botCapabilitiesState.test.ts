import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasBotCapabilityOverrides,
  normalizeBotCapabilityPolicy,
  resolveBotMcpEnabled,
  resolveBotSkillEnabled,
  toggleBotMcpOverride,
  toggleBotSkillOverride,
  type LocalMcpServerView,
  type SkillSummary,
} from '@peer-agent/protocol';
import { mergeBotMcps, mergeBotSkills } from './botCapabilitiesState.ts';

test('Bot 能力策略默认继承全局并支持按 Bot 单独开关覆盖', () => {
  assert.equal(hasBotCapabilityOverrides(null), false);
  assert.equal(resolveBotSkillEnabled(null, 'skill-a', true), true);
  assert.equal(resolveBotSkillEnabled(null, 'skill-b', false), false);
  assert.equal(resolveBotMcpEnabled(null, 'mcp-a', true), true);
  assert.equal(resolveBotMcpEnabled(null, 'mcp-b', false), false);

  // 关闭一个全局开启的 Skill → 写入 disabledSkillIds
  const afterDisable = toggleBotSkillOverride(null, 'skill-a', true, false);
  assert.deepEqual(afterDisable, { disabledSkillIds: ['skill-a'] });
  assert.equal(resolveBotSkillEnabled(afterDisable, 'skill-a', true), false);
  assert.equal(hasBotCapabilityOverrides(afterDisable), true);

  // 重新打开该 Skill → 恢复干净的 null（跟随全局）
  const afterReenable = toggleBotSkillOverride(afterDisable, 'skill-a', true, true);
  assert.equal(afterReenable, null);
  assert.equal(hasBotCapabilityOverrides(afterReenable), false);

  // 为当前 Bot 单独开启一个全局关闭的 MCP → 写入 enabledMcpIds
  const afterEnableMcp = toggleBotMcpOverride(null, 'mcp-b', false, true);
  assert.deepEqual(afterEnableMcp, { enabledMcpIds: ['mcp-b'] });
  assert.equal(resolveBotMcpEnabled(afterEnableMcp, 'mcp-b', false), true);

  // normalize 去除重复并确保 disabled 优先于 enabled
  assert.deepEqual(
    normalizeBotCapabilityPolicy({
      enabledSkillIds: [' a ', 'a', 'conflict'],
      disabledSkillIds: ['conflict', ''],
      enabledMcpIds: ['m1'],
      disabledMcpIds: [],
    }),
    {
      enabledSkillIds: ['a'],
      disabledSkillIds: ['conflict'],
      enabledMcpIds: ['m1'],
    },
  );
});

test('mergeBotSkills 按 workspace 覆盖 global 规则去重并应用 Bot 策略', () => {
  const raw: SkillSummary[] = [
    {
      skillId: 'shared',
      name: 'Shared Global',
      description: 'global',
      whenToUse: '',
      dataLevel: 'D1_internal',
      enabled: true,
      scope: 'global',
      version: '1.0.0',
    },
    {
      skillId: 'shared',
      name: 'Shared Project',
      description: 'workspace',
      whenToUse: '',
      dataLevel: 'D1_internal',
      enabled: true,
      scope: 'workspace',
      version: '1.1.0',
    },
    {
      skillId: 'off-globally',
      name: 'Off Globally',
      description: 'off',
      whenToUse: '',
      dataLevel: 'D1_internal',
      enabled: false,
      scope: 'global',
      version: '1.0.0',
    },
  ];

  const merged = mergeBotSkills(raw, {
    enabledSkillIds: ['off-globally'],
    disabledSkillIds: ['shared'],
  });
  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.skillId, 'shared');
  assert.equal(merged[0]?.scope, 'workspace');
  assert.equal(merged[0]?.effectiveEnabled, false);
  assert.equal(merged[0]?.overridden, true);
  assert.equal(merged[1]?.skillId, 'off-globally');
  assert.equal(merged[1]?.effectiveEnabled, true);
  assert.equal(merged[1]?.overridden, true);
});

test('mergeBotMcps 正确计算 MCP 有效状态与工具数', () => {
  const servers: LocalMcpServerView[] = [
    {
      id: 'docs',
      mcpId: 'docs',
      displayName: 'Docs',
      name: 'Docs',
      description: 'Docs server',
      enabled: true,
      transport: 'streamable_http',
      auth: { mode: 'none' },
      toolsCount: 2,
      visibleToolsCount: 1,
      resourcesCount: 0,
      promptsCount: 0,
      tools: [
        { name: 'search', description: 'Search', visible: true },
        { name: 'hidden', description: 'Hidden', visible: false },
      ],
      resources: [],
      prompts: [],
      health: { status: 'unknown', checkedAt: null, message: '' },
      policy: { trusted: true, requirePermission: true, visibleByDefault: true, maxRiskLevel: 'L3_external_write' },
    },
  ];
  const merged = mergeBotMcps(servers, { disabledMcpIds: ['docs'] });
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.effectiveEnabled, false);
  assert.equal(merged[0]?.overridden, true);
  assert.equal(merged[0]?.visibleToolsCount, 1);
});
