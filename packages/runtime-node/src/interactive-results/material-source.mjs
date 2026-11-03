import { createHash } from 'node:crypto';
import { INTERACTIVE_RESULT_LIMITS as L, normalizeInteractiveSelector, interactiveBindingId, interactiveDigest } from '@peer-agent/protocol';

const DATA_LEVELS = ['D0_public', 'D1_internal', 'D2_sensitive', 'D3_private', 'D4_regulated'];
const fail = code => { throw Object.assign(Error(code), { code }); };
const digest = text => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const own = (value, key) => value && typeof value === 'object' && !['constructor', 'prototype', '__proto__'].includes(key) && Object.hasOwn(value, key);

export function selectInteractiveData(data, rawSelector) {
  const selector = rawSelector === undefined ? {} : normalizeInteractiveSelector(rawSelector);
  if (!selector) fail('material_range_exceeded');
  let value = data;
  for (const field of selector.path ?? []) {
    if (!own(value, field)) fail('material_range_exceeded');
    value = value[field];
  }
  if (selector.start !== undefined || selector.limit !== undefined) {
    if (!Array.isArray(value) || (selector.start ?? 0) > value.length) fail('material_range_exceeded');
    value = value.slice(selector.start ?? 0, (selector.start ?? 0) + (selector.limit ?? L.collectionItems));
  }
  if (selector.fields) {
    const select = row => {
      if (!row || typeof row !== 'object' || Array.isArray(row) || selector.fields.some(field => !own(row, field))) fail('material_range_exceeded');
      return Object.fromEntries(selector.fields.map(field => [field, row[field]]));
    };
    value = Array.isArray(value) ? value.map(select) : select(value);
  }
  return value;
}

/** Reads canonical admitted bytes through host ports, never project paths or new tool executions. */
export function createInteractiveMaterialSource({ readToolResult, readUserMaterial, admitSource, now = () => new Date().toISOString() } = {}) {
  return {
    async resolveInputs(inputs, executionBinding, { signal, inheritedDataLevel = 'D2_sensitive' } = {}) {
      if (!DATA_LEVELS.includes(inheritedDataLevel)) fail('material_classification_unavailable');
      if (!Array.isArray(inputs) || inputs.length > L.bindings) fail('invalid_binding');
      // Kept lazy: CLI help/version and inactive capabilities never load the language engine.
      const { boundedJSON, canonicalJSON } = await import('@peer-agent/interactive-content');
      const bindings = {}, provenance = [];
      let bytes = 0, level = DATA_LEVELS.indexOf(inheritedDataLevel);
      const check = () => { if (signal?.aborted) fail('interactive_cancelled'); };
      for (const input of inputs) {
        check();
        if (!interactiveBindingId(input?.bindingId) || Object.hasOwn(bindings, input.bindingId) || provenance.length >= L.bindings) fail('invalid_binding');
        const source = input.source;
        let record;
        if (source.kind === 'model-data') {
          const value = boundedJSON(source.value);
          const body = canonicalJSON(value);
          record = { value, contentVersion: digest(body), observedAt: now(), truncated: false, redacted: false, dataLevel: inheritedDataLevel, evidenceRefs: [] };
        } else {
          if (typeof admitSource !== 'function' || await admitSource(source, executionBinding) !== true) fail('material_scope_denied');
          check();
          const reader = source.kind === 'tool-result' ? readToolResult : source.kind === 'user-material' ? readUserMaterial : null;
          if (typeof reader !== 'function') fail('material_snapshot_unavailable');
          record = await reader(source, executionBinding);
          check();
          if (!record || record.available === false || !interactiveDigest(record.contentVersion) || record.canonical !== true) fail('material_snapshot_unavailable');
          if (record.contentVersion !== source.expectedContentVersion) fail('material_version_mismatch');
          if (!DATA_LEVELS.includes(record.dataLevel)) fail('material_classification_unavailable');
          if (typeof record.observedAt !== 'string' || !Number.isFinite(Date.parse(record.observedAt)) || typeof record.truncated !== 'boolean' || typeof record.redacted !== 'boolean') fail('material_snapshot_unavailable');
          if (!Array.isArray(record.evidenceRefs) || record.evidenceRefs.some(ref => typeof ref !== 'string' || ref.length > 1024)) fail('material_snapshot_unavailable');
          if (source.kind === 'tool-result' && !record.evidenceRefs.length) fail('material_snapshot_unavailable');
          const original = boundedJSON(record.value, { maxBytes: L.inputBytes * 8, maxItems: 10_000 });
          if (digest(canonicalJSON(original)) !== record.contentVersion) fail('material_version_mismatch');
          record = { ...record, value: original };
        }
        const selected = boundedJSON(selectInteractiveData(record.value, input.selector));
        const body = canonicalJSON(selected);
        bytes += Buffer.byteLength(body, 'utf8');
        if (bytes > L.inputBytes) fail('interactive_resource_limit');
        bindings[input.bindingId] = selected;
        level = Math.max(level, DATA_LEVELS.indexOf(record.dataLevel));
        provenance.push({ bindingId: input.bindingId, source: source.kind === 'model-data' ? { kind: 'model-data', contentDigest: record.contentVersion } : source, contentVersion: record.contentVersion, selectedDigest: digest(body),
          ...(input.selector ? { selector: input.selector } : {}), observedAt: record.observedAt, capturedAt: now(),
          truncated: record.truncated, redacted: record.redacted, dataLevel: record.dataLevel, evidenceRefs: [...record.evidenceRefs] });
      }
      check();
      return { bindings, provenance, dataLevel: DATA_LEVELS[level] };
    },
  };
}
