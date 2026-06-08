import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

function readManifest(manifestPath) {
  const raw = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);

  return {
    ...manifest,
    manifestPath,
  };
}

function loadManifests(workspaceRoot) {
  const capabilitiesDir = path.join(workspaceRoot, 'capabilities');
  if (!existsSync(capabilitiesDir)) {
    return [];
  }

  return readdirSync(capabilitiesDir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => readManifest(path.join(capabilitiesDir, entry)));
}

export function createCapabilityRegistry({ workspaceRoot }) {
  let capabilities = loadManifests(workspaceRoot);

  function refreshCapabilities() {
    capabilities = loadManifests(workspaceRoot);
    return capabilities;
  }

  function listCapabilities() {
    return capabilities;
  }

  function findCapability(capabilityId) {
    return capabilities.find((capability) => capability.capabilityId === capabilityId) ?? null;
  }

  return {
    refreshCapabilities,
    listCapabilities,
    findCapability,
  };
}
