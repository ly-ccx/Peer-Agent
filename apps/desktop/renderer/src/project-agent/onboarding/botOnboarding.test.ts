import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createI18n } from '@peer-agent/i18n';
import {
  botOnboardingStep,
  projectAgentShellOf,
  shellPreferencePatch,
  upgradeBannerPending,
} from './botShell.ts';

const KEYS = [
  'settings.shell.title',
  'settings.shell.bots',
  'settings.shell.classic',
  'projectAgent.shell.classicNotice',
  'projectAgent.shell.banner',
  'projectAgent.shell.bannerTitle',
  'projectAgent.shell.bannerWhere',
  'projectAgent.shell.bannerPath',
  'projectAgent.shell.bannerSwitch',
  'projectAgent.onboarding.connectAction',
  'projectAgent.onboarding.createAction',
] as const;

test('缺省界面是机器人列表，只有 classic 才回到经典界面', () => {
  assert.equal(projectAgentShellOf(undefined), 'bots');
  assert.equal(projectAgentShellOf({}), 'bots');
  assert.equal(projectAgentShellOf({ projectAgent: { shell: 'bots' } }), 'bots');
  assert.equal(projectAgentShellOf({ projectAgent: { shell: 'classic' } }), 'classic');
  assert.equal(projectAgentShellOf({ projectAgent: { shell: 'other' } }), 'bots');
});

test('首启先接入模型，有模型没有机器人时才新建', () => {
  assert.equal(botOnboardingStep({ hasModel: false, botCount: 0, ready: false }), null);
  assert.equal(botOnboardingStep({ hasModel: false, botCount: 0, ready: true }), 'connect-model');
  assert.equal(botOnboardingStep({ hasModel: true, botCount: 0, ready: true }), 'create-bot');
  assert.equal(botOnboardingStep({ hasModel: true, botCount: 2, ready: true }), null);
});

test('升级横幅只在待看且未关闭时出现', () => {
  assert.equal(upgradeBannerPending({ projectAgent: { shellIntroPending: true } }), true);
  assert.equal(upgradeBannerPending({
    projectAgent: { shellIntroPending: true, shellIntroDismissed: true },
  }), false);
  assert.equal(upgradeBannerPending({}), false);
});

test('切换界面的补丁不带工作区或开发者设置', () => {
  assert.deepEqual(shellPreferencePatch('classic'), { projectAgent: { shell: 'classic' } });
  assert.equal('workspaces' in shellPreferencePatch('bots'), false);
  assert.equal('developer' in shellPreferencePatch('classic'), false);
});

test('经典界面分支仍是原来的主布局，运行时不再读取开发者开关', () => {
  const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../../../../electron/main/main.mjs', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../../app/components/settings/DeveloperPanel.tsx', import.meta.url), 'utf8');
  assert.equal(app.includes('projectAgentMode'), false);
  assert.equal(main.includes('projectAgentMode'), false);
  assert.equal(panel.includes('type="checkbox"'), false);
  assert.match(app, /botListShell\.active \? \(/);
  const branchAt = app.indexOf('botListShell.active ? (');
  const sidebarAt = app.indexOf('<Sidebar');
  assert.ok(sidebarAt > branchAt);
  const zh = createI18n('zh-CN');
  const en = createI18n('en-US');
  for (const key of KEYS) {
    assert.notEqual(zh.t(key), key, key);
    assert.notEqual(en.t(key), key, key);
  }
  assert.equal(zh.t('projectAgent.shell.classicNotice'), '切换到机器人界面查看');
  assert.match(zh.t('projectAgent.shell.bannerPath'), /历史对话/);
  assert.match(zh.t('projectAgent.shell.bannerSwitch'), /设置 → 通用/);
});
