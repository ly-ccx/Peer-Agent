import { createAutomationScheduler } from './automation-scheduler.mjs';

/**
 * Electron lifecycle adapter for the host-neutral Automation Scheduler.
 * It translates OS wake/activity and wall-clock drift into one reconciliation seam.
 */
export function createAutomationRuntimeOwner({
  store,
  powerMonitor,
  onRunReady,
  clock = () => Date.now(),
  scheduleTimer,
  cancelTimer,
  timeCheckIntervalMs = 60_000,
  driftToleranceMs = 5_000,
  logger = console,
} = {}) {
  if (!store) throw new TypeError('store is required');
  const scheduler = createAutomationScheduler({
    store, onRunReady, clock, scheduleTimer, cancelTimer,
  });
  let driftTimer = null;
  let expectedWallClock = null;
  let started = false;

  const onResume = () => {
    expectedWallClock = clock() + timeCheckIntervalMs;
    try { scheduler.handleResume(); } catch (error) {
      logger?.error?.('[automation-runtime] resume reconciliation failed:', error);
    }
  };

  const onUserActive = () => {
    try { scheduler.reconcile('user_active'); } catch (error) {
      logger?.warn?.('[automation-runtime] user-active reconciliation failed:', error);
    }
  };

  function scheduleDriftCheck() {
    if (typeof scheduleTimer !== 'function') return;
    expectedWallClock = clock() + timeCheckIntervalMs;
    driftTimer = scheduleTimer(() => {
      driftTimer = null;
      const now = clock();
      if (expectedWallClock != null && Math.abs(now - expectedWallClock) > driftToleranceMs) {
        try { scheduler.handleTimeChange(); } catch (error) {
          logger?.warn?.('[automation-runtime] wall-clock reconciliation failed:', error);
        }
      }
      if (started) scheduleDriftCheck();
    }, timeCheckIntervalMs);
  }

  function start() {
    if (started) return scheduler.reconcile('owner_restart');
    started = true;
    powerMonitor?.on?.('resume', onResume);
    powerMonitor?.on?.('user-did-become-active', onUserActive);
    const result = scheduler.start();
    scheduleDriftCheck();
    return result;
  }

  function dispose() {
    if (!started) return;
    started = false;
    powerMonitor?.removeListener?.('resume', onResume);
    powerMonitor?.removeListener?.('user-did-become-active', onUserActive);
    if (driftTimer != null && typeof cancelTimer === 'function') cancelTimer(driftTimer);
    driftTimer = null;
    scheduler.stop();
  }

  return Object.freeze({
    name: 'automation-runtime',
    start,
    dispose,
    scheduler,
  });
}
