import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveAppshotDestination,
  buildAppshotMessage,
  deliverAppshot,
} from './appshot-delivery.mjs';

const payload = {
  appshotId: 'abc-123',
  capturedAt: '2026-07-30T12:00:00.000Z',
  source: { appName: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 42, windowId: 7 },
  visual: {
    artifactRef: 'local-appshot-artifact://abc-123',
    filePath: '/tmp/appshot-abc-123.png',
    width: 800,
    height: 600,
    mimeType: 'image/png',
    byteSize: 12345,
  },
  text: { mode: 'none' },
};

test('routes to most recently active non-archived conversation', () => {
  const result = resolveAppshotDestination({
    listConversations: () => [
      { id: 'old', updatedAt: '2026-07-29T00:00:00Z' },
      { id: 'newest', updatedAt: '2026-07-30T10:00:00Z' },
      { id: 'mid', updatedAt: '2026-07-30T01:00:00Z' },
    ],
    createConversation: () => { throw new Error('must not create'); },
  });
  assert.equal(result.conversationId, 'newest');
  assert.equal(result.created, false);
});

test('creates a new conversation when none exists', () => {
  let created = 0;
  const result = resolveAppshotDestination({
    listConversations: () => [],
    createConversation: () => { created += 1; return { id: 'fresh' }; },
  });
  assert.equal(result.conversationId, 'fresh');
  assert.equal(result.created, true);
  assert.equal(created, 1);
});

test('archived conversations are skipped', () => {
  const result = resolveAppshotDestination({
    listConversations: () => [
      { id: 'archived-new', archivedAt: '2026-07-30T09:00:00Z', updatedAt: '2026-07-30T11:00:00Z' },
      { id: 'live-old', updatedAt: '2026-07-28T00:00:00Z' },
    ],
    createConversation: () => ({ id: 'x' }),
  });
  assert.equal(result.conversationId, 'live-old');
});

test('all-archived falls back to creating a new conversation', () => {
  const result = resolveAppshotDestination({
    listConversations: () => [
      { id: 'a', archivedAt: '2026-07-30T09:00:00Z', updatedAt: '2026-07-30T11:00:00Z' },
    ],
    createConversation: () => ({ id: 'fresh' }),
  });
  assert.equal(result.conversationId, 'fresh');
  assert.equal(result.created, true);
});

test('message is user-side with artifactRef and no full-image inline', () => {
  const message = buildAppshotMessage(payload, { thumbnailDataUrl: 'data:image/png;base64,tiny' });
  assert.equal(message.role, 'user');
  const att = message.attachments[0];
  assert.equal(att.kind, 'image');
  assert.equal(att.artifactRef, 'local-appshot-artifact://abc-123');
  assert.equal(att.dataUrl, 'data:image/png;base64,tiny');
  assert.equal(att.appshot.appName, 'TextEdit');
  assert.equal(att.appshot.textMode, 'none');
  // Without a thumbnail, no dataUrl at all (never the full image).
  const bare = buildAppshotMessage(payload);
  assert.equal(bare.attachments[0].dataUrl, undefined);
});

test('deliverAppshot appends exactly one message and never runs the agent', () => {
  const appended = [];
  const result = deliverAppshot({
    payload,
    listConversations: () => [{ id: 'conv-1', updatedAt: '2026-07-30T10:00:00Z' }],
    createConversation: () => { throw new Error('must not create'); },
    appendMessage: (id, message) => appended.push({ id, message }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.conversationId, 'conv-1');
  assert.equal(appended.length, 1);
  assert.equal(appended[0].id, 'conv-1');
  assert.equal(appended[0].message.id, 'appshot-abc-123');
});
