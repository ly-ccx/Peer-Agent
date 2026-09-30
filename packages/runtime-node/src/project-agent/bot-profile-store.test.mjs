import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOT_AVATAR_COLORS, generateAvatar } from '@peer-agent/protocol';

import { cleanDisplayName, createBotProfileStore } from './bot-profile-store.mjs';

function tempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'b2-12-profile-'));
}

test('名字去掉控制字符和路径分隔符，并且不超过 40 个字', () => {
  assert.equal(cleanDisplayName('a/b\\c\u0000d'), 'abcd');
  assert.equal(cleanDisplayName('  笔记. '), '笔记');
  assert.equal(cleanDisplayName(''), '');
  const long = '项'.repeat(50);
  assert.equal(Array.from(cleanDisplayName(long)).length, 40);
});

test('头像由工作区 id 决定，换一个会带盐重新生成', () => {
  const root = tempRoot();
  try {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const store = createBotProfileStore({
      rootDir: root,
      now: () => new Date('2026-09-27T00:00:00.000Z'),
    });
    const created = store.create({
      workspaceId,
      displayName: '演示',
      agentConversationId: 'conv-1',
    });
    assert.equal(created.ok, true);
    assert.deepEqual(created.profile.avatar, generateAvatar(workspaceId));
    const again = store.create({
      workspaceId,
      displayName: '另一个名字',
      agentConversationId: 'conv-2',
    });
    assert.equal(again.created, false);
    assert.equal(again.profile.displayName, '演示');
    assert.equal(again.profile.agentConversationId, 'conv-1');
    const rotated = store.regenerateAvatar(workspaceId);
    assert.equal(Number(rotated.profile.avatarSalt) > 0, true);
    assert.notEqual(rotated.profile.avatar.color, created.profile.avatar.color);
    assert.deepEqual(rotated.profile.avatar, generateAvatar(`${workspaceId}:${rotated.profile.avatarSalt}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('新建和换一个不会与现有生成头像使用相同组合', () => {
  const root = tempRoot();
  try {
    const signature = (avatar) => `${avatar.shape}:${avatar.color}:${avatar.variant}`;
    const seen = new Map();
    let pair = null;
    for (let index = 0; index < 5000 && !pair; index += 1) {
      const id = `collision-${index}`;
      const key = signature(generateAvatar(id));
      const first = seen.get(key);
      if (first) pair = [first, id];
      else seen.set(key, id);
    }
    assert.ok(pair, 'fixture should find a deterministic generated collision');
    const store = createBotProfileStore({ rootDir: root });
    const first = store.create({ workspaceId: pair[0], displayName: '甲', agentConversationId: 'conv-a' });
    const second = store.create({ workspaceId: pair[1], displayName: '乙', agentConversationId: 'conv-b' });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.notEqual(signature(first.profile.avatar), signature(second.profile.avatar));
    assert.notEqual(second.profile.avatarSalt, '');
    const rotated = store.regenerateAvatar(pair[0]);
    assert.equal(rotated.ok, true);
    assert.notEqual(signature(rotated.profile.avatar), signature(second.profile.avatar));
    assert.notEqual(signature(rotated.profile.avatar), signature(first.profile.avatar));
    assert.deepEqual(store.read(pair[1]).avatar, second.profile.avatar);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('选色保留造型并持久化，上传图片后选色会恢复生成头像', () => {
  const root = tempRoot();
  try {
    const workspaceId = 'colorful-bot';
    const store = createBotProfileStore({ rootDir: root });
    const original = store.create({ workspaceId, displayName: '彩色', agentConversationId: 'conv-color' }).profile.avatar;
    const color = BOT_AVATAR_COLORS.find((item) => item !== original.color);
    const colored = store.setAvatarColor(workspaceId, color);
    assert.equal(colored.ok, true);
    assert.deepEqual(colored.profile.avatar, { ...original, color });
    assert.deepEqual(store.read(workspaceId).avatar, colored.profile.avatar);
    assert.equal(store.setAvatarColor(workspaceId, '#123456').code, 'INVALID_AVATAR_COLOR');
    assert.deepEqual(store.read(workspaceId).avatar, colored.profile.avatar);
    const png = path.join(root, 'color-src.png');
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    assert.equal(store.installAvatar(workspaceId, png).ok, true);
    assert.equal(store.setAvatarColor(workspaceId, color).profile.avatar.kind, 'generated');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('选色遇到已有造型组合时换表情，避免两个机器人完全相同', () => {
  const root = tempRoot();
  try {
    const store = createBotProfileStore({ rootDir: root });
    const first = store.create({ workspaceId: 'first-color-bot', displayName: '甲', agentConversationId: 'conv-a' }).profile;
    const second = store.create({ workspaceId: 'second-color-bot', displayName: '乙', agentConversationId: 'conv-b' }).profile;
    const alternate = BOT_AVATAR_COLORS.find((item) => item !== first.avatar.color);
    store.save({ ...second, avatar: { ...first.avatar, color: alternate } });
    const result = store.setAvatarColor(second.workspaceId, first.avatar.color);
    assert.equal(result.ok, true);
    assert.equal(result.profile.avatar.color, first.avatar.color);
    assert.equal(result.profile.avatar.shape, first.avatar.shape);
    assert.notEqual(result.profile.avatar.variant, first.avatar.variant);
    assert.deepEqual(store.read(first.workspaceId).avatar, first.avatar);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('旧版无表情编号的头像选色后保留屏幕上的轮廓', () => {
  const root = tempRoot();
  try {
    const workspaceId = 'legacy-color-bot';
    const store = createBotProfileStore({ rootDir: root });
    const profile = store.create({ workspaceId, displayName: '旧头像', agentConversationId: 'conv-legacy' }).profile;
    store.save({ ...profile, avatar: { kind: 'generated', shape: 'square', color: '#dc2626' } });
    const oldVariant = generateAvatar(workspaceId).variant;
    const expectedShape = ['circle', 'square', 'triangle', 'diamond', 'hex', 'pill', 'star', 'arch'][(1 + oldVariant) % 8];
    const result = store.setAvatarColor(workspaceId, BOT_AVATAR_COLORS[3]);
    assert.equal(result.ok, true);
    assert.equal(result.profile.avatar.shape, expectedShape);
    assert.equal(result.profile.avatar.variant, oldVariant);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('上传只接受 png、jpg、webp，并且不超过 1 MB', () => {
  const root = tempRoot();
  try {
    const workspaceId = '22222222-2222-4222-8222-222222222222';
    const store = createBotProfileStore({ rootDir: root });
    store.create({
      workspaceId,
      displayName: '演示',
      agentConversationId: 'conv-1',
    });
    const png = path.join(root, 'avatar-src.png');
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    const installed = store.installAvatar(workspaceId, png);
    assert.equal(installed.ok, true);
    assert.deepEqual(installed.profile.avatar, { kind: 'image', ref: 'avatar.png' });
    assert.equal(statSync(path.join(root, 'projects', workspaceId, 'avatar.png')).isFile(), true);
    const shown = store.readAvatar(workspaceId);
    assert.equal(shown.ok, true);
    assert.equal(shown.mime, 'image/png');
    assert.deepEqual(shown.bytes, readFileSync(png));
    const gif = path.join(root, 'avatar.gif');
    writeFileSync(gif, Buffer.from('GIF89a'));
    assert.equal(store.installAvatar(workspaceId, gif).code, 'INVALID_IMAGE');
    const huge = path.join(root, 'huge.png');
    writeFileSync(huge, Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(1024 * 1024),
    ]));
    assert.equal(store.installAvatar(workspaceId, huge).code, 'INVALID_IMAGE');
    assert.equal(store.read(workspaceId).avatar.ref, 'avatar.png');
    assert.equal(store.readAvatar('../outside').code, 'NOT_FOUND');
    store.save({ ...store.read(workspaceId), avatar: { kind: 'image', ref: '../../avatar-src.png' } });
    assert.equal(store.readAvatar(workspaceId).code, 'INVALID_IMAGE');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
