import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import {
  ACTIVATION_CHECK_INTERVAL_MS,
  createUpdateCheckSchedule,
  registerActivationUpdateChecks,
} from './update-check-schedule.mjs';

describe('activation update check schedule', () => {
  it('becomes due exactly five minutes after the last actual check', () => {
    let currentTime = 1_000;
    const schedule = createUpdateCheckSchedule({ now: () => currentTime });

    assert.equal(schedule.isDue(), true);
    schedule.markChecked();

    currentTime += ACTIVATION_CHECK_INTERVAL_MS - 1;
    assert.equal(schedule.isDue(), false);

    currentTime += 1;
    assert.equal(schedule.isDue(), true);
  });

  it('lets manual or periodic checks refresh the shared activation throttle', () => {
    let currentTime = 10_000;
    const schedule = createUpdateCheckSchedule({ now: () => currentTime });

    schedule.markChecked();
    currentTime += ACTIVATION_CHECK_INTERVAL_MS;
    assert.equal(schedule.isDue(), true);

    schedule.markChecked();
    currentTime += 1;
    assert.equal(schedule.isDue(), false);
  });

  it('claims synchronously so overlapping activation events launch one check', async () => {
    let currentTime = 20_000;
    const app = new EventEmitter();
    const schedule = createUpdateCheckSchedule({ now: () => currentTime });
    schedule.markChecked(currentTime - ACTIVATION_CHECK_INTERVAL_MS);
    let checks = 0;
    let releaseCheck;
    const pendingCheck = new Promise((resolve) => {
      releaseCheck = resolve;
    });

    const dispose = registerActivationUpdateChecks({
      app,
      schedule,
      checkForUpdates: async () => {
        checks += 1;
        await pendingCheck;
      },
    });

    app.emit('activate');
    app.emit('browser-window-focus');
    await Promise.resolve();
    assert.equal(checks, 1);

    releaseCheck();
    await pendingCheck;
    dispose();
  });

  it('contains check failures inside the activation trigger', async () => {
    const app = new EventEmitter();
    const schedule = createUpdateCheckSchedule();
    registerActivationUpdateChecks({
      app,
      schedule,
      checkForUpdates: () => {
        throw new Error('network unavailable');
      },
    });

    assert.doesNotThrow(() => app.emit('activate'));
    await Promise.resolve();
    await Promise.resolve();
  });

  it('checks again after the throttle and removes listeners on dispose', async () => {
    let currentTime = 30_000;
    const app = new EventEmitter();
    const schedule = createUpdateCheckSchedule({ now: () => currentTime });
    schedule.markChecked();
    let checks = 0;

    const dispose = registerActivationUpdateChecks({
      app,
      schedule,
      checkForUpdates: () => {
        checks += 1;
      },
    });

    app.emit('activate');
    assert.equal(checks, 0);

    currentTime += ACTIVATION_CHECK_INTERVAL_MS;
    app.emit('browser-window-focus');
    await Promise.resolve();
    assert.equal(checks, 1);

    dispose();
    currentTime += ACTIVATION_CHECK_INTERVAL_MS;
    app.emit('activate');
    app.emit('browser-window-focus');
    assert.equal(checks, 1);
    assert.equal(app.listenerCount('activate'), 0);
    assert.equal(app.listenerCount('browser-window-focus'), 0);
  });
});
