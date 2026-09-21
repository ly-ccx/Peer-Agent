#!/usr/bin/env node
// 失效轴核验：用真实账本数据 + 真实 evaluateUiDelivery，验证「旧构建 / 旧实例 / 计划已变更 / 跨宿主顶替」
// 会让一个原本通过的判定失效（gap = observation-stale）。
//
// 为什么不做成「看屏幕」的实验：桌面侧的失效触发条件是**构建或实例身份变化**，不是某个界面动作，
// 屏幕上没有可观察的事件。真正需要证明的是判定链的因果，而不是画面。所以这里直接喂真实账本快照给
// 生产函数，逐条变更身份字段，看它是否如契约那样拒绝。
//
// 与 packages/protocol/src/ui-delivery-verification.test.ts 的关系：那个 .ts 测试覆盖同样的轴，但本机
// Node v22.14 跑不了 .ts（缺原生类型剥离，且本机无 nvm）。本脚本跑的是**同一份生产逻辑的构建产物**，
// 数据来自**真实实验室账本**，因此是可执行的真实证据，而不是复述断言。
//
// 用法：node apps/desktop/scripts/lab-stale-evidence-check.mjs [--lab-home PATH]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { evaluateUiDelivery } from '@peer-agent/protocol';

const DEFAULT_LAB_HOME = path.join(os.homedir(), '.peer-agent-lab');
const LEDGER_RE = /^[0-9a-f]{64}\.json$/;

function resolveHost(ledger, observation) {
  if (ledger.host === 'web' || ledger.host === 'desktop') return ledger.host;
  if (observation.host === 'web' || observation.host === 'desktop') return observation.host;
  if ((ledger.scene ?? observation.scene) === 'application') return 'web';
  return 'desktop';
}

// 从真实账本里取出「已被通过的判定绑定到最新观察」的快照。
function loadPassedSnapshots(labHome) {
  const ledgerDir = path.join(labHome, 'ui-delivery');
  if (!fs.existsSync(ledgerDir)) return [];
  const snapshots = [];
  for (const name of fs.readdirSync(ledgerDir).filter((entry) => LEDGER_RE.test(entry))) {
    let ledger;
    try {
      ledger = JSON.parse(fs.readFileSync(path.join(ledgerDir, name), 'utf8'));
    } catch {
      continue;
    }
    const observations = Array.isArray(ledger.observations) ? ledger.observations : [];
    const judgments = Array.isArray(ledger.judgments) ? ledger.judgments : [];
    const latest = observations[observations.length - 1];
    if (!latest) continue;
    const passing = judgments.find(
      (entry) => entry.decision === 'passed' && entry.observationRef === latest.evidenceRef,
    );
    if (!passing) continue;
    snapshots.push({ ledger, latest, passing, ledgerFile: name });
  }
  return snapshots;
}

function runCase(snapshot, mutate) {
  const host = resolveHost(snapshot.ledger, snapshot.latest);
  const observation = {
    ...snapshot.latest,
    requirementId: snapshot.latest.requirementId ?? 'ui-artifact',
    host,
    // read() 会把准入值派生为「绑定该判定的那次模型运行」；这里照契约补上，
    // 否则 baseline 会因为 image-not-admitted 失败，与本次要验证的失效轴无关。
    admittedToRunId: snapshot.passing.modelRunId,
  };
  const requirement = {
    id: observation.requirementId,
    host,
    requirementRevision: observation.requirementRevision,
    buildFingerprint: observation.buildFingerprint,
    instanceId: observation.instanceId,
  };
  const mutated = mutate ? mutate({ requirement: { ...requirement }, observation: { ...observation } }) : {};
  const result = evaluateUiDelivery(
    [mutated.requirement ?? requirement],
    [mutated.observation ?? observation],
    [snapshot.passing],
    new Set([observation.evidenceRef, snapshot.passing.evidenceRef]),
  );
  return { passed: result.passed, gaps: result.gaps.map((gap) => gap.reason) };
}

const CASES = [
  {
    id: 'baseline',
    label: '原样（对照）',
    expect: 'passed',
    mutate: null,
  },
  {
    id: 'stale-build',
    label: '旧构建（buildFingerprint 变）',
    expect: 'observation-stale',
    mutate: ({ requirement }) => {
      requirement.buildFingerprint = `${requirement.buildFingerprint}-rebuilt`;
      return { requirement };
    },
  },
  {
    id: 'stale-instance',
    label: '旧实例（instanceId 变）',
    expect: 'observation-stale',
    mutate: ({ requirement }) => {
      requirement.instanceId = '00000000-0000-4000-8000-000000000000';
      return { requirement };
    },
  },
  {
    id: 'stale-revision',
    label: '计划已变更（requirementRevision 变）',
    expect: 'observation-stale',
    mutate: ({ requirement }) => {
      requirement.requirementRevision = `${requirement.requirementRevision}-revised`;
      return { requirement };
    },
  },
  {
    id: 'stale-host-swap',
    label: '跨宿主顶替（只改要求方 host）',
    expect: 'observation-stale',
    // 威胁模型是「实时要求是 A 宿主，但证据来自 B 宿主」。两边同时翻转会互相抵消，
    // 那就变成 baseline 了——第一次写错的就是这一点。
    mutate: ({ requirement }) => {
      requirement.host = requirement.host === 'web' ? 'desktop' : 'web';
      return { requirement };
    },
  },
];

function main() {
  const argv = process.argv.slice(2);
  let labHome = process.env.PEER_LAB_HOME ?? DEFAULT_LAB_HOME;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--lab-home') labHome = argv[++index];
  }

  const snapshots = loadPassedSnapshots(labHome);
  if (snapshots.length === 0) {
    process.stderr.write(`没有找到「已通过」的账本快照：${labHome}/ui-delivery\n`);
    process.exit(2);
  }

  let failures = 0;
  const lines = [];
  lines.push(`实验室账本: ${labHome}`);
  lines.push(`已通过快照: ${snapshots.length} 份`);
  lines.push('');
  const header = ['plan'.padEnd(9), 'host'.padEnd(8), ...CASES.map((entry) => entry.id.padEnd(17))].join(' ');
  lines.push(header);

  for (const snapshot of snapshots) {
    const planId = String(snapshot.ledger.planId ?? '').slice(0, 8);
    const host = resolveHost(snapshot.ledger, snapshot.latest);
    const cells = [];
    for (const testCase of CASES) {
      const outcome = runCase(snapshot, testCase.mutate);
      let ok;
      if (testCase.expect === 'passed') ok = outcome.passed === true;
      else ok = outcome.passed === false && outcome.gaps.includes(testCase.expect);
      if (!ok) failures += 1;
      cells.push(`${ok ? 'ok' : 'FAIL'}:${(outcome.gaps.join(',') || 'passed').slice(0, 14)}`.padEnd(17));
    }
    lines.push([planId.padEnd(9), host.padEnd(8), ...cells].join(' '));
  }

  lines.push('');
  lines.push('期望：baseline 通过；其余四条均以 observation-stale 被拒。');
  lines.push(failures === 0 ? '结果：全部符合契约。' : `结果：${failures} 个格子不符合契约。`);
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
