import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FileReadRangeError,
  formatNumberedLines,
  parseFileReadLineRange,
  sliceFileReadLines,
  splitFileLines,
} from './file-read-range.ts';

test('splitFileLines treats a trailing newline as the last line terminator', () => {
  assert.deepEqual(splitFileLines(''), []);
  assert.deepEqual(splitFileLines('a\nb'), ['a', 'b']);
  assert.deepEqual(splitFileLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitFileLines('a\n'), ['a']);
});

test('formatNumberedLines uses cat -n style alignment', () => {
  assert.equal(formatNumberedLines(['alpha', 'beta'], 9), ' 9\talpha\n10\tbeta');
  assert.equal(formatNumberedLines([], 1), '');
});

test('parseFileReadLineRange accepts missing, one-sided, and inclusive pairs', () => {
  assert.deepEqual(parseFileReadLineRange({}), {});
  assert.deepEqual(parseFileReadLineRange({ start_line: 2 }), { startLine: 2 });
  assert.deepEqual(parseFileReadLineRange({ end_line: 3 }), { endLine: 3 });
  assert.deepEqual(parseFileReadLineRange({ start_line: 2, end_line: 4 }), {
    startLine: 2,
    endLine: 4,
  });
});

test('parseFileReadLineRange rejects invalid bounds', () => {
  assert.throws(
    () => parseFileReadLineRange({ start_line: 0 }),
    (error: unknown) => error instanceof FileReadRangeError && error.code === 'invalid_line_range',
  );
  assert.throws(
    () => parseFileReadLineRange({ start_line: 4, end_line: 2 }),
    (error: unknown) => error instanceof FileReadRangeError && error.code === 'invalid_line_range',
  );
  assert.throws(
    () => parseFileReadLineRange({ start_line: 1.5 }),
    (error: unknown) => error instanceof FileReadRangeError && error.code === 'invalid_line_range',
  );
});

test('sliceFileReadLines keeps full unnumbered content when no range is set', () => {
  const slice = sliceFileReadLines('alpha\nbeta\n', {});
  assert.equal(slice.ranged, false);
  assert.equal(slice.content, 'alpha\nbeta\n');
  assert.equal(slice.totalLines, 2);
});

test('sliceFileReadLines numbers an inclusive range and keeps total_lines', () => {
  const slice = sliceFileReadLines('one\ntwo\nthree\nfour\n', { startLine: 2, endLine: 3 });
  assert.equal(slice.ranged, true);
  assert.equal(slice.content, '2\ttwo\n3\tthree');
  assert.equal(slice.startLine, 2);
  assert.equal(slice.endLine, 3);
  assert.equal(slice.totalLines, 4);
});

test('sliceFileReadLines fails when start_line is past the last line', () => {
  assert.throws(
    () => sliceFileReadLines('only\n', { startLine: 2 }),
    (error: unknown) => error instanceof FileReadRangeError && error.code === 'start_line_out_of_range',
  );
  const empty = sliceFileReadLines('', { startLine: 1 });
  assert.equal(empty.ranged, true);
  assert.equal(empty.content, '');
  assert.equal(empty.totalLines, 0);
});
