const MINUTE_MS = 60_000;
const MAX_SEARCH_MINUTES = 370 * 24 * 60;
const formatterCache = new Map();

function formatterFor(timezone) {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23', weekday: 'short',
      });
      formatter.format(new Date(0));
    } catch {
      throw new TypeError(`invalid automation timezone: ${timezone}`);
    }
    formatterCache.set(timezone, formatter);
  }
  return formatter;
}

function zonedParts(timestampMs, timezone) {
  const parts = Object.fromEntries(
    formatterFor(timezone).formatToParts(new Date(timestampMs))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const weekdays = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: weekdays[parts.weekday],
  };
}

function wallKey(parts) {
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function assertInteger(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseCronField(source, min, max, { sundayAlias = false } = {}) {
  if (typeof source !== 'string' || !source.trim()) throw new TypeError('cron field is empty');
  const values = new Set();
  for (const token of source.split(',')) {
    const match = token.trim().match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
    if (!match) throw new TypeError(`unsupported cron field: ${token}`);
    const step = match[3] == null ? 1 : assertInteger(Number(match[3]), 1, max - min + 1, 'cron step');
    let start;
    let end;
    if (match[1] === '*') {
      start = min;
      end = max;
    } else {
      start = Number(match[1]);
      end = match[2] == null ? start : Number(match[2]);
    }
    if (sundayAlias && start === 0) start = 7;
    if (sundayAlias && end === 0) end = 7;
    assertInteger(start, min, max, 'cron range start');
    assertInteger(end, min, max, 'cron range end');
    if (end < start) throw new TypeError('cron ranges cannot wrap');
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

export function parseAutomationCron(expression) {
  if (typeof expression !== 'string') throw new TypeError('cron expression must be a string');
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new TypeError('automation cron must have exactly five fields');
  return {
    minutes: parseCronField(fields[0], 0, 59),
    hours: parseCronField(fields[1], 0, 23),
    days: parseCronField(fields[2], 1, 31),
    months: parseCronField(fields[3], 1, 12),
    weekdays: parseCronField(fields[4], 1, 7, { sundayAlias: true }),
  };
}

export function validateAutomationSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') throw new TypeError('schedule is required');
  const timezone = String(schedule.timezone || '');
  formatterFor(timezone);
  switch (schedule.kind) {
    case 'once': {
      if (!Number.isFinite(Date.parse(schedule.onceAt))) throw new TypeError('onceAt must be an ISO timestamp');
      break;
    }
    case 'hourly':
      assertInteger(schedule.everyHours ?? 1, 1, 24, 'everyHours');
      assertInteger(schedule.minute ?? 0, 0, 59, 'minute');
      break;
    case 'daily':
    case 'weekdays':
      assertInteger(schedule.hour, 0, 23, 'hour');
      assertInteger(schedule.minute, 0, 59, 'minute');
      break;
    case 'weekly': {
      assertInteger(schedule.hour, 0, 23, 'hour');
      assertInteger(schedule.minute, 0, 59, 'minute');
      if (!Array.isArray(schedule.weekdays) || !schedule.weekdays.length) throw new TypeError('weekly weekdays are required');
      schedule.weekdays.forEach((value) => assertInteger(value, 1, 7, 'weekday'));
      break;
    }
    case 'monthly':
      assertInteger(schedule.dayOfMonth, 1, 31, 'dayOfMonth');
      assertInteger(schedule.hour, 0, 23, 'hour');
      assertInteger(schedule.minute, 0, 59, 'minute');
      break;
    case 'custom_cron':
      parseAutomationCron(schedule.cron);
      break;
    default:
      throw new TypeError(`unsupported automation schedule kind: ${schedule.kind}`);
  }
  return schedule;
}

function scheduleMatches(schedule, parts, parsedCron) {
  switch (schedule.kind) {
    case 'hourly':
      return parts.hour % (schedule.everyHours ?? 1) === 0 && parts.minute === (schedule.minute ?? 0);
    case 'daily':
      return parts.hour === schedule.hour && parts.minute === schedule.minute;
    case 'weekdays':
      return parts.weekday <= 5 && parts.hour === schedule.hour && parts.minute === schedule.minute;
    case 'weekly':
      return schedule.weekdays.includes(parts.weekday) && parts.hour === schedule.hour && parts.minute === schedule.minute;
    case 'monthly':
      return parts.day === schedule.dayOfMonth && parts.hour === schedule.hour && parts.minute === schedule.minute;
    case 'custom_cron':
      return parsedCron.minutes.has(parts.minute)
        && parsedCron.hours.has(parts.hour)
        && parsedCron.days.has(parts.day)
        && parsedCron.months.has(parts.month)
        && parsedCron.weekdays.has(parts.weekday);
    default:
      return false;
  }
}

/** Returns the first scheduled instant strictly after afterIso. */
export function nextAutomationOccurrence(schedule, afterIso) {
  validateAutomationSchedule(schedule);
  const afterMs = Date.parse(afterIso);
  if (!Number.isFinite(afterMs)) throw new TypeError('afterIso must be an ISO timestamp');
  if (schedule.kind === 'once') {
    const onceMs = Date.parse(schedule.onceAt);
    return onceMs > afterMs ? new Date(onceMs).toISOString() : null;
  }
  const parsedCron = schedule.kind === 'custom_cron' ? parseAutomationCron(schedule.cron) : null;
  const afterWall = wallKey(zonedParts(afterMs, schedule.timezone));
  let cursor = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let count = 0; count < MAX_SEARCH_MINUTES; count += 1, cursor += MINUTE_MS) {
    const parts = zonedParts(cursor, schedule.timezone);
    if (wallKey(parts) === afterWall) continue; // suppress duplicate wall time during DST fallback
    if (scheduleMatches(schedule, parts, parsedCron)) return new Date(cursor).toISOString();
  }
  return null;
}

export function automationOccurrences(schedule, { after, count = 3 } = {}) {
  assertInteger(count, 1, 100, 'count');
  const result = [];
  let cursor = after || new Date().toISOString();
  for (let index = 0; index < count; index += 1) {
    const next = nextAutomationOccurrence(schedule, cursor);
    if (!next) break;
    result.push(next);
    cursor = next;
  }
  return result;
}

export function latestAutomationOccurrence(schedule, { after, at } = {}) {
  validateAutomationSchedule(schedule);
  const afterMs = Date.parse(after);
  const atMs = Date.parse(at);
  if (!Number.isFinite(afterMs) || !Number.isFinite(atMs)) throw new TypeError('after and at must be ISO timestamps');
  if (atMs <= afterMs) return null;
  if (schedule.kind === 'once') {
    const onceMs = Date.parse(schedule.onceAt);
    return onceMs > afterMs && onceMs <= atMs ? new Date(onceMs).toISOString() : null;
  }
  const parsedCron = schedule.kind === 'custom_cron' ? parseAutomationCron(schedule.cron) : null;
  let cursor = Math.floor(atMs / MINUTE_MS) * MINUTE_MS;
  for (let count = 0; count < MAX_SEARCH_MINUTES && cursor > afterMs; count += 1, cursor -= MINUTE_MS) {
    const parts = zonedParts(cursor, schedule.timezone);
    if (scheduleMatches(schedule, parts, parsedCron)) return new Date(cursor).toISOString();
  }
  return null;
}
