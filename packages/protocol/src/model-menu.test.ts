import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModelMenuGroups, modelMenuChannelName, type ModelMenuRow } from './model-menu.ts';

for (const isZh of [true, false]) for (const custom of [true, false]) {
  test(`channel naming / zh=${isZh} / custom=${custom}`, () => {
    assert.equal(modelMenuChannelName(custom ? 'My account' : 'ChatGPT Subscription', 'gpt', 'oauth_chatgpt', isZh), custom ? 'My account' : isZh ? 'ChatGPT 订阅' : 'ChatGPT Subscription');
    assert.equal(modelMenuChannelName('', 'fallback', 'api_key', isZh), 'fallback');
  });
}

for (const sameName of [true, false]) for (const availability of ['all', 'mixed', 'none']) {
  test(`model menu parity / same channel name=${sameName} / ${availability}`, () => {
    const rows: ModelMenuRow[] = [
      { id: 'a0', groupId: 'a', groupLabel: 'Channel', model: 'z', available: availability === 'all' },
      { id: 'b0', groupId: 'b', groupLabel: sameName ? 'Channel' : 'Other', model: 'same', modelLabel: 'Pretty', available: availability !== 'none' },
      { id: 'a1', groupId: 'a', groupLabel: 'ignored later name', model: 'same', available: availability !== 'none' },
      { id: 'a1', groupId: 'a', groupLabel: 'ignored', model: 'same', available: availability !== 'none' },
    ];
    const desktop = buildModelMenuGroups(rows);
    assert.deepEqual(desktop.map((group) => group.id), ['a', 'b']);
    assert.deepEqual(desktop[0]!.items.map((item) => item.id), ['a0', 'a1', 'a1']);
    assert.equal(desktop[1]!.items[0]!.label, 'Pretty');
    const expected = desktop.map((group) => ({ ...group, items: group.items.filter((item) => !item.disabled), disabled: false })).filter((group) => group.items.length);
    assert.deepEqual(buildModelMenuGroups(rows, true), expected);
  });
}
