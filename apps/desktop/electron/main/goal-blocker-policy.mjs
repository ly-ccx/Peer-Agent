const RECOVERABLE_SYSTEM_BLOCKER_PATTERNS = [
  /^No renderer window is available for Goal Runner$/i,
];

/**
 * Compatibility policy for legacy Goal Runner blockers that only persist free-text reasons.
 * Keep this allow-list narrow: unknown, permission, and product-decision blockers remain
 * user/runner owned until the Goal contract gains a structured blocker kind.
 */
export function isRecoverableSystemGoalBlocker(blockedReason) {
  if (typeof blockedReason !== 'string') return false;
  const reason = blockedReason.trim();
  if (!reason) return false;
  return RECOVERABLE_SYSTEM_BLOCKER_PATTERNS.some((pattern) => pattern.test(reason));
}
