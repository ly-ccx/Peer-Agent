/**
 * 只读冒烟：用真实 usage/requests.jsonl 验证「按 Provider」归组修复。
 * - before：不传 providerIndex（复现修复前：裸 uuid 各占一行）
 * - after：传 providerIndex（方案 A：uuid 归一到渠道 groupId）
 * 校验：Qoder CLI 收敛为单行，且 token 总量不变。
 * 不写任何文件。
 */
import { readFileSync } from 'node:fs';
import { aggregateRequestUsage, buildProviderIndex } from '../apps/desktop/electron/main/usage-stats.mjs';

const HOME = process.env.HOME;
const requestsPath = `${HOME}/.peer-agent/usage/requests.jsonl`;
const configPath = `${HOME}/.peer-agent/llm-providers.json`;

const requests = readFileSync(requestsPath, 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter(Boolean);

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const channelName = new Map((config.channels || []).map((c) => [c.groupId || c.id, c.name]));
// 模拟 llmConfigStore.listProviders() 的模型级记录形状：id=条目 uuid，groupId=渠道 uuid。
const providers = (config.models || []).map((m) => ({
  id: m.id,
  groupId: m.groupId,
  name: channelName.get(m.groupId) || m.groupId,
  model: m.model,
}));

const sum = (agg) => [...agg.byProvider.values()].reduce((acc, row) => ({
  requests: acc.requests + row.requestCount,
  input: acc.input + row.inputTokens,
  output: acc.output + row.outputTokens,
  cacheRead: acc.cacheRead + row.cacheReadTokens,
  cacheWrite: acc.cacheWrite + row.cacheWriteTokens,
}), { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

const before = aggregateRequestUsage(requests);
const after = aggregateRequestUsage(requests, { providerIndex: buildProviderIndex(providers) });

console.log(`rows=${requests.length}`);
console.log(`before: providerRows=${before.byProvider.size}`);
console.log(`after : providerRows=${after.byProvider.size}`);

const label = (agg, key) => [...agg.byProvider.values()].find((r) => r.key === key)?.label;
const qoderKeysBefore = [...before.byProvider.values()].filter((r) => r.label === 'Qoder CLI').length;
const qoderKeysAfter = [...after.byProvider.values()].filter((r) => r.label === 'Qoder CLI').length;
console.log(`before: "Qoder CLI" rows=${qoderKeysBefore}`);
console.log(`after : "Qoder CLI" rows=${qoderKeysAfter} (key=${[...after.byProvider.keys()].find((k) => after.byProvider.get(k).label === 'Qoder CLI')})`);

console.log('\nafter byProvider:');
for (const row of [...after.byProvider.values()].sort((a, b) => b.totalTokens - a.totalTokens)) {
  console.log(`  ${row.label.padEnd(24)} key=${row.key.slice(0, 36)} reqs=${row.requestCount} in=${row.inputTokens} out=${row.outputTokens} total=${row.totalTokens}`);
}

const sb = sum(before); const sa = sum(after);
console.log('\ntotals before:', sb);
console.log('totals after :', sa);
const totalsUnchanged = JSON.stringify(sb) === JSON.stringify(sa);
console.log(`\nRESULT: qoder_single_row=${qoderKeysAfter === 1} totals_unchanged=${totalsUnchanged}`);
if (qoderKeysAfter !== 1 || !totalsUnchanged) process.exit(1);
