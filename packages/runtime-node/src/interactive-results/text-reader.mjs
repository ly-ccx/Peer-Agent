import path from 'node:path';
import { interactiveArtifactRef, normalizeInteractiveReference, normalizeInteractiveUserArtifact } from '@peer-agent/protocol';
import { createBotProfileStore } from '../project-agent/bot-profile-store.mjs';
import { createInteractiveRetention } from './retention.mjs';
import { createInteractiveResultStore } from './store.mjs';
import { encode, problem } from './storage.mjs';

/** Human-facing static projection. No tool invocation, evaluation or writable view state. */
export function createInteractiveTextReader({ resultStore, assertOwner }) {
  const retirement = createInteractiveRetention({ resultStore, assertOwner });
  return function readText(rawReference) {
    const reference = normalizeInteractiveReference(rawReference);
    if (!reference) throw problem('interactive_reference_invalid');
    const { owner } = reference;
    const assertCurrent = () => { if (assertOwner(owner) !== true) throw problem('interactive_scope_denied'); };
    assertCurrent();
    const ref = interactiveArtifactRef(reference);
    let fixed;
    try { fixed = resultStore.getVersion(reference); }
    catch (error) {
      if (error.code !== 'interactive_content_cleaned') throw error;
      const version = retirement.readTombstone(reference);
      if (!version) throw problem('interactive_cleanup_corrupt');
      assertCurrent();
      return { schemaVersion: 1, availability: 'cleaned', summaryKind: 'saved-model-summary', ref, ...version };
    }
    const { content, provenance: _provenance, publicationStatus, ...metadata } = fixed;
    const operation = resultStore.getOperation({ owner, conversationId: metadata.source.conversationId, toolCallId: metadata.source.toolCallId });
    const artifact = operation?.indexEntry?.userArtifacts?.map(normalizeInteractiveUserArtifact).find(row => row?.ref === ref);
    if (publicationStatus !== 'published' || operation?.publicationStatus !== 'published' || operation.unchanged
      || !operation.metadata || encode(operation.metadata) !== encode(metadata) || !artifact || encode(artifact.reference) !== encode(reference)
      || artifact.specHash !== content.specHash || artifact.label !== content.title || typeof content.textFallback !== 'string')
      throw problem('interactive_publication_unavailable');
    const textFallback = content.textFallback.slice(0, 8192);
    assertCurrent();
    return { schemaVersion: 1, availability: 'available', summaryKind: 'saved-model-summary', ref, reference, source: metadata.source, dataLevel: metadata.dataLevel,
      contentSchemaVersion: content.schemaVersion, libraryVersion: content.libraryVersion, title: content.title, textFallback,
      truncated: content.textFallback.length > textFallback.length };
  };
}

/** Read-only local CLI composition. The local data root is supplied by the host. */
export function readLocalInteractiveText(dataHome, reference) {
  const profiles = createBotProfileStore({ rootDir: dataHome });
  const resultStore = createInteractiveResultStore({ rootDir: path.join(dataHome, 'project-runtime') });
  try {
    return createInteractiveTextReader({ resultStore, assertOwner: owner => {
      const profile = profiles.read(owner.workspaceId);
      return profile?.status === 'active' && profile.agentConversationId === owner.conversationId;
    } })(reference);
  } finally { resultStore.close(); }
}
