import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatTime, formatDuration, formatBytes, formatTokenCount } from './format.ts';

describe('formatDuration', () => {
  it('clamps negative to 0ms', () => {
    assert.equal(formatDuration(-5), '0ms');
  });
  it('shows ms below 1s', () => {
    assert.equal(formatDuration(0), '0ms');
    assert.equal(formatDuration(999), '999ms');
  });
  it('shows one decimal second below 10s', () => {
    assert.equal(formatDuration(1000), '1.0s');
    assert.equal(formatDuration(1240), '1.2s');
    assert.equal(formatDuration(9949), '9.9s');
  });
  it('shows whole seconds from 10s to under 60s', () => {
    assert.equal(formatDuration(10_000), '10s');
    assert.equal(formatDuration(59_000), '59s');
  });
  it('shows minutes+padded seconds under 60m', () => {
    assert.equal(formatDuration(60_000), '1m00s');
    assert.equal(formatDuration(192_000), '3m12s');
    assert.equal(formatDuration(3_599_000), '59m59s');
  });
  it('shows hours+padded minutes from 60m', () => {
    assert.equal(formatDuration(3_600_000), '1h00m');
    assert.equal(formatDuration(3_780_000), '1h03m');
  });
});

describe('formatBytes', () => {
  it('shows raw bytes below 1KB', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1023), '1023 B');
  });
  it('shows KB with one decimal below 1MB', () => {
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
  });
  it('shows MB with one decimal from 1MB', () => {
    assert.equal(formatBytes(1024 * 1024), '1.0 MB');
    assert.equal(formatBytes(1024 * 1024 * 2.5), '2.5 MB');
  });
});

describe('formatTokenCount', () => {
  it('shows raw count below 1000', () => {
    assert.equal(formatTokenCount(0), '0');
    assert.equal(formatTokenCount(999), '999');
  });
  it('shows k with one decimal from 1000', () => {
    assert.equal(formatTokenCount(1000), '1.0k');
    assert.equal(formatTokenCount(1500), '1.5k');
    assert.equal(formatTokenCount(12_340), '12.3k');
  });
});

describe('formatTime', () => {
  it('returns time-only for same-day timestamp', () => {
    const now = Date.now();
    const expected = new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    assert.equal(formatTime(now), expected);
  });
  it('prepends month/day for a different day', () => {
    const now = new Date();
    const other = new Date(now);
    other.setDate(other.getDate() - 5);
    const result = formatTime(other.getTime());
    const datePart = other.toLocaleDateString([], { month: 'short', day: 'numeric' });
    assert.ok(result.startsWith(datePart), `expected "${result}" to start with "${datePart}"`);
  });
});
