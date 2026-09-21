#!/usr/bin/env node
// 矩阵审计：以磁盘账本为唯一事实，判出 UI 验收矩阵每一格的真实状态。
//
// 为什么需要它：文档与记忆都会写错。本轮实测就发现文档把 WEB-STALE 记成「缺失」，
// 而账本里 29f9647d 明明写着 invalidatedReason=web-page-changed:navigate。
// 运行时真正写下的事实只有四类文件：
//   1. ui-delivery/<sha256(planId)>.json —— 要求 / 观察 / 判定（本章的判据来源）
//   2. goal-plans/<planId>.json          —— 计划状态与任务（是否被允许收尾）
//   3. goal-plans/evidence-index.jsonl   —— 证据索引（观察是否真的入索引）
//   4. conversations/<id>.jsonl          —— 工具回执（授权被拒等无账本的情形）
//
// 判定规则（每条都只用上述事实，不做猜测；推断出的字段会明确标注 certainty）：
//   BLOCK      : 无账本 + 会话里有该计划的 permission-denied 回执
//   STALE      : 有 invalidatedReason，或最新判定绑定的是更早的一次捕捉
//   REPAIR     : 失败判定之后又有通过判定，且通过判定绑在「不同产物」上（即修完重拍）
//   PASS       : 最新判定通过且绑在最新观察上，且该观察已入证据索引
//   UNVERIFIED : 有观察但没有任何判定（拍了却没人复核）
//   FAILED     : 有判定但不通过，且不是被新捕捉取代
//
// 用法：
//   node apps/desktop/scripts/lab-matrix-audit.mjs            # 人类可读表格
//   node apps/desktop/scripts/lab-matrix-audit.mjs --json     # 机器可读

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_LAB_HOME = path.join(os.homedir(), '.peer-agent-lab');
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const LEDGER_RE = /^[0-9a-f]{64}\.json$/;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listFiles(directory, predicate) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => predicate(name))
    .map((name) => path.join(directory, name));
}

// 场景 → 宿主：application 是网页，background-runtime 是桌面。
// 早于「宿主声明」的账本没有 host 字段，这里按场景推断并标注 inferred。
function resolveHost(ledger) {
  if (ledger.host === 'web' || ledger.host === 'desktop') {
    return { host: ledger.host, certainty: 'declared' };
  }
  const scene = ledger.scene ?? '';
  if (scene === 'application') return { host: 'web', certainty: 'inferred' };
  if (scene === 'background-runtime') return { host: 'desktop', certainty: 'inferred' };
  return { host: 'unknown', certainty: 'unknown' };
}

function loadIndexedEvidence(labHome) {
  const file = path.join(labHome, 'goal-plans', 'evidence-index.jsonl');
  const indexed = new Set();
  if (!fs.existsSync(file)) return { indexed, entryCount: 0, present: false };
  let entryCount = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    entryCount += 1;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // 索引条目的 ref 形状在不同版本略有差异，宽松取所有像是引用的字段。
    for (const key of ['ref', 'evidenceRef', 'artifactRef', 'url', 'id']) {
      const value = entry?.[key];
      if (typeof value === 'string' && value) indexed.add(value);
    }
    const blob = JSON.stringify(entry);
    for (const match of blob.matchAll(/local-(?:desktop-preview|web-ui)-artifact:\/\/[0-9a-f-]{8,}/g)) {
      indexed.add(match[0]);
    }
  }
  return { indexed, entryCount, present: true };
}

function isIndexed(indexed, ref) {
  if (!ref) return false;
  if (indexed.has(ref)) return true;
  const bare = ref.replace(/^local-(?:desktop-preview|web-ui)-artifact:\/\//, '');
  for (const candidate of indexed) {
    if (candidate.endsWith(bare) || candidate.endsWith(ref)) return true;
  }
  return false;
}

function classifyLedger(ledger, indexed) {
  const { host, certainty } = resolveHost(ledger);
  const observations = Array.isArray(ledger.observations) ? ledger.observations : [];
  const judgments = Array.isArray(ledger.judgments) ? ledger.judgments : [];
  const latest = observations[observations.length - 1] ?? null;
  const newestJudgment = judgments[judgments.length - 1] ?? null;
  const base = {
    planId: ledger.planId ?? null,
    conversationId: ledger.conversationId ?? null,
    host,
    hostCertainty: certainty,
    scene: ledger.scene ?? null,
    observationCount: observations.length,
    judgmentCount: judgments.length,
  };

  if (observations.length === 0) {
    if (ledger.invalidatedReason) {
      return { ...base, cell: `${host.toUpperCase()}-STALE`, status: 'STALE', detail: ledger.invalidatedReason };
    }
    return { ...base, cell: `${host.toUpperCase()}-UNKNOWN`, status: 'UNKNOWN', detail: '无观察记录' };
  }

  const latestArtifact = latest.artifactRef ?? null;
  const admitted = isIndexed(indexed, latestArtifact);
  const observedAt = latest.capturedAt ?? null;

  if (ledger.invalidatedReason) {
    return {
      ...base,
      cell: `${host.toUpperCase()}-STALE`,
      status: 'STALE',
      detail: ledger.invalidatedReason,
      latestArtifact,
      observedAt,
    };
  }

  if (judgments.length === 0) {
    return {
      ...base,
      cell: `${host.toUpperCase()}-UNVERIFIED`,
      status: 'UNVERIFIED',
      detail: '有观察，无判定',
      latestArtifact,
      observedAt,
      admitted,
    };
  }

  const passedOnLatest = judgments.find(
    (entry) => entry.decision === 'passed' && entry.observationRef === latest.evidenceRef,
  );
  const failures = judgments.filter((entry) => entry.decision !== 'passed');
  const superseded = newestJudgment && newestJudgment.observationRef !== latest.evidenceRef;

  if (superseded && !passedOnLatest) {
    return {
      ...base,
      cell: `${host.toUpperCase()}-STALE`,
      status: 'STALE',
      detail: '最新判定绑定的是更早的一次捕捉',
      latestArtifact,
      observedAt,
      admitted,
    };
  }

  if (passedOnLatest) {
    const repaired = failures.some(
      (entry) => entry.artifactRef && passedOnLatest.artifactRef && entry.artifactRef !== passedOnLatest.artifactRef,
    );
    const status = repaired ? 'REPAIR' : 'PASS';
    return {
      ...base,
      cell: `${host.toUpperCase()}-${status}`,
      status,
      detail: repaired
        ? '先有失败判定，随后在不同产物上通过（修完重拍）'
        : '最新判定通过且绑定最新观察',
      latestArtifact,
      observedAt,
      admitted,
      // 通过判定必须落在已入索引的证据上，否则不足以支撑完成声明。
      trustworthy: admitted === true,
    };
  }

  return {
    ...base,
    cell: `${host.toUpperCase()}-FAILED`,
    status: 'FAILED',
    detail: `最新判定为 ${newestJudgment?.decision ?? 'unknown'}`,
    latestArtifact,
    observedAt,
    admitted,
  };
}

// BLOCK 没有账本文件（权限在任何观察之前就被拒），只能从计划 + 会话回执识别。
function findBlocked(labHome, ledgerPlanIds) {
  const plansDir = path.join(labHome, 'goal-plans');
  const conversationsDir = path.join(labHome, 'conversations');
  const results = [];

  const deniedByConversation = new Map();
  for (const file of listFiles(conversationsDir, (name) => name.endsWith('.jsonl'))) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('permission-denied')) continue;
    const capabilities = new Set();
    for (const match of text.matchAll(/(local\.[a-z0-9._-]+)[^\n]{0,200}?permission-denied/g)) {
      capabilities.add(match[1]);
    }
    for (const match of text.matchAll(/permission-denied[^\n]{0,200}?(local\.[a-z0-9._-]+)/g)) {
      capabilities.add(match[1]);
    }
    deniedByConversation.set(path.basename(file, '.jsonl'), {
      file,
      capabilities: [...capabilities],
      mtime: fs.statSync(file).mtime.toISOString(),
    });
  }

  for (const file of listFiles(plansDir, (name) => name.endsWith('.json'))) {
    const plan = readJson(file);
    if (!plan?.planId) continue;
    if (plan.status === 'completed') continue;
    if (ledgerPlanIds.has(plan.planId)) continue;
    const denial = deniedByConversation.get(plan.conversationId);
    if (!denial) continue;
    const web = denial.capabilities.some((id) => id.startsWith('local.web'));
    results.push({
      planId: plan.planId,
      conversationId: plan.conversationId,
      host: web ? 'web' : 'desktop',
      hostCertainty: denial.capabilities.length > 0 ? 'declared' : 'inferred',
      cell: `${web ? 'WEB' : 'DESKTOP'}-BLOCK`,
      status: 'BLOCK',
      detail: `permission-denied（${denial.capabilities.join(', ') || 'capability 未解析'}）；计划 ${plan.status}`,
      planStatus: plan.status,
      observedAt: denial.mtime,
    });
  }
  return results;
}

function audit(labHome) {
  const ledgerDir = path.join(labHome, 'ui-delivery');
  const { indexed, entryCount, present } = loadIndexedEvidence(labHome);

  const ledgers = [];
  for (const file of listFiles(ledgerDir, (name) => LEDGER_RE.test(name))) {
    const ledger = readJson(file);
    if (!ledger) continue;
    ledgers.push({ file: path.basename(file), ledger });
  }

  const cells = ledgers.map(({ ledger, file }) => ({ ...classifyLedger(ledger, indexed), ledgerFile: file }));
  const ledgerPlanIds = new Set(cells.map((cell) => cell.planId).filter(Boolean));
  const blocked = findBlocked(labHome, ledgerPlanIds);
  const all = [...cells, ...blocked];

  // 每一格汇总：同一格可能有多条记录，取最新一条作为该格结论。
  const byCell = new Map();
  for (const entry of all) {
    const current = byCell.get(entry.cell);
    if (!current) byCell.set(entry.cell, entry);
  }

  return {
    labHome,
    evidenceIndex: { present, entryCount },
    ledgerCount: cells.length,
    cells: all,
    summary: [...byCell.values()].sort((a, b) => a.cell.localeCompare(b.cell)),
  };
}

function renderHuman(result) {
  const lines = [];
  lines.push(`实验账本目录: ${result.labHome}`);
  lines.push(`证据索引: ${result.evidenceIndex.present ? `${result.evidenceIndex.entryCount} 条` : '缺失'}`);
  lines.push(`账本文件: ${result.ledgerCount} 份`);
  lines.push('');
  lines.push(
    ['time'.padEnd(17), 'plan'.padEnd(9), 'conv'.padEnd(9), 'host'.padEnd(9), 'obs', 'jud', 'cell'.padEnd(20), 'ok', 'detail'].join(' '),
  );
  for (const entry of result.cells) {
    const time = (entry.observedAt ?? '').slice(5, 16).padEnd(17);
    const plan = String(entry.planId ?? '').slice(0, 8).padEnd(9);
    const conv = String(entry.conversationId ?? '').slice(0, 8).padEnd(9);
    const host = `${entry.host}${entry.hostCertainty === 'inferred' ? '?' : ''}`.padEnd(9);
    const obs = String(entry.observationCount ?? '-').padEnd(3);
    const jud = String(entry.judgmentCount ?? '-').padEnd(3);
    const cell = entry.cell.padEnd(20);
    const ok = entry.trustworthy === false ? 'NO' : entry.trustworthy === true ? 'yes' : '-';
    lines.push([time, plan, conv, host, obs, jud, cell, ok.padEnd(3), entry.detail ?? ''].join(' '));
  }
  lines.push('');
  lines.push('=== 每格结论（同格取最新一条）===');
  for (const entry of result.summary) {
    lines.push(`  ${entry.cell.padEnd(22)} ${String(entry.planId ?? '').slice(0, 8)}  ${entry.detail ?? ''}`);
  }
  lines.push('');
  lines.push('注：host 带 ? 表示该账本早于「宿主声明」字段，按 scene 推断。');
  lines.push('注：ok=NO 表示通过判定所绑定的证据未在证据索引中，不足以支撑完成声明。');
  return `${lines.join('\n')}\n`;
}

function main() {
  const argv = process.argv.slice(2);
  let labHome = process.env.PEER_LAB_HOME ?? DEFAULT_LAB_HOME;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--lab-home') labHome = argv[++index];
  }
  const result = audit(labHome);
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(renderHuman(result));
}

main();
