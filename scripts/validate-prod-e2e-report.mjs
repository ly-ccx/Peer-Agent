import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLOUD_CONTRACT_BLOCKER_CLASSES } from '../apps/desktop/electron/main/cloud-contract-probe.mjs';
import { PROD_E2E_REQUIRED_CHECKS } from './prod-e2e-checks.mjs';

const REQUIRED_BRANCH = 'dev/0.0.1';
const REQUIRED_REPORT_VERSION = '1';
const reportPath = process.argv[2];

if (!reportPath) {
  console.error('Usage: pnpm prod-e2e:validate <report.json>');
  process.exit(1);
}

const absolutePath = resolve(reportPath);
if (!existsSync(absolutePath)) {
  console.error(`Prod E2E report not found: ${absolutePath}`);
  process.exit(1);
}

const errors = [];
let report;

try {
  report = JSON.parse(readFileSync(absolutePath, 'utf8'));
} catch (error) {
  console.error(`Prod E2E report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

function requireString(key) {
  if (typeof report?.[key] !== 'string' || report[key].trim().length === 0) {
    errors.push(`missing non-empty string field: ${key}`);
  }
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

for (const key of ['reportVersion', 'branch', 'commit', 'environment', 'testerWorkId', 'startedAt', 'finishedAt']) {
  requireString(key);
}

if (report?.environment !== 'prod') {
  errors.push(`environment must be "prod", got ${JSON.stringify(report?.environment)}`);
}

if (report?.reportVersion !== REQUIRED_REPORT_VERSION) {
  errors.push(`reportVersion must be "${REQUIRED_REPORT_VERSION}", got ${JSON.stringify(report?.reportVersion)}`);
}

const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
if (currentBranch !== REQUIRED_BRANCH) {
  errors.push(`current branch must be "${REQUIRED_BRANCH}", got ${JSON.stringify(currentBranch)}`);
}

if (report?.branch !== REQUIRED_BRANCH) {
  errors.push(`branch must be "${REQUIRED_BRANCH}", got ${JSON.stringify(report?.branch)}`);
}

const currentCommit = git(['rev-parse', 'HEAD']);
if (typeof report?.commit === 'string' && !currentCommit.startsWith(report.commit.trim())) {
  errors.push(`commit must match current HEAD ${currentCommit.slice(0, 7)}, got ${JSON.stringify(report.commit)}`);
}

if (!report?.checks || typeof report.checks !== 'object' || Array.isArray(report.checks)) {
  errors.push('checks must be an object');
} else {
  for (const checkId of PROD_E2E_REQUIRED_CHECKS) {
    const check = report.checks[checkId];
    if (!check || typeof check !== 'object' || Array.isArray(check)) {
      errors.push(`missing check: ${checkId}`);
      continue;
    }
    if (check.status !== 'pass') {
      errors.push(`${checkId}: expected status "pass", got ${JSON.stringify(check.status)}`);
    }
    if (typeof check.evidence !== 'string' || check.evidence.trim().length === 0) {
      errors.push(`${checkId}: evidence must be a non-empty string`);
    }
  }
}

if (report?.cloudContractProbe !== undefined) {
  const probe = report.cloudContractProbe;
  if (!probe || typeof probe !== 'object' || Array.isArray(probe)) {
    errors.push('cloudContractProbe must be an object when present');
  } else {
    if (typeof probe.checkedAt !== 'string' || probe.checkedAt.trim().length === 0) {
      errors.push('cloudContractProbe.checkedAt must be a non-empty string');
    }
    if (typeof probe.blockerCount !== 'number') {
      errors.push('cloudContractProbe.blockerCount must be a number');
    } else if (probe.blockerCount !== 0) {
      errors.push(`cloudContractProbe.blockerCount must be 0 for production acceptance, got ${probe.blockerCount}`);
    }
    if (typeof probe.error === 'string' && probe.error.trim().length > 0) {
      errors.push(`cloudContractProbe.error must be empty for production acceptance, got ${JSON.stringify(probe.error)}`);
    }
    if (!Array.isArray(probe.results)) {
      errors.push('cloudContractProbe.results must be an array');
    } else {
      let computedBlockerCount = 0;
      for (const [index, result] of probe.results.entries()) {
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          errors.push(`cloudContractProbe.results[${index}] must be an object`);
          continue;
        }
        for (const key of ['id', 'method', 'path', 'class']) {
          if (typeof result[key] !== 'string' || result[key].trim().length === 0) {
            errors.push(`cloudContractProbe.results[${index}].${key} must be a non-empty string`);
          }
        }
        if (typeof result.class === 'string' && CLOUD_CONTRACT_BLOCKER_CLASSES.has(result.class)) {
          computedBlockerCount += 1;
          errors.push(`cloudContractProbe.results[${index}] ${result.id ?? '<unknown>'}: blocker class ${result.class}`);
        }
      }
      if (typeof probe.blockerCount === 'number' && probe.blockerCount !== computedBlockerCount) {
        errors.push(
          `cloudContractProbe.blockerCount mismatch: reported ${probe.blockerCount}, computed ${computedBlockerCount}`,
        );
      }
    }
  }
}

if (errors.length > 0) {
  console.error('Prod E2E report validation failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Prod E2E report validated: ${absolutePath}`);
