import assert from 'node:assert/strict';
import test from 'node:test';
import type { UpdaterStatus } from '@peer-agent/protocol';
import { reduceUpdaterStatus } from './updaterStatus.ts';

const downloaded: UpdaterStatus = {
  currentVersion: '0.1.0-rc.35',
  channel: 'beta',
  preference: 'auto',
  enabled: true,
  phase: 'downloaded',
  availableVersion: '0.1.0-rc.36',
  percent: 100,
};

test('a late full progress event does not reopen a finished download', () => {
  const next = reduceUpdaterStatus(downloaded, { type: 'download-progress', percent: 100 });
  assert.equal(next, downloaded);
  assert.equal(next.phase, 'downloaded');
});

test('progress before completion still updates the downloading snapshot', () => {
  const next = reduceUpdaterStatus(
    { ...downloaded, phase: 'downloading', percent: 40 },
    { type: 'download-progress', percent: 80 },
  );
  assert.equal(next.phase, 'downloading');
  assert.equal(next.percent, 80);
});

test('download completion is what leaves the progress phase', () => {
  const next = reduceUpdaterStatus(
    { ...downloaded, phase: 'downloading', percent: 100 },
    { type: 'update-downloaded', version: '0.1.0-rc.36' },
  );
  assert.equal(next.phase, 'downloaded');
  assert.equal(next.percent, 100);
});
