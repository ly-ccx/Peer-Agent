import { realpathSync } from 'node:fs';
import path from 'node:path';

// Main owns registration/lifecycle. Per-call chat hosts only borrow a registered
// provider, keyed by the same authoritative Store and a workspace inside that root.
// Isolation binds the session to apps/desktop while the unpackaged host registers
// the repository root; a nested session must still resolve the same provider.
const services = new WeakMap();
let registrations = 0;
export function isDesktopPreviewAvailable() { return registrations > 0; }

function isPathInsideRegisteredWorkspace(candidate, registeredRoot) {
  if (candidate === registeredRoot) return true;
  const relative = path.relative(registeredRoot, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function registerDesktopPreviewService(store, workspaceRoot, provider) {
  if (services.has(store)) throw new Error('desktop-preview-service-already-registered');
  services.set(store, { workspaceRoot: realpathSync(workspaceRoot), provider });
  registrations++;
}
export function getDesktopPreviewService(store, workspaceRoot) {
  const service = store && services.get(store);
  if (!service) return null;
  try {
    return isPathInsideRegisteredWorkspace(realpathSync(workspaceRoot), service.workspaceRoot)
      ? service.provider
      : null;
  }
  catch { return null; }
}
export function unregisterDesktopPreviewService(store) { if (services.delete(store)) registrations--; }

// Provenance stays local and ephemeral: JSON text/replayed tool output cannot
// mint a fresh visual observation. Only the governed provider registers objects.
const observations = new WeakMap();
export function registerDesktopPreviewObservation(observation, toolCallId, source = null) {
  observations.set(observation, Object.freeze({ toolCallId, ...source }));
  Object.freeze(observation);
}
export function isDesktopPreviewObservation(observation, toolCallId) {
  return observations.get(observation)?.toolCallId === toolCallId && typeof toolCallId === 'string';
}
export function desktopPreviewObservationSource(observation) {
  return observations.get(observation) ?? null;
}

const projectedImages = new WeakMap();
export function bindPreviewImage(block, observation) {
  if (observations.has(observation)) projectedImages.set(block, observation);
  return block;
}
export function collectProjectedPreviewObservations(messages) {
  const found = new Set();
  const seen = new WeakSet();
  function visit(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    const observation = projectedImages.get(value);
    if (observation) found.add(observation);
    for (const child of Object.values(value)) visit(child);
  }
  visit(messages);
  return [...found];
}
