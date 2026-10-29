import { goalFileVersion as fileVersion } from "./goal-plan-files.mjs";
import { appendJsonl, mergeEvidenceIndexRecords, normalizeEvidenceIndexRecord, readEvidenceRecordsFromTail, readJsonl } from "./goal-plan-files.mjs";
import { normalizeConversationId, normalizeEvidenceRefList, normalizeOptionalString } from "./goal-plan-domain.mjs";
import { statSync } from "node:fs";
import path from "node:path";
import { DESKTOP_PREVIEW_CAPABILITY } from "@peer-agent/protocol";

/** Owns Evidence index writes, bounded lookup, cache invalidation and registered-reference enforcement through the existing store commit boundary. */
export function createGoalPlanEvidence({ storeDir, getActivePlanByConversation }) {

  const evidenceIndexFile = path.join(storeDir, 'evidence-index.jsonl');
  const evidenceRecordCache = new Map();
  const missingEvidenceRefCache = new Set();
  let evidenceCacheVersion = null;
  let evidenceIndexReadCache = null;
  function refreshEvidenceCache() {
    const version = fileVersion(evidenceIndexFile);
    if (version === evidenceCacheVersion) return;
    evidenceRecordCache.clear();
    missingEvidenceRefCache.clear();
    evidenceCacheVersion = version;
  }
  // 桌面预览产物只占证据索引里的少数 planId。listPlans 会对每个 completed
  // 计划问一次「有没有预览产物」；索引可达数十 MB，不能为此反复全量解析。
  // 缓存按 mtime+size 失效，本进程 append 时按写入字节数增量更新。
  let desktopPreviewPlanCache = null;

  function readEvidenceIndex() {
    // Completion and artifact projections can read the same large index many times
    // in one refresh. Reuse parsing only while the durable file identity is unchanged;
    // normalization returns fresh nested records, so callers cannot mutate this cache.
    const version = fileVersion(evidenceIndexFile);
    if (version === null) {
      evidenceIndexReadCache = null;
      return [];
    }
    if (evidenceIndexReadCache?.version !== version) {
      evidenceIndexReadCache = { version, records: readJsonl(evidenceIndexFile) };
    }
    return evidenceIndexReadCache.records
      .map(normalizeEvidenceIndexRecord)
      .filter(Boolean);
  }

  function recordHasDesktopPreviewArtifact(record) {
    return Boolean(
      record?.planId
      && record.capabilityId === DESKTOP_PREVIEW_CAPABILITY
      && record.artifactRefs?.some((ref) => ref.startsWith('local-desktop-preview-artifact://')),
    );
  }

  function readDesktopPreviewPlanIds() {
    let stat = null;
    try {
      stat = statSync(evidenceIndexFile);
    } catch {
      desktopPreviewPlanCache = null;
      return new Set();
    }
    if (
      desktopPreviewPlanCache
      && desktopPreviewPlanCache.mtimeMs === stat.mtimeMs
      && desktopPreviewPlanCache.size === stat.size
    ) {
      return desktopPreviewPlanCache.planIds;
    }
    const planIds = new Set();
    for (const record of readJsonl(evidenceIndexFile)) {
      const normalized = normalizeEvidenceIndexRecord(record);
      if (recordHasDesktopPreviewArtifact(normalized)) planIds.add(normalized.planId);
    }
    desktopPreviewPlanCache = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      planIds,
    };
    return planIds;
  }

  function hasDesktopPreviewEvidence(planId) {
    const normalizedPlanId = normalizeOptionalString(planId);
    if (!normalizedPlanId) return false;
    return readDesktopPreviewPlanIds().has(normalizedPlanId);
  }

  function noteDesktopPreviewEvidenceAppend(record, sizeBefore) {
    if (!desktopPreviewPlanCache) return;
    if (desktopPreviewPlanCache.size !== sizeBefore) {
      desktopPreviewPlanCache = null;
      return;
    }
    let stat = null;
    try {
      stat = statSync(evidenceIndexFile);
    } catch {
      desktopPreviewPlanCache = null;
      return;
    }
    const written = Buffer.byteLength(`${JSON.stringify(record)}\n`);
    if (stat.size !== sizeBefore + written) {
      desktopPreviewPlanCache = null;
      return;
    }
    if (recordHasDesktopPreviewArtifact(record)) desktopPreviewPlanCache.planIds.add(record.planId);
    desktopPreviewPlanCache.mtimeMs = stat.mtimeMs;
    desktopPreviewPlanCache.size = stat.size;
  }

  function findEvidenceIndexRecords(refs) {
    refreshEvidenceCache();
    const normalizedRefs = normalizeEvidenceRefList(refs);
    const missing = normalizedRefs.filter(
      (ref) => !evidenceRecordCache.has(ref) && !missingEvidenceRefCache.has(ref),
    );
    if (missing.length > 0) {
      const found = readEvidenceRecordsFromTail(evidenceIndexFile, missing);
      const foundRefs = new Set();
      for (const record of found) {
        foundRefs.add(record.evidenceRef);
        evidenceRecordCache.set(record.evidenceRef, record);
      }
      for (const ref of missing) {
        if (!foundRefs.has(ref)) missingEvidenceRefCache.add(ref);
      }
    }
    return normalizedRefs.map((ref) => evidenceRecordCache.get(ref)).filter(Boolean);
  }

  function inferEvidencePlanId(planId, conversationId) {
    const normalizedPlanId = normalizeOptionalString(planId);
    if (normalizedPlanId) return normalizedPlanId;
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (!normalizedConversationId) return null;
    return getActivePlanByConversation(normalizedConversationId)?.planId ?? null;
  }

  function recordEvidenceRefs(entry = {}) {
    refreshEvidenceCache();
    const refs = normalizeEvidenceRefList(entry.evidenceRefs ?? entry.evidenceRef);
    if (refs.length === 0) return [];
    const conversationId = normalizeConversationId(entry.conversationId);
    const planId = inferEvidencePlanId(entry.planId, conversationId);
    const artifactRefs = normalizeEvidenceRefList(entry.artifactRefs);
    const createdAt = normalizeOptionalString(entry.createdAt) || new Date().toISOString();
    const base = { createdAt };
    if (entry.bodyPreview) base.bodyPreview = entry.bodyPreview;
    if (planId) base.planId = planId;
    if (conversationId) base.conversationId = conversationId;
    for (const field of ['streamId', 'toolCallId', 'capabilityId', 'toolName']) {
      const normalized = normalizeOptionalString(entry[field]);
      if (normalized) base[field] = normalized;
    }
    if (artifactRefs.length > 0) base.artifactRefs = artifactRefs;
    if (Array.isArray(entry.userArtifacts) && entry.userArtifacts.length > 0) {
      base.userArtifacts = entry.userArtifacts;
    }
    const records = refs
      .map((evidenceRef) => normalizeEvidenceIndexRecord({ ...base, evidenceRef }))
      .filter(Boolean);
    const mergedRecords = [];
    for (const record of records) {
      const previous = findEvidenceIndexRecords([record.evidenceRef])[0];
      const merged = mergeEvidenceIndexRecords(previous, record);
      let sizeBefore = 0;
      try {
        sizeBefore = statSync(evidenceIndexFile).size;
      } catch {
        sizeBefore = 0;
      }
      appendJsonl(evidenceIndexFile, merged);
      noteDesktopPreviewEvidenceAppend(merged, sizeBefore);
      missingEvidenceRefCache.delete(record.evidenceRef);
      evidenceRecordCache.set(record.evidenceRef, merged);
      evidenceCacheVersion = fileVersion(evidenceIndexFile);
      mergedRecords.push(merged);
    }
    return mergedRecords;
  }

  function evidenceRecordMatchesPlan(record, plan) {
    if (!record || !plan) return false;
    if (record.planId && record.planId === plan.planId) return true;
    const planConversationId = normalizeConversationId(plan.conversationId);
    return Boolean(
      planConversationId
        && normalizeConversationId(record.conversationId) === planConversationId,
    );
  }

  function indexedEvidenceRefsForPlan(plan, refs) {
    const wanted = new Set(normalizeEvidenceRefList(refs));
    if (!plan || wanted.size === 0) return new Set();
    const found = new Set();
    for (const record of readEvidenceIndex()) {
      if (!wanted.has(record.evidenceRef)) continue;
      if (evidenceRecordMatchesPlan(record, plan)) found.add(record.evidenceRef);
    }
    return found;
  }

  function assertAnyEvidenceRefIndexed(plan, refs, context) {
    const normalizedRefs = normalizeEvidenceRefList(refs);
    if (normalizedRefs.length === 0) return;
    if (indexedEvidenceRefsForPlan(plan, normalizedRefs).size > 0) return;
    throw new Error(
      `[goal-plan-store] ${context} evidenceRefs are not registered in EvidenceIndex: ${normalizedRefs.join(', ')}`,
    );
  }

  function assertEvidenceRefIndexed(plan, ref, context) {
    const normalizedRef = normalizeOptionalString(ref);
    if (!normalizedRef) return;
    if (indexedEvidenceRefsForPlan(plan, [normalizedRef]).size > 0) return;
    throw new Error(
      `[goal-plan-store] ${context} evidenceRef is not registered in EvidenceIndex: ${normalizedRef}`,
    );
  }
  return { findEvidenceIndexRecords, assertEvidenceRefIndexed, evidenceRecordMatchesPlan, readEvidenceIndex, assertAnyEvidenceRefIndexed, hasDesktopPreviewEvidence, recordEvidenceRefs };
}
