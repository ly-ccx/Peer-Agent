import { expect, test } from 'bun:test';
import { everydaySessions } from './project-copy.ts';

test('the everyday task list omits the internal obligation index', () => {
  const rows = everydaySessions([
    { title: 'still followed', followUp: { reason: 'stop_unconfirmed' } },
    { title: 'retired', followUp: { reason: 'obligation_indexed' } },
    { title: 'legacy' },
  ]);
  expect(rows.map(row => row.title)).toEqual(['still followed', 'legacy']);
});
