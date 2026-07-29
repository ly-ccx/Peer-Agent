#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  COMPACTION_CONFIG,
  compactIfNeeded,
  estimateTextTokens,
} from '../apps/desktop/electron/main/context-compactor.mjs';

const conversationId = process.argv[2];
if (!conversationId) {
  console.error('Usage: node scripts/verify-context-compaction-session.mjs <conversationId>');
  process.exit(64);
}

const conversationPath = path.join(
  os.homedir(),
  '.peer-agent',
  'conversations',
  `${conversationId}.jsonl`,
);
if (!fs.existsSync(conversationPath)) {
  console.error(`Conversation not found: ${conversationPath}`);
  process.exit(66);
}

const rows = fs.readFileSync(conversationPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSONL at line ${index + 1}: ${error?.message || error}`);
    }
  });

const markers = rows
  .filter((row) => row?._compaction && typeof row._compaction === 'object')
  .map((row) => row._compaction);
const sourceMarker = [...markers].reverse().find((marker) => (
  typeof marker?.summary === 'string'
  && marker.summary.trim().length >= COMPACTION_CONFIG.minCanonicalNarrativeChars
));
if (!sourceMarker) {
  console.error('No non-empty compaction marker is available for offline recovery.');
  process.exit(65);
}

// Use the failing provider shape observed for this Session: 258k context, 64k output.
// The synthetic delta is intentionally small; the continuity marker is the real persisted data.
const result = await compactIfNeeded({
  messages: [
    { role: 'system', content: 'Offline context-compaction verification.' },
    { role: 'user', content: `Verification delta for ${conversationId}: preserve continuity and growth headroom.` },
    { role: 'assistant', content: 'Acknowledged; compile a non-empty canonical checkpoint.' },
  ],
  systemPrompt: 'Offline context-compaction verification.',
  contextWindow: 258_000,
  providerMaxOutputTokens: 64_000,
  providerConfig: null,
  force: true,
  continuityContext: [sourceMarker],
  preserveRecentTurns: 0,
  conversationId,
});

const marker = result.messages.find((message) => message?._compaction)?._compaction;
if (!marker) throw new Error('Offline rebuild did not produce a compaction marker.');
const narrative = typeof marker.canonicalCheckpoint?.recentNarrative === 'string'
  ? marker.canonicalCheckpoint.recentNarrative.trim()
  : '';
const summary = typeof marker.summary === 'string' ? marker.summary.trim() : '';
const requestTargetTokens = marker.budgetSnapshot?.requestTargetTokens;
const finalRequestTokens = result.notification?.afterBudgetTokens ?? result.notification?.afterTokens;
const growthHeadroomTokens = Number.isFinite(requestTargetTokens) && Number.isFinite(finalRequestTokens)
  ? requestTargetTokens - finalRequestTokens
  : null;

const report = {
  conversationId,
  sourceMarkerCount: markers.length,
  sourceSummaryChars: sourceMarker.summary.length,
  sourceSummaryTokens: estimateTextTokens(sourceMarker.summary),
  checkpointVersion: marker.checkpointVersion ?? null,
  summaryChars: summary.length,
  narrativeChars: narrative.length,
  narrativeTokens: estimateTextTokens(narrative),
  finalRequestTokens,
  requestTargetTokens: requestTargetTokens ?? null,
  triggerLimit: Math.floor(258_000 * COMPACTION_CONFIG.triggerRatio),
  growthHeadroomTokens,
  coldHistoryRefCount: Array.isArray(marker.coldHistoryRefs) ? marker.coldHistoryRefs.length : 0,
  nonEmpty: narrative.length >= COMPACTION_CONFIG.minCanonicalNarrativeChars,
  belowRequestTarget: Number.isFinite(requestTargetTokens)
    && Number.isFinite(finalRequestTokens)
    && finalRequestTokens <= requestTargetTokens,
};
console.log(JSON.stringify(report, null, 2));

if (!report.nonEmpty) process.exit(2);
if (!report.belowRequestTarget) process.exit(3);
if (!Number.isFinite(growthHeadroomTokens) || growthHeadroomTokens < 0) process.exit(4);
