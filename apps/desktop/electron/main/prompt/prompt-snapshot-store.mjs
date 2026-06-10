import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathOf } from '../data-store.mjs';

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function appendJsonl(filePath, obj) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(obj)}\n`, 'utf8');
}

function readJsonObject(filePath, fallback = {}) {
  if (!existsSync(filePath)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function pruneSnapshots(storeDir, maxEntries) {
  if (!Number.isFinite(maxEntries) || maxEntries <= 0) return;
  const indexFile = path.join(storeDir, 'index.jsonl');
  const items = readJsonl(indexFile);
  if (items.length <= maxEntries) return;

  const kept = items.slice(-maxEntries);
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(indexFile, `${kept.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
}

export function createPromptSnapshotStore({
  storeDir = pathOf('promptSnapshots'),
  maxEntries = 200,
  clock = () => new Date(),
} = {}) {
  const indexFile = path.join(storeDir, 'index.jsonl');
  const baselineIndexFile = path.join(storeDir, 'baselines.jsonl');
  const latestBaselinesFile = path.join(storeDir, 'latest-baselines.json');
  const contextEpochIndexFile = path.join(storeDir, 'context-epochs.jsonl');
  const latestContextEpochsFile = path.join(storeDir, 'latest-context-epochs.json');
  const contextEpochEventsFile = path.join(storeDir, 'context-epoch-events.jsonl');

  function snapshotFile(id) {
    return path.join(storeDir, `${id}.json`);
  }

  function recordLatestBaseline(baseline) {
    const key = baseline.conversationId || 'global';
    const latest = readJsonObject(latestBaselinesFile, {});
    latest[key] = baseline;
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(latestBaselinesFile, JSON.stringify(latest, null, 2), 'utf8');
  }

  function recordLatestContextEpoch(epoch) {
    const key = epoch.conversationId || 'global';
    const latest = readJsonObject(latestContextEpochsFile, {});
    latest[key] = epoch;
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(latestContextEpochsFile, JSON.stringify(latest, null, 2), 'utf8');
  }

  function appendContextEpochEvent({
    eventType,
    entry,
    previousContextEpochId = null,
    reason = null,
    baselineId = null,
  }) {
    if (!entry?.contextEpochId) return null;
    const event = {
      eventId: `context-epoch-event-${randomUUID()}`,
      eventType,
      occurredAt: entry.createdAt,
      contextEpochId: entry.contextEpochId,
      previousContextEpochId,
      reason,
      baselineId,
      promptRecordId: entry.id,
      contextSnapshotId: entry.contextSnapshotId,
      conversationId: entry.conversationId,
      workspacePath: entry.workspacePath,
      provider: entry.provider,
      providerId: entry.providerId,
      model: entry.model,
      mode: entry.mode,
      effort: entry.effort,
      renderedHash: entry.renderedHash,
    };
    appendJsonl(contextEpochEventsFile, event);
    return event;
  }

  function record(context, metadata = {}) {
    if (!context?.snapshot?.id) return null;
    mkdirSync(storeDir, { recursive: true });
    const createdAt = clock().toISOString();
    const id = `prompt-record-${randomUUID()}`;
    const entry = {
      id,
      contextSnapshotId: context.snapshot.id,
      createdAt,
      streamId: metadata.streamId ?? null,
      conversationId: metadata.conversationId ?? context.snapshot.conversationId ?? null,
      workspacePath: context.snapshot.workspacePath ?? null,
      provider: metadata.provider ?? context.snapshot.provider ?? null,
      providerId: metadata.providerId ?? null,
      model: metadata.model ?? context.snapshot.model ?? null,
      mode: metadata.mode ?? context.snapshot.mode ?? null,
      effort: metadata.effort ?? null,
      renderedHash: context.snapshot.renderedHash,
      sectionRefs: context.snapshot.sectionRefs,
    };
    if (metadata.baselineReason) {
      entry.baselineId = `prompt-baseline-${randomUUID()}`;
      entry.baselineReason = metadata.baselineReason;
      entry.contextEpochId = metadata.contextEpochId ?? `context-epoch-${randomUUID()}`;
    } else if (metadata.contextEpochId) {
      entry.contextEpochId = metadata.contextEpochId;
    }
    writeFileSync(snapshotFile(entry.id), JSON.stringify({ ...entry, context }, null, 2), 'utf8');
    appendJsonl(indexFile, entry);
    if (entry.baselineId) {
      const previousEpoch = getLatestContextEpoch(entry.conversationId);
      const baseline = {
        baselineId: entry.baselineId,
        contextEpochId: entry.contextEpochId,
        reason: entry.baselineReason,
        promptRecordId: entry.id,
        contextSnapshotId: entry.contextSnapshotId,
        createdAt: entry.createdAt,
        conversationId: entry.conversationId,
        workspacePath: entry.workspacePath,
        provider: entry.provider,
        providerId: entry.providerId,
        model: entry.model,
        mode: entry.mode,
        effort: entry.effort,
        renderedHash: entry.renderedHash,
        sectionRefs: entry.sectionRefs,
      };
      const contextEpoch = {
        contextEpochId: entry.contextEpochId,
        reason: entry.baselineReason,
        baselineId: entry.baselineId,
        promptRecordId: entry.id,
        contextSnapshotId: entry.contextSnapshotId,
        createdAt: entry.createdAt,
        replacesContextEpochId: previousEpoch?.contextEpochId ?? null,
        conversationId: entry.conversationId,
        workspacePath: entry.workspacePath,
        provider: entry.provider,
        providerId: entry.providerId,
        model: entry.model,
        mode: entry.mode,
        effort: entry.effort,
        renderedHash: entry.renderedHash,
        sectionRefs: entry.sectionRefs,
      };
      appendJsonl(baselineIndexFile, baseline);
      appendJsonl(contextEpochIndexFile, contextEpoch);
      recordLatestBaseline(baseline);
      recordLatestContextEpoch(contextEpoch);
      appendContextEpochEvent({
        eventType: previousEpoch ? 'epoch_replaced' : 'epoch_created',
        entry,
        previousContextEpochId: previousEpoch?.contextEpochId ?? null,
        reason: entry.baselineReason,
        baselineId: entry.baselineId,
      });
    } else if (entry.contextEpochId) {
      appendContextEpochEvent({
        eventType: 'snapshot_anchored',
        entry,
      });
    }
    pruneSnapshots(storeDir, maxEntries);
    return entry;
  }

  function recordBaseline(context, metadata = {}) {
    return record(context, {
      ...metadata,
      baselineReason: metadata.baselineReason ?? metadata.reason ?? 'manual',
    });
  }

  function list({ limit = 50 } = {}) {
    const items = readJsonl(indexFile);
    return items.slice(Math.max(0, items.length - limit)).reverse();
  }

  function get(id) {
    const filePath = snapshotFile(id);
    if (!id || !existsSync(filePath)) return null;
    try {
      return JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  function listBaselines({ limit = 50 } = {}) {
    const items = readJsonl(baselineIndexFile);
    return items.slice(Math.max(0, items.length - limit)).reverse();
  }

  function getLatestBaseline(conversationId = null) {
    const latest = readJsonObject(latestBaselinesFile, {});
    return latest[conversationId || 'global'] ?? null;
  }

  function listContextEpochs({ limit = 50 } = {}) {
    const items = readJsonl(contextEpochIndexFile);
    return items.slice(Math.max(0, items.length - limit)).reverse();
  }

  function getLatestContextEpoch(conversationId = null) {
    const latest = readJsonObject(latestContextEpochsFile, {});
    return latest[conversationId || 'global'] ?? null;
  }

  function listContextEpochEvents({
    limit = 100,
    conversationId,
    contextEpochId,
  } = {}) {
    const items = readJsonl(contextEpochEventsFile)
      .filter((item) => conversationId === undefined || item.conversationId === conversationId)
      .filter((item) => contextEpochId === undefined || item.contextEpochId === contextEpochId);
    return items.slice(Math.max(0, items.length - limit)).reverse();
  }

  function getContextEpochChain({
    conversationId = null,
    contextEpochId = null,
    limit = 50,
  } = {}) {
    const epochs = readJsonl(contextEpochIndexFile);
    const byId = new Map(epochs.map((epoch) => [epoch.contextEpochId, epoch]));
    const chain = [];
    let current = contextEpochId ? byId.get(contextEpochId) : getLatestContextEpoch(conversationId);
    while (current && chain.length < limit) {
      chain.push(current);
      current = current.replacesContextEpochId ? byId.get(current.replacesContextEpochId) : null;
    }
    return chain;
  }

  return {
    record,
    recordBaseline,
    list,
    get,
    listBaselines,
    getLatestBaseline,
    listContextEpochs,
    getLatestContextEpoch,
    listContextEpochEvents,
    getContextEpochChain,
  };
}
