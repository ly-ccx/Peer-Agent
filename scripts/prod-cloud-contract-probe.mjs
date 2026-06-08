import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { probeCloudContracts } from '../apps/desktop/electron/main/cloud-contract-probe.mjs';
import { loadDotenv } from './load-dotenv.mjs';

loadDotenv();

function usage() {
  console.error('Usage: pnpm prod-e2e:probe-contract [--json] [--out <snapshot.json>]');
  process.exit(1);
}

function parseArgs(argv) {
  const args = { json: false, out: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--json') {
      args.json = true;
      continue;
    }
    if (item === '--out') {
      args.out = argv[index + 1];
      index += 1;
      continue;
    }
    usage();
  }
  if (args.out !== undefined && args.out.trim().length === 0) usage();
  return args;
}

function writeSnapshot(report, out) {
  if (!out) return;
  const absolutePath = resolve(out);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.error(`Prod cloud contract probe snapshot written: ${absolutePath}`);
}

const args = parseArgs(process.argv.slice(2));
const timeoutMs = Number(process.env.ZEUS_ATLAS_CONTRACT_PROBE_TIMEOUT_MS ?? 10_000);
const report = await probeCloudContracts({ timeoutMs });
writeSnapshot(report, args.out);

if (report.error) {
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.error(report.error);
  }
  process.exit(1);
}

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Prod cloud contract probe: ${report.origin}`);
  for (const result of report.results) {
    const status = result.status === undefined ? '-' : String(result.status);
    const duration = result.durationMs === undefined ? '' : ` ${result.durationMs}ms`;
    const error = result.error ? ` ${result.error}` : '';
    console.log(`[${result.class}] ${result.id}: ${result.method} ${result.path} -> ${status}${duration}${error}`);
  }
}

if (report.blockerCount > 0) {
  console.error(`Prod cloud contract probe failed: ${report.blockerCount} blocker(s).`);
  process.exit(1);
}

console.log('Prod cloud contract probe passed.');
