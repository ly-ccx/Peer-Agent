export function systemAutomationTimezone(
  resolvedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  return resolvedTimezone?.trim() || 'UTC';
}

export function timezoneForExistingAutomation(timezone: string): string {
  return timezone;
}
