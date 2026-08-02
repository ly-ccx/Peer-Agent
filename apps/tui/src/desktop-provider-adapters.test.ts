import { describe, expect, test } from 'bun:test';

import { ensureFreshGoogleTokensFromDesktop } from './desktop-provider-adapters.ts';

describe('shared provider host seam', () => {
  test('unwraps the shared Google refresh envelope for TUI callers', async () => {
    const tokens = {
      access: 'fresh-access',
      refresh: 'refresh-token',
      expires: Date.now() + 300_000,
      accountId: 'account-1',
    };
    let fetchCalls = 0;

    const fetchImpl = Object.assign(
      async () => {
        fetchCalls += 1;
        throw new Error('fresh tokens must not trigger a network refresh');
      },
      { preconnect: () => {} },
    ) as typeof fetch;

    const fresh = await ensureFreshGoogleTokensFromDesktop(tokens, { fetchImpl });

    expect(fresh).toEqual(tokens);
    expect('tokens' in fresh).toBe(false);
    expect(fetchCalls).toBe(0);
  });
});
