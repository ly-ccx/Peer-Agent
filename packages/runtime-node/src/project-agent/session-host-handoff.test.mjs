import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldPauseForHostHandoff, isHostHandoffPause} from './session-host-handoff.mjs';

test('handoff suspends active execution while preserving completed and user decision states', () => {
  const plan={status:'executing',runner:{status:'running'},delegationOrigin:{phase:'running'}};
  assert.equal(shouldPauseForHostHandoff(plan),true);
  for(const status of ['completed','paused','failed']) assert.equal(shouldPauseForHostHandoff({...plan,status}),false);
  for(const status of ['waiting_user','blocked','paused','completed']) assert.equal(shouldPauseForHostHandoff({...plan,runner:{status}}),false);
  assert.equal(shouldPauseForHostHandoff({...plan,delegationOrigin:{phase:'queued'}}),false);
});

test('only a persisted host handoff suspension admits automatic recovery', () => {
  const plan={status:'paused',runner:{status:'paused',blockedReason:'host_handoff'},delegationOrigin:{phase:'paused',pausedFromPhase:'running'}};
  assert.equal(isHostHandoffPause(plan),true);
  assert.equal(isHostHandoffPause({...plan,runner:{status:'paused',blockedReason:'paused'}}),false);
  assert.equal(isHostHandoffPause({...plan,delegationOrigin:{phase:'paused',pausedFromPhase:'queued'}}),false);
  assert.equal(isHostHandoffPause({...plan,status:'completed'}),false);
});
