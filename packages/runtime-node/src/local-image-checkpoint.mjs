import { createHash, randomUUID } from 'node:crypto';
import { isLocalImageObservationAuthorized } from './local-image-provider.mjs';

export const LOCAL_IMAGE_CONTEXT_PREFIX = '[Local image observation] ';

const imageBlocks = new WeakMap();
function matchesPixels(block, observation) {
  const encoded = observation.dataUrl.split(',')[1];
  return block?.type === 'image_url' ? block.image_url?.url === observation.dataUrl
    : block?.type === 'image' ? block.source?.media_type === observation.mediaType && block.source?.data === encoded
      : block?.inlineData?.mimeType === observation.mediaType && block.inlineData?.data === encoded;
}
export function bindLocalImageContextBlock(block, observation) {
  if (isLocalImageObservationAuthorized(observation) && matchesPixels(block, observation)) {
    imageBlocks.set(block, observation);
  }
  return block;
}

/** Durable snapshots contain no pixels. Voluntary slices may borrow still
 * authorized, Provider-issued blocks from the same bounded host memory.
 * The locator is not authority: scope, message identity and issuance revalidate.
 */
export function createLocalImageContinuationStore({ now = Date.now, ttlMs = 300_000,
  maxEntries = 16, maxBytes = 128 * 1024 * 1024 } = {}) {
  const entries = new Map();
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const scopeKey = scope => hash(['conversationId', 'workspacePath', 'planId', 'provider', 'providerId', 'model']
    .map(key => scope?.[key] ?? null));
  const prune = () => {
    for (const [id, entry] of entries) if (entry.expiresAt <= now()) entries.delete(id);
    let size = [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    while (entries.size > maxEntries || size > maxBytes) {
      const id = entries.keys().next().value;
      size -= entries.get(id).bytes; entries.delete(id);
    }
  };
  return {
    checkpoint(snapshot, scope) {
      const checkpoint = { ...snapshot, messages: checkpointWithoutLocalImagePixels(snapshot.messages) };
      const blocks = [];
      function visit(value, path = []) {
        if (!value || typeof value !== 'object') return;
        const observation = imageBlocks.get(value);
        if (observation && isLocalImageObservationAuthorized(observation) && matchesPixels(value, observation)) {
          blocks.push({ path, block: value, observation }); return;
        }
        for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
      }
      visit(snapshot.messages);
      if (blocks.length && scope?.conversationId) {
        const id = randomUUID();
        entries.set(id, { blocks, scope: scopeKey(scope), fingerprint: hash(checkpoint.messages),
          expiresAt: now() + ttlMs, bytes: blocks.reduce((sum, item) => sum + item.observation.byteLength, 0) });
        prune();
        if (entries.has(id)) checkpoint.transientLocalImageContextId = id;
      }
      return checkpoint;
    },
    restore(checkpoint, scope) {
      prune();
      const messages = structuredClone(checkpoint.messages);
      const id = checkpoint.transientLocalImageContextId, entry = entries.get(id);
      // Mismatched scope cannot consume another continuation's entry.
      if (!entry || entry.scope !== scopeKey(scope)) return messages;
      entries.delete(id);
      if (entry.fingerprint !== hash(messages)) return messages;
      for (const { path, block, observation } of entry.blocks) {
        if (!isLocalImageObservationAuthorized(observation) || !matchesPixels(block, observation)) continue;
        let parent = messages;
        for (const key of path.slice(0, -1)) parent = parent?.[key];
        if (parent) parent[path.at(-1)] = block;
      }
      return messages;
    },
  };
}

export const localImageContinuations = createLocalImageContinuationStore();

/** Preserve metadata/tool pairing, but never persist transient local pixels. */
export function checkpointWithoutLocalImagePixels(messages) {
  function copy(value) {
    if (Array.isArray(value)) {
      const result = [];
      for (let i = 0; i < value.length; i++) {
        const part = value[i];
        result.push(copy(part));
        const text = part?.type === 'text' ? part.text : part?.text;
        const next = value[i + 1];
        if (typeof text === 'string' && text.startsWith(LOCAL_IMAGE_CONTEXT_PREFIX) && (next?.type === 'image_url' || next?.type === 'image' || next?.inlineData)) {
          result.push(part?.type === 'text'
            ? { type: 'text', text: 'Local image pixels omitted from this checkpoint. Re-read the source with view_image before making a visual judgment.' }
            : { text: 'Local image pixels omitted from this checkpoint. Re-read the source with view_image before making a visual judgment.' });
          i++;
        }
      }
      return result;
    }
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
    return value;
  }
  return copy(messages);
}
