import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createI18n } from '@peer-agent/i18n';
import { remoteAccessEn, remoteAccessZh } from '../../../../../../packages/i18n/src/remote-access.ts';
import { changeProjectGrant, createRemoteAccessPanelState } from './remoteAccessPanelState.ts';
import { describeFailure, connectionSummary, type Status } from './remoteAccessPresentation.ts';
const status = (version = 1): Status => ({ settings: { enabled: false, gatewayOrigin: 'https://peer.example', workspaceId: '', projectGrants: [], workspaceIds: [], delegationVersion: version }, active: false, online: false, deviceId: null, connectionEpoch: 0, lastAccess: null });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise(resolve => setImmediate(resolve));

test('permissions start closed, messaging requires viewing, revoking viewing revokes messaging and preserves other bots', () => {
  const other = { workspaceId: 'b', allowProjectRead: true, allowProjectMessage: true };
  let grants = changeProjectGrant([other], 'a', 'message', true);
  assert.deepEqual(grants[1], { workspaceId: 'a', allowProjectRead: false, allowProjectMessage: false });
  grants = changeProjectGrant(grants, 'a', 'read', true);
  grants = changeProjectGrant(grants, 'a', 'message', true);
  assert.equal(grants.find(row => row.workspaceId === 'a')?.allowProjectMessage, true);
  grants = changeProjectGrant(grants, 'a', 'read', false);
  assert.deepEqual(grants, [other, { workspaceId: 'a', allowProjectRead: false, allowProjectMessage: false }]);
});

test('late poll cannot overwrite saved policy; saving disables competing updates and polls', async () => {
  const old = deferred<{ ok: boolean; status: Status }>(), save = deferred<{ ok: boolean; status: Status }>();
  let reads = 0, writes = 0;
  const state = createRemoteAccessPanelState({ getRemoteAccess: () => { reads++; return old.promise; },
    updateRemoteAccess: () => { writes++; return save.promise; }, applyRemoteAccess: async () => ({ ok: true, status: status() }), projectAgentList: async () => ({ ok: true, items: [] }) });
  state.start(); const changed = state.update({ projectGrants: [] });
  assert.equal(state.getSnapshot().busy, true);
  await state.refresh(); await state.update({ enabled: true });
  assert.equal(reads, 1); assert.equal(writes, 1);
  save.resolve({ ok: true, status: status(2) }); await changed;
  old.resolve({ ok: true, status: status(1) }); await tick();
  assert.equal(state.getSnapshot().status?.settings.delegationVersion, 2);
  assert.equal(state.getSnapshot().busy, false); state.stop();
});

test('failed reconnect reads persisted intent and keeps error visible across polls', async () => {
  const state = createRemoteAccessPanelState({ getRemoteAccess: async () => ({ ok: true, status: status(2) }),
    updateRemoteAccess: async () => ({ ok: false, error: 'ENOTFOUND' }), applyRemoteAccess: async () => ({ ok: false, error: 'ENOTFOUND' }), projectAgentList: async () => ({ ok: true, items: [] }) });
  state.start(); await tick(); await state.reconnect(); await state.refresh();
  assert.equal(state.getSnapshot().status?.settings.delegationVersion, 2);
  assert.equal(state.getSnapshot().error, 'ENOTFOUND'); assert.equal(state.getSnapshot().busy, false); state.stop();
});

test('unmounted panel ignores pending status, save and bot list, including rejected promises', async () => {
  const read = deferred<{ ok: boolean; status: Status }>(), list = deferred<{ ok: boolean; items: [] }>(), save = deferred<{ ok: boolean; status: Status }>();
  const state = createRemoteAccessPanelState({ getRemoteAccess: () => read.promise, updateRemoteAccess: () => save.promise,
    applyRemoteAccess: () => save.promise, projectAgentList: () => list.promise });
  let notifications = 0; state.subscribe(() => { notifications++; }); state.start(); const changed = state.update({ enabled: true });
  state.stop(); const before = notifications;
  read.resolve({ ok: true, status: status() }); save.resolve({ ok: true, status: status(2) }); list.resolve({ ok: true, items: [] }); await changed; await tick();
  assert.equal(notifications, before); assert.equal(state.getSnapshot().status, null);
});

test('remote settings resources have identical keys and translate status and failure in English', () => {
  assert.deepEqual(Object.keys(remoteAccessZh).sort(), Object.keys(remoteAccessEn).sort());
  const en = createI18n('en-US');
  assert.equal(connectionSummary(status(), en), 'Disconnected');
  assert.match(describeFailure({ reason: 'timeout' }, en), /Pairing timed out/);
  assert.doesNotMatch(en.t('remoteAccess.messageLabel', { name: 'Test bot' }), /[\u4e00-\u9fff]/);
});
