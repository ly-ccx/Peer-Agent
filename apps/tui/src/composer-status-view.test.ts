import { describe, expect, test } from 'bun:test';

import { contextMeter, contextMeterParts } from './composer-status-view.tsx';

describe('composer context meter', () => {
  test('renders bounded used and remaining cells', () => {
    expect(contextMeter(25, 8)).toBe('━━──────');
    expect(contextMeter(150, 4)).toBe('━━━━');
    expect(contextMeter(undefined, 4)).toBe('────');
  });

  test('splits filled and empty segments for dual-tone rendering', () => {
    expect(contextMeterParts(25, 8)).toEqual({ filled: '━━', empty: '──────' });
    expect(contextMeterParts(150, 4)).toEqual({ filled: '━━━━', empty: '' });
    expect(contextMeterParts(undefined, 4)).toEqual({ filled: '', empty: '────' });
  });
});
