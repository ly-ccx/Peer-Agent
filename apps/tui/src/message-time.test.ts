import { expect, test } from 'bun:test';

import { formatMessageTime } from './message-time.ts';

test('message time is hour and minute for today, and adds the date for older days', () => {
  const now = new Date(2026, 6, 23, 16, 9).getTime();
  expect(formatMessageTime(new Date(2026, 6, 23, 16, 9).getTime(), now)).toBe(
    new Date(2026, 6, 23, 16, 9).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
  );
  const older = formatMessageTime(new Date(2026, 6, 22, 16, 9).getTime(), now);
  expect(older).toContain(new Date(2026, 6, 22, 16, 9).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  expect(older).not.toBe(new Date(2026, 6, 22, 16, 9).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
});
