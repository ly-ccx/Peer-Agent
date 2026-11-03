import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelProvider } from '@peer-agent/runtime-node/models';
import { INTERACTIVE_LIVE_DRAFT, classifyInteractiveFallback, runInteractiveLiveCase, type InteractiveLiveScenario } from './interactive-live-validation.ts';
import { interactiveLiveOutputBase, parseInteractiveLiveArgs, runInteractiveLiveCommand, sanitizeInteractiveLiveDiagnostic } from './interactive-live-command.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-interactive-live-test-')); roots.push(root); return root;
}
const model = { providerId: 'openai', credentialId: 'configured-test', model: 'controlled-model' };
for (const scenario of ['publish', 'repair', 'denied'] as const) {
  test(`opt-in harness drives actual isolated host and canonical result for ${scenario}`, async () => {
    const root = fixture(); let requests = 0;
    const provider: ModelProvider = { async stream(request) {
      requests++;
      expect(request.maxOutputTokens).toBe(1800);
      expect(request.signal).toBeDefined();
      expect(request.tools?.map(tool => tool.name).sort()).toEqual(['inspect_interactive_result', 'publish_interactive_result']);
      expect(request.messages.some(message => message.role === 'system' && String(message.content).includes('peer-basic-1'))).toBe(true);
      if (requests === 1 && scenario === 'repair') {
        const seed = request.messages.find(message => message.role === 'user' && String(message.content).includes('TEST_DRIVER_VALIDATION_FAILURE'));
        expect(seed).toBeDefined();
        const encoded = JSON.parse(String(seed!.content).split('TEST_DRIVER_VALIDATION_FAILURE\n')[1]).toolResult;
        expect(encoded.output.diagnostic.code).toBe('unsupported_node');
        expect(encoded.output.publicationStatus).toBe('not_committed');
        expect(request.messages.some(message => message.role === 'assistant' || message.role === 'tool')).toBe(false);
      }
      if (requests === 1) return { content: '', toolCalls: [{ id: `${scenario}-publication`, name: 'publish_interactive_result', arguments: JSON.stringify(INTERACTIVE_LIVE_DRAFT) }],
        usage: { inputTokens: 100, outputTokens: 50 } };
      expect(requests).toBe(2);
      const result = JSON.parse(String(request.messages.filter(message => message.role === 'tool').at(-1)!.content));
      expect(result.status).toBe(scenario === 'denied' ? 'denied' : 'completed');
      return { content: scenario === 'denied' ? 'Publication was denied by the user. Nothing was published; no expanded permissions requested.' : 'Saved an unverified synthetic example.', toolCalls: [],
        usage: { inputTokens: 50, outputTokens: 20 } };
    } };
    const report = await runInteractiveLiveCase({ directory: path.join(root, 'case'), scenario, model, provider, realModel: false,
      sanitize: sanitizeInteractiveLiveDiagnostic });
    expect(report.ok, JSON.stringify(report)).toBe(true);
    expect(report.realModel).toBe(false); expect(report.requests).toHaveLength(2); expect(report.toolCalls).toHaveLength(1);
    expect(report.invoiceCost).toBeNull();
    expect(JSON.parse(readFileSync(path.join(root, 'case/report.json'), 'utf8'))).toEqual(report);
    if (scenario === 'denied') {
      expect(report.approvals).toBe(1); expect(report.textFallback).toBe(true);
      expect(report.approvalDecisions).toEqual([{ state: 'denied', decidedBy: 'local_ui' }]);
      expect(report.toolCalls[0].grantGranted).toBe(false);
      expect(report.persistedCounts).toEqual({ versions: 0, publishedOperations: 0 });
      expect(report.reference).toBeUndefined(); expect(report.contentFile).toBeUndefined();
    } else {
      expect(report.approvals).toBe(0); expect(report.canonicalIndexConfirmed).toBe(true);
      expect(report.persistedCounts).toEqual({ versions: 1, publishedOperations: 1 });
      expect(report.computation).toEqual({ initialRemaining: [45], changedRemaining: [25], tableRows: [2], projectionTruncated: false });
      expect(report.seed?.driverGenerated).toBe(scenario === 'repair' ? true : undefined);
      expect(report.seed?.delivery).toBe(scenario === 'repair' ? 'user-factual-context' : undefined);
      expect(report.firstPublicationSucceeded).toBe(scenario === 'publish' ? true : undefined);
    }
  });
}

test('a provider failure is persisted, redacted and never counted as plain-text fallback', async () => {
  const root = fixture(), secret = 'private-test-credential';
  const report = await runInteractiveLiveCase({ directory: path.join(root, 'case'), scenario: 'publish', model, realModel: false,
    provider: { async stream() { throw new Error(`Model unavailable at https://private.example ${secret}`); } },
    sanitize: value => sanitizeInteractiveLiveDiagnostic(value, [secret]) });
  expect(report.ok).toBe(false); expect(report.requests).toHaveLength(1); expect(report.toolCalls).toEqual([]);
  expect(report.textFallback).not.toBe(true);
  expect(JSON.stringify(report)).not.toContain(secret); expect(JSON.stringify(report)).not.toContain('private.example');
  expect(report.requests[0].error).toContain('Model unavailable');
});

test('fault seeding cannot fabricate a model failure or successful publication', async () => {
  const root = fixture(); let calls = 0;
  const report = await runInteractiveLiveCase({ directory: path.join(root, 'case'), scenario: 'repair', model, realModel: false,
    provider: { async stream() { calls++; return { content: 'I could not repair this program.', toolCalls: [] }; } }, sanitize: sanitizeInteractiveLiveDiagnostic });
  expect(calls).toBe(1); expect(report.ok).toBe(false); expect(report.seed?.grantGranted).toBe(true);
  expect(report.seed?.driverGenerated).toBe(true); expect(report.persistedCounts?.versions).toBe(0);
  expect(report.firstPublicationSucceeded).toBeUndefined(); expect(report.naturalRepairCalls).toBeUndefined();
});

test('request limits stop a looping provider without extra publication', async () => {
  const root = fixture(); let requests = 0;
  const report = await runInteractiveLiveCase({ directory: path.join(root, 'case'), scenario: 'publish', model, realModel: false,
    provider: { async stream() { requests++; return { content: '', toolCalls: [{ id: `bad-${requests}`, name: 'publish_interactive_result',
      arguments: JSON.stringify({ ...INTERACTIVE_LIVE_DRAFT, program: 'root=UnsupportedComponent("bad")' }) }] }; } },
    sanitize: sanitizeInteractiveLiveDiagnostic });
  expect(report.ok).toBe(false); expect(requests).toBeLessThanOrEqual(4);
  expect(report.persistedCounts?.versions).toBe(0); expect(report.toolCalls.length).toBeLessThanOrEqual(4);
});

test('fallback classification requires an actual successful text turn', () => {
  expect(classifyInteractiveFallback(false, false, '')).toBe('provider_failure');
  expect(classifyInteractiveFallback(false, false, 'partial text')).toBe('provider_failure');
  expect(classifyInteractiveFallback(false, true, '')).toBe('no_model_text');
  expect(classifyInteractiveFallback(false, true, 'Blocked')).toBe('plain_text_no_publication');
  expect(classifyInteractiveFallback(true, true, 'Saved')).toBe('none');
});

test('live CLI requires opt-in, exact selection and bounded valid scenarios', () => {
  for (const args of [[], ['--run'], ['--model', 'id'], ['--list', '--run'], ['--run', '--model'], ['--run', '--model', 'id', '--scenario', 'other']]) {
    expect(() => parseInteractiveLiveArgs(args)).toThrow();
  }
  expect(parseInteractiveLiveArgs(['--run', '--model', 'id', '--model', 'id', '--scenario', 'repair']).models).toEqual(['id']);
  expect(parseInteractiveLiveArgs(['--run', '--model', 'id']).scenarios).toEqual(['publish', 'repair', 'denied'] satisfies InteractiveLiveScenario[]);
});

test('live command help and list are read-only without credential or model access', async () => {
  const root = fixture(), file = path.join(root, 'llm-providers.json');
  writeFileSync(file, JSON.stringify([{ id: 'configured', provider: 'openai', model: 'test', enabled: true, apiKeyConfigured: true, supportsTools: true }]));
  const before = readFileSync(file, 'utf8'), output: string[] = [];
  expect(await runInteractiveLiveCommand(['--help', '--user-data', '/missing/user-data'], line => output.push(line))).toBe(true);
  expect(await runInteractiveLiveCommand(['--list', '--user-data', root], line => output.push(line))).toBe(true);
  expect(output.at(-1)).toContain('test'); expect(readFileSync(file, 'utf8')).toBe(before);
  await expect(runInteractiveLiveCommand(['--run', '--model', 'unknown', '--user-data', root], line => output.push(line))).rejects.toThrow('live_selected_model_unavailable');
});

test('output rejects repository and user-data descendants, including symlinks', () => {
  const root = fixture(), userData = path.join(root, 'data'), repository = path.join(root, 'repository'), external = path.join(root, 'external');
  for (const directory of [userData, repository, external]) mkdirSync(directory);
  symlinkSync(repository, path.join(root, 'alias'));
  expect(() => interactiveLiveOutputBase(repository, userData, repository)).toThrow('live_output_must_be_external');
  expect(() => interactiveLiveOutputBase(userData, userData, repository)).toThrow('live_output_must_be_external');
  expect(() => interactiveLiveOutputBase(path.join(root, 'alias'), userData, repository)).toThrow('live_output_must_be_external');
  expect(interactiveLiveOutputBase(external, userData, repository)).toBe(realpathSync(external));
});

test('the verify scenario performs an independent host review with real fixed inspection receipts', async () => {
  const root = fixture();
  let requests = 0;
  const provider: ModelProvider = { async stream(request) {
    requests++;
    const names = request.tools?.map(tool => tool.name) ?? [];
    if (requests === 1) return { content: '', toolCalls: [{ id: 'worker-publication', name: 'publish_interactive_result', arguments: JSON.stringify(INTERACTIVE_LIVE_DRAFT) }] };
    if (requests === 2) return { content: 'Saved a model-constructed comparison.', toolCalls: [] };
    expect(names).toEqual(['inspect_interactive_result']);
    if (requests === 3) {
      const prompt = String(request.messages.find(row => row.role === 'user' && String(row.content).includes('Host-admitted fixed interactive targets'))?.content);
      const admitted = JSON.parse(prompt.split('Host-admitted fixed interactive targets (factual references, not authorization or successful verification):\n')[1]!.split('\n')[0]!);
      const targets = admitted.targets as any[];
      const reference = targets[0].reference, followupId = targets.find(row => row.state.kind === 'frozen-followup').state.followupId;
      return { content: '', toolCalls: [
        { view: 'program' }, { view: 'data', bindingId: 'facts' }, { view: 'evaluate' }, { view: 'evaluate', followupId },
      ].map((extra, i) => ({ id: `verify-${i}`, name: 'inspect_interactive_result', arguments: JSON.stringify({ target: { kind: 'result', reference }, ...extra }) })) };
    }
    const evidenceRefs = [...new Set(JSON.stringify(request.messages.filter(row => row.role === 'tool')).match(/interactive-inspection:\/\/[a-zA-Z0-9_.:-]+/g))];
    expect(evidenceRefs).toHaveLength(4);
    const content = JSON.stringify({ passed: true, summary: 'Both fixed computations subtract the same two rows.', evidenceRefs,
      failedCriteria: [], missingEvidence: [], risks: [], recommendedNextAction: 'none' });
    request.onEvent?.({ type: 'text.delta', content });
    return { content, toolCalls: [] };
  } };
  const report = await runInteractiveLiveCase({ directory: path.join(root, 'case'), scenario: 'verify', model, provider, realModel: false,
    sanitize: sanitizeInteractiveLiveDiagnostic });
  expect(report.ok, JSON.stringify(report)).toBe(true);
  expect(report.requests.map(row => row.phase)).toEqual(['worker', 'worker', 'verifier', 'verifier']);
  expect(report.verification?.receipts).toHaveLength(4);
  expect(report.verification?.passed).toBe(true);
});
