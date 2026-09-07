import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const suites = [
  'packages/runtime-node/src',
  'apps/desktop/electron/main',
].flatMap((dir) => readdirSync(new URL(`../${dir}/`, import.meta.url))
  .filter((name) => name.startsWith('account-usage-') && name.endsWith('.test.mjs'))
  .map((name) => `${dir}/${name}`));
suites.push(
  'apps/desktop/renderer/src/chat/components/thread/contextAccountUsageSummary.test.ts',
  'apps/desktop/renderer/src/chat/components/thread/contextAccountUsageRequest.test.ts',
  'apps/desktop/renderer/src/chat/components/thread/TokenUsageDisplay.test.ts',
  'apps/desktop/renderer/src/chat/components/thread/contextUsagePanelModel.test.ts',
  'apps/desktop/renderer/src/app/components/accountUsageView.test.ts',
  'apps/desktop/renderer/src/app/components/accountUsagePresentation.test.ts',
  'apps/desktop/renderer/src/app/components/accountUsageIdentity.test.ts',
  'apps/desktop/renderer/src/app/components/accountUsageRefresh.test.ts',
  'apps/desktop/renderer/src/app/components/accountUsageRequest.test.ts',
  'apps/desktop/renderer/src/app/components/accountUsageRequestOrder.test.ts',
  'apps/desktop/renderer/src/app/components/llmSubscriptionQuota.test.ts',
  'apps/desktop/electron/main/subscription-quota.test.mjs',
);
console.log('Account usage automated regression suite. Build runtime-node dependencies first.');
console.log('Passing tests do not certify unimplemented vendors, full cross-product coverage, visual QA, or live accounts.');
const result = spawnSync(process.execPath, ['--test', ...suites], { cwd: root, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
