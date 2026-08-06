import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name: string) => readFile(new URL(name, import.meta.url), 'utf8');

test('Automation detail exposes the latest Run result without opening the conversation', async () => {
  const center = await read('./AutomationCenter.tsx');
  assert.match(center, /const latestRun = summary\.activeRun \?\? summary\.latestRun \?\? runs\[0\]/);
  assert.match(center, /className="automation-panel wide automation-latest-result"/);
  assert.match(center, /latestRun\?\.receipt\?\.summary/);
  assert.match(center, /onClick=\{\(\) => onOpenRun\(latestRun\)\}/);
});

test('Run receipt displays the bounded comparison with the previous result', async () => {
  const center = await read('./AutomationCenter.tsx');
  assert.match(center, /receipt\?\.previousSummary/);
  assert.match(center, /receipt\.resultChanged \? copy\.resultChanged : copy\.resultUnchanged/);
  assert.match(center, /className="automation-panel wide automation-comparison"/);
});

test('Automation Center refreshes Runs and the selected receipt on update broadcasts', async () => {
  const center = await read('./AutomationCenter.tsx');
  assert.match(center, /clientApi\.automationRunsList\(\{ automationId: selectedId, limit: 100 \}\)/);
  assert.match(center, /clientApi\.automationRunsGet\(\{ runId: selectedRun\.runId \}\)/);
});
