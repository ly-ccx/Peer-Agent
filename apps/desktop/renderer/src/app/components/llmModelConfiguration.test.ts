import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildModelCatalog,
  buildModelImportPatches,
  calculateModelSelectionChanges,
  filterModelCatalog,
  metadataSourceFromList,
  modelMetadataCompletion,
  modelMetadataPatch,
  parseReasoningEffortMap,
  updateModelOptionSelection,
} from './llmModelConfiguration.ts';

describe('LLM model configuration rules', () => {
  it('deduplicates a remote catalog and marks configured models', () => {
    const catalog = buildModelCatalog([
      { id: 'model-a', label: 'Model A' },
      { id: 'model-a', label: 'Duplicate A' },
      { id: 'model-b', label: 'Model B' },
      { id: '  ', label: 'Empty' },
    ], [{ model: 'model-b' }]);

    assert.deepEqual(catalog.map((entry) => [entry.model.id, entry.configured]), [
      ['model-a', false],
      ['model-b', true],
    ]);
  });

  it('calculates additions, metadata refreshes, and removals from the complete catalog selection', () => {
    const configured = [
      { id: 'record-a', model: 'model-a' },
      { id: 'record-b', model: 'model-b' },
    ] as never;
    const changes = calculateModelSelectionChanges([
      { id: 'model-b', label: 'B' },
      { id: ' model-c ', label: 'C' },
      { id: 'model-c', label: 'duplicate' },
    ], configured);

    assert.deepEqual(changes.additions.map((model) => model.id), ['model-c']);
    assert.deepEqual(changes.updates.map(({ configured: item, model }) => [item.id, model.id]), [['record-b', 'model-b']]);
    assert.deepEqual(changes.removals.map((model) => model.id), ['record-a']);
  });

  it('filters by model id or label', () => {
    const catalog = buildModelCatalog([
      { id: 'claude-sonnet', label: 'Claude Sonnet' },
      { id: 'gpt-5', label: 'GPT 5' },
    ], []);
    assert.deepEqual(filterModelCatalog(catalog, 'sonnet').map((entry) => entry.model.id), ['claude-sonnet']);
    assert.deepEqual(filterModelCatalog(catalog, 'gpt-5').map((entry) => entry.model.id), ['gpt-5']);
  });

  it('creates a safe metadata patch without inventing absent values', () => {
    const patch = modelMetadataPatch({
      id: 'model-a',
      label: 'Model A',
      contextWindow: 200_000,
      supportsVision: true,
      modelOptions: [{
        id: 'contextTier',
        label: 'Context',
        kind: 'select',
        defaultValue: '200K',
        choices: [{ value: '200K', label: '200K' }],
      }],
    }, 'remote', '2026-07-15T00:00:00.000Z');

    assert.deepEqual(patch, {
      modelLabel: 'Model A',
      metadataSource: 'remote',
      metadataSyncedAt: '2026-07-15T00:00:00.000Z',
      contextWindow: 200_000,
      supportsVision: true,
      modelOptions: [{
        id: 'contextTier',
        label: 'Context',
        kind: 'select',
        defaultValue: '200K',
        choices: [{ value: '200K', label: '200K' }],
      }],
    });
    assert.equal('maxOutputTokens' in patch, false);
    assert.equal('inputPrice' in patch, false);
  });

  it('builds stable import patches and deduplicates selected model IDs', () => {
    const patches = buildModelImportPatches([
      { id: ' model-a ', label: 'Model A', contextWindow: 128_000 },
      { id: 'model-a', label: 'Duplicate' },
      { id: 'model-b', label: 'model-b' },
      { id: '   ', label: 'blank' },
    ], 'remote', '2026-01-02T03:04:05.000Z');

    assert.deepEqual(patches, [
      {
        model: 'model-a',
        modelLabel: 'Model A',
        metadataSource: 'remote',
        metadataSyncedAt: '2026-01-02T03:04:05.000Z',
        contextWindow: 128_000,
      },
      {
        model: 'model-b',
        metadataSource: 'remote',
        metadataSyncedAt: '2026-01-02T03:04:05.000Z',
      },
    ]);
  });

  it('parses reasoning effort maps from JSON or key=value lines', () => {
    assert.deepEqual(parseReasoningEffortMap('{"low": 1024, "high": "xhigh"}'), {
      low: 1024,
      high: 'xhigh',
    });
    assert.deepEqual(parseReasoningEffortMap('low=1024\nhigh=xhigh'), {
      low: 1024,
      high: 'xhigh',
    });
    assert.deepEqual(parseReasoningEffortMap('low: 1024\nhigh: xhigh'), {
      low: 1024,
      high: 'xhigh',
    });
    assert.equal(parseReasoningEffortMap('  '), undefined);
    assert.throws(() => parseReasoningEffortMap('invalid'), /reasoning_effort_map_invalid/);
  });

  it('updates generic channel model options using serialized dropdown values', () => {
    const definitions = [{
      id: 'contextTier',
      label: 'Context tier',
      kind: 'select' as const,
      defaultValue: '200K',
      choices: [
        { value: '200K', label: '200K' },
        { value: '1M', label: '1M' },
      ],
    }, {
      id: 'parallelism',
      label: 'Parallelism',
      kind: 'select' as const,
      defaultValue: 1,
      choices: [
        { value: 1, label: '1' },
        { value: 4, label: '4' },
      ],
    }];

    assert.deepEqual(
      updateModelOptionSelection(definitions, { contextTier: 'removed' }, 'contextTier', '1M'),
      { contextTier: '1M', parallelism: 1 },
    );
    assert.deepEqual(
      updateModelOptionSelection(definitions, undefined, 'parallelism', '4'),
      { contextTier: '200K', parallelism: 4 },
    );
    assert.deepEqual(
      updateModelOptionSelection(definitions, { contextTier: '1M' }, 'unknown', 'value'),
      { contextTier: '1M', parallelism: 1 },
    );
  });

  it('maps catalog sources and reports metadata completeness', () => {
    assert.equal(metadataSourceFromList({ source: 'builtin' }), 'builtin');
    assert.equal(metadataSourceFromList({ source: 'local' }), 'local');
    assert.equal(metadataSourceFromList({ source: 'remote' }), 'remote');

    assert.equal(modelMetadataCompletion({}), 'missing');
    assert.equal(modelMetadataCompletion({ supportsVision: false }), 'partial');
    assert.equal(modelMetadataCompletion({ contextWindow: 200_000 }), 'partial');
    assert.equal(modelMetadataCompletion({
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      inputPrice: 3,
      outputPrice: 15,
    }), 'complete');
  });
});
