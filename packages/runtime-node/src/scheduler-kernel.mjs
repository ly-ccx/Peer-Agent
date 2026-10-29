import { latestAutomationOccurrence, nextAutomationOccurrence, validateAutomationSchedule } from './automation-schedule.mjs';

/** The shared schedule contract: persisted cursor, newest missed occurrence, skip overlapping work. */
export function inspectSchedule({schedule,after,now,active=false,missedRunPolicy='run_latest',overlapPolicy='skip'}={}) {
  if(!Number.isFinite(Date.parse(now)))throw TypeError('now must be an ISO timestamp');
  validateAutomationSchedule(schedule);
  const due=latestAutomationOccurrence(schedule,{after,at:now});
  if(!due)return {due:null,next:nextAutomationOccurrence(schedule,now)};
  const missed=Date.parse(due)<Math.floor(Date.parse(now)/60_000)*60_000;
  return {due,next:nextAutomationOccurrence(schedule,due),missed,
    ...(missed&&missedRunPolicy==='skip'?{skippedReason:'missed_policy'}:active&&overlapPolicy==='skip'?{skippedReason:'overlap'}:{})};
}
