import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TRAY_RECENT_EXPANDED_LIMIT,
  TRAY_RECENT_LIMIT,
  buildTrayMenuTemplate,
  truncateTrayTitle,
  workspaceShortName,
} from './tray-controller.mjs';

describe('truncateTrayTitle', () => {
  it('falls back to 新任务 for empty titles', () => {
    assert.equal(truncateTrayTitle(''), '新任务');
    assert.equal(truncateTrayTitle('   '), '新任务');
    assert.equal(truncateTrayTitle(null), '新任务');
  });

  it('truncates long titles with ellipsis', () => {
    const long = '这是一个非常非常非常非常非常非常非常非常非常非常长的会话标题用来测试截断';
    const out = truncateTrayTitle(long, 10);
    assert.ok(out.endsWith('…'));
    assert.ok(out.length <= 10);
  });
});

describe('workspaceShortName', () => {
  it('returns basename for absolute paths', () => {
    assert.equal(workspaceShortName('/Users/me/Documents/DEV/github/peer_agent'), 'peer_agent');
    assert.equal(workspaceShortName(''), '');
  });
});

describe('buildTrayMenuTemplate', () => {
  it('shows recent Automation results and returns to the exact Run', () => {
    let target = null;
    const template = buildTrayMenuTemplate({
      automationRuntime: { activeCount: 1, globallyPaused: false },
      recentAutomationRuns: [{
        automationId: 'a1', runId: 'r1', automationName: 'Daily review',
        status: 'succeeded', summary: 'Two repositories changed.',
      }],
      handlers: { onOpenAutomationRun: (value) => { target = value; } },
    });
    const item = template.find((entry) => entry.id === 'tray-automation-run-r1');
    assert.equal(item.label, 'Daily review');
    assert.match(item.sublabel, /Two repositories changed/);
    item.click();
    assert.deepEqual(target, { automationId: 'a1', runId: 'r1' });
  });
  it('builds empty Recent state with lifecycle actions', () => {
    const calls = [];
    const template = buildTrayMenuTemplate({
      recent: [],
      handlers: {
        onNewChat: () => calls.push('new'),
        onOpenApp: () => calls.push('open'),
        onQuit: () => calls.push('quit'),
      },
    });

    const labels = template.map((item) => item.label).filter(Boolean);
    assert.ok(labels.includes('最近任务'));
    assert.ok(labels.includes('暂无任务'));
    // 无溢出时不展示「更多」
    assert.equal(labels.includes('更多'), false);
    assert.ok(labels.includes('新任务'));
    assert.ok(labels.includes('打开 Peer Agent'));
    assert.ok(labels.includes('退出 Peer Agent'));

    template.find((item) => item.id === 'tray-new-chat').click();
    template.find((item) => item.id === 'tray-open').click();
    template.find((item) => item.id === 'tray-quit').click();
    assert.deepEqual(calls, ['new', 'open', 'quit']);
  });

  it('shows automation runtime status and pause control', () => {
    const calls = [];
    const template = buildTrayMenuTemplate({
      automationRuntime: { activeCount: 3, globallyPaused: false },
      handlers: {
        onToggleAutomations: (paused) => calls.push(paused),
        onOpenAutomations: () => calls.push('open'),
      },
    });
    assert.ok(template.some((item) => item.label === 'Automations · 3 active'));
    template.find((item) => item.id === 'tray-automations-toggle').click();
    template.find((item) => item.id === 'tray-automations-open').click();
    assert.deepEqual(calls, [true, 'open']);
  });

  it('includes recent conversations with title and workspace subtitle', () => {
    const opened = [];
    const recent = [
      { id: 'c1', title: '排查任务崩溃', workspacePath: '/ws/peer_agent' },
      { id: 'c2', title: '为什么上下文差这么多', workspacePath: '/ws/peer-knowledge' },
    ];
    const template = buildTrayMenuTemplate({
      recent,
      handlers: {
        onOpenConversation: (payload) => opened.push(payload),
      },
    });

    const recentItems = template.filter((item) => String(item.id || '').startsWith('tray-recent:'));
    assert.equal(recentItems.length, 2);
    assert.equal(recentItems[0].label, '排查任务崩溃');
    assert.equal(recentItems[0].sublabel, 'peer_agent');
    assert.equal(recentItems[1].label, '为什么上下文差这么多');
    assert.equal(recentItems[1].sublabel, 'peer-knowledge');
    recentItems[0].click();
    assert.deepEqual(opened[0], {
      conversationId: 'c1',
      workspacePath: '/ws/peer_agent',
      source: 'tray-recent',
    });
  });

  it('omits sublabel when conversation has no workspace path', () => {
    const template = buildTrayMenuTemplate({
      recent: [{ id: 'c-empty-ws', title: '无工作区会话', workspacePath: '' }],
    });
    const recentItems = template.filter((item) => String(item.id || '').startsWith('tray-recent:'));
    assert.equal(recentItems.length, 1);
    assert.equal(recentItems[0].label, '无工作区会话');
    assert.equal(recentItems[0].sublabel, undefined);
  });

  it('keeps primary recent items to TRAY_RECENT_LIMIT and puts overflow in more submenu', () => {
    const opened = [];
    const recent = Array.from({ length: TRAY_RECENT_LIMIT + 3 }, (_, i) => ({
      id: `c${i}`,
      title: `会话 ${i}`,
      workspacePath: `/ws/${i}`,
    }));
    const template = buildTrayMenuTemplate({
      recent,
      handlers: {
        onOpenConversation: (payload) => opened.push(payload.conversationId),
      },
    });
    const primary = template.filter((item) => String(item.id || '').startsWith('tray-recent:'));
    assert.equal(primary.length, TRAY_RECENT_LIMIT);
    const more = template.find((item) => item.id === 'tray-more');
    assert.ok(more, 'should show 更多 submenu when overflow exists');
    assert.ok(Array.isArray(more.submenu));
    assert.equal(more.submenu.length, 3);
    assert.equal(more.submenu[0].id, `tray-recent:c${TRAY_RECENT_LIMIT}`);
    more.submenu[0].click();
    assert.deepEqual(opened, [`c${TRAY_RECENT_LIMIT}`]);
  });

  it('caps submenu overflow by TRAY_RECENT_EXPANDED_LIMIT', () => {
    const recent = Array.from({ length: TRAY_RECENT_EXPANDED_LIMIT + 5 }, (_, i) => ({
      id: `c${i + 1}`,
      title: `会话 ${i + 1}`,
      workspacePath: '/tmp/ws',
    }));
    const template = buildTrayMenuTemplate({ recent });
    const primary = template.filter((item) => String(item.id || '').startsWith('tray-recent:'));
    const more = template.find((item) => item.id === 'tray-more');
    assert.equal(primary.length, TRAY_RECENT_LIMIT);
    assert.ok(more?.submenu);
    assert.equal(more.submenu.length, TRAY_RECENT_EXPANDED_LIMIT - TRAY_RECENT_LIMIT);
  });

  it('hides more submenu when total recent fits collapsed limit', () => {
    const recent = Array.from({ length: 3 }, (_, i) => ({
      id: `c${i + 1}`,
      title: `会话 ${i + 1}`,
    }));
    const template = buildTrayMenuTemplate({ recent });
    assert.equal(template.some((item) => item.id === 'tray-more'), false);
  });
});
