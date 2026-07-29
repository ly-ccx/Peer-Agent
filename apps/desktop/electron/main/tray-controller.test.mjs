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
  it('falls back to 新会话 for empty titles', () => {
    assert.equal(truncateTrayTitle(''), '新会话');
    assert.equal(truncateTrayTitle('   '), '新会话');
    assert.equal(truncateTrayTitle(null), '新会话');
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
    assert.ok(labels.includes('最近会话'));
    assert.ok(labels.includes('暂无会话'));
    // 无溢出时不展示「更多」
    assert.equal(labels.includes('更多'), false);
    assert.ok(labels.includes('新会话'));
    assert.ok(labels.includes('打开 Peer Agent'));
    assert.ok(labels.includes('退出 Peer Agent'));

    template.find((item) => item.id === 'tray-new-chat').click();
    template.find((item) => item.id === 'tray-open').click();
    template.find((item) => item.id === 'tray-quit').click();
    assert.deepEqual(calls, ['new', 'open', 'quit']);
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

  it('caps recent items to TRAY_RECENT_LIMIT', () => {
    const recent = Array.from({ length: TRAY_RECENT_LIMIT + 3 }, (_, i) => ({
      id: `c${i}`,
      title: `会话 ${i}`,
      workspacePath: `/ws/${i}`,
    }));
    const template = buildTrayMenuTemplate({ recent });
    const recentItems = template.filter((item) => String(item.id || '').startsWith('tray-recent:'));
    assert.equal(recentItems.length, TRAY_RECENT_LIMIT);
  });

  it('shows more when overflow exists and expands via onExpandRecent', () => {
    const recent = Array.from({ length: 8 }, (_, i) => ({
      id: `c${i + 1}`,
      title: `会话 ${i + 1}`,
      workspacePath: '/tmp/ws',
    }));
    const expanded = [];
    const template = buildTrayMenuTemplate({
      recent,
      expanded: false,
      handlers: { onExpandRecent: () => expanded.push('expand') },
    });
    const more = template.find((item) => item.id === 'tray-more');
    assert.ok(more, 'should show 更多 when more than collapsed limit');
    more.click();
    assert.deepEqual(expanded, ['expand']);
  });

  it('expanded menu lists more conversations and offers collapse', () => {
    const recent = Array.from({ length: 12 }, (_, i) => ({
      id: `c${i + 1}`,
      title: `会话 ${i + 1}`,
      workspacePath: '/tmp/ws',
    }));
    const collapsed = [];
    const template = buildTrayMenuTemplate({
      recent,
      expanded: true,
      handlers: { onCollapseRecent: () => collapsed.push('collapse') },
    });
    const recentItems = template.filter((item) => String(item.id || '').startsWith('tray-recent:'));
    assert.equal(recentItems.length, 12);
    assert.ok(recentItems.length <= TRAY_RECENT_EXPANDED_LIMIT);
    const less = template.find((item) => item.id === 'tray-less');
    assert.ok(less, 'should show 收起 when expanded');
    assert.equal(template.some((item) => item.id === 'tray-more'), false);
    less.click();
    assert.deepEqual(collapsed, ['collapse']);
  });

  it('hides more when total recent fits collapsed limit', () => {
    const recent = Array.from({ length: 3 }, (_, i) => ({
      id: `c${i + 1}`,
      title: `会话 ${i + 1}`,
    }));
    const template = buildTrayMenuTemplate({ recent, expanded: false });
    assert.equal(template.some((item) => item.id === 'tray-more'), false);
  });
});
