// Compatibility seam for Desktop-local imports.
// Schedule calculation and reconciliation are host-neutral Node modules.
export {
  automationIdempotencyKey,
  automationOccurrences,
  completeOnceAutomationIfNeeded,
  createAutomationScheduler,
  latestAutomationOccurrence,
  nextAutomationOccurrence,
  parseAutomationCron,
  reconcileAutomationSchedules,
  validateAutomationSchedule,
} from '@peer-agent/runtime-node';
