import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_TYPEWRITER_OPTIONS,
  typewriterChunkSize,
} from './useTypewriterStream.ts';

describe('typewriter stream pacing', () => {
  it('uses a smooth default cadence without returning to frame-rate updates', () => {
    assert.deepEqual(DEFAULT_TYPEWRITER_OPTIONS, {
      minCharsPerFrame: 1,
      maxCharsPerFrame: 80,
      framesToDrain: 10,
      minIntervalMs: 40,
    });
    assert.ok(DEFAULT_TYPEWRITER_OPTIONS.minIntervalMs > 16);
  });

  it('emits small chunks for a lightly buffered stream', () => {
    assert.equal(typewriterChunkSize(1), 1);
    assert.equal(typewriterChunkSize(10), 1);
    assert.equal(typewriterChunkSize(25), 3);
    assert.equal(typewriterChunkSize(100), 10);
  });

  it('caps large backlogs so one update cannot dump an oversized block', () => {
    assert.equal(typewriterChunkSize(800), 80);
    assert.equal(typewriterChunkSize(8_000), 80);
  });

  it('honors custom drain bounds', () => {
    const options = {
      minCharsPerFrame: 2,
      maxCharsPerFrame: 20,
      framesToDrain: 5,
      minIntervalMs: 50,
    };
    assert.equal(typewriterChunkSize(1, options), 2);
    assert.equal(typewriterChunkSize(50, options), 10);
    assert.equal(typewriterChunkSize(500, options), 20);
  });
});
