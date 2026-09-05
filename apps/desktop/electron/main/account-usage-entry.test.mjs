import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchProviderAccountUsage } from './account-usage.mjs';

test('entry/runtime-export-and-main-ipc-binding', () => {
  const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.match(main, /import \{ fetchProviderAccountUsage as fetchProviderSubscriptionQuota \} from '\.\/account-usage\.mjs'/);
  assert.equal(typeof fetchProviderAccountUsage, 'function');
});

test('entry/missing-provider/real-composition-no-credential-or-network', async () => {
  assert.deepEqual(await fetchProviderAccountUsage({ providerId: 'absent', llmConfigStore: { listProviders: () => [] } }), { success: false, status: 'provider_not_found' });
});
