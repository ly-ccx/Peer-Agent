import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { probeCloudContracts } from '../apps/desktop/electron/main/cloud-contract-probe.mjs';
import { loadDotenv } from './load-dotenv.mjs';
import { PROD_E2E_REQUIRED_CHECKS } from './prod-e2e-checks.mjs';

const REQUIRED_BRANCH = 'dev/0.0.1';
loadDotenv();

function usage() {
  console.error('Usage: pnpm prod-e2e:create-report --tester <work_id> --out <report.json> [--with-contract-probe] [--force]');
  process.exit(1);
}

function parseArgs(argv) {
  const result = { force: false, withContractProbe: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--force') {
      result.force = true;
      continue;
    }
    if (item === '--with-contract-probe') {
      result.withContractProbe = true;
      continue;
    }
    if (item === '--tester') {
      result.testerWorkId = argv[index + 1];
      index += 1;
      continue;
    }
    if (item === '--out') {
      result.out = argv[index + 1];
      index += 1;
      continue;
    }
    usage();
  }
  if (!result.testerWorkId || !result.out) usage();
  return result;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

const args = parseArgs(process.argv.slice(2));
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== REQUIRED_BRANCH) {
  console.error(`Prod E2E report must be created on ${REQUIRED_BRANCH}, got ${branch}`);
  process.exit(1);
}

const status = git(['status', '--porcelain']);
if (status.length > 0) {
  console.error('Prod E2E report must be created from a clean worktree.');
  process.exit(1);
}

const reportPath = resolve(args.out);
if (existsSync(reportPath) && !args.force) {
  console.error(`Report already exists: ${reportPath}. Use --force to overwrite.`);
  process.exit(1);
}

const checks = Object.fromEntries(
  PROD_E2E_REQUIRED_CHECKS.map((checkId) => [checkId, { status: 'pending', evidence: '' }]),
);

const cloudContractProbe = args.withContractProbe
  ? await probeCloudContracts()
  : undefined;

const report = {
  reportVersion: '1',
  branch,
  commit: git(['rev-parse', '--short', 'HEAD']),
  environment: 'prod',
  testerWorkId: args.testerWorkId,
  startedAt: new Date().toISOString(),
  finishedAt: '',
  checks,
  ...(cloudContractProbe ? { cloudContractProbe } : {}),
};

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Prod E2E report initialized: ${reportPath}`);
