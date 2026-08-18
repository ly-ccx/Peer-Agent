import {
  SHARED_LOCAL_TOOL_CONTRACT_LIST,
  canonicalizeLocalCapabilityId,
  canonicalizeLocalModelToolName,
} from '@peer-agent/runtime-core';

const TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  file: [
    'local.file.read',
    'local.file.list',
    'local.file.search',
    'local.file.edit',
    'local.file.write',
  ],
  bash: [
    'local.shell.exec',
    'local.shell.stop',
  ],
});

export function resolveExecToolAllowlist(
  tokens: readonly string[],
): { readonly ok: true; readonly capabilityIds: readonly string[] } | { readonly ok: false; readonly message: string } {
  const capabilityIds = new Set<string>();
  for (const raw of tokens) {
    const token = raw.trim();
    if (!token) continue;
    const alias = TOOL_ALIASES[token];
    if (alias) {
      for (const id of alias) capabilityIds.add(id);
      continue;
    }
    const byCapability = SHARED_LOCAL_TOOL_CONTRACT_LIST.find(
      (contract) => contract.capabilityId === canonicalizeLocalCapabilityId(token),
    );
    if (byCapability) {
      capabilityIds.add(byCapability.capabilityId);
      continue;
    }
    const byName = SHARED_LOCAL_TOOL_CONTRACT_LIST.find(
      (contract) => contract.toolName === canonicalizeLocalModelToolName(token),
    );
    if (byName) {
      capabilityIds.add(byName.capabilityId);
      continue;
    }
    return {
      ok: false,
      message: `peer exec: unknown --tools token "${token}"`,
    };
  }
  if (capabilityIds.size === 0) {
    return { ok: false, message: 'peer exec: --tools requires a value' };
  }
  return { ok: true, capabilityIds: [...capabilityIds] };
}
