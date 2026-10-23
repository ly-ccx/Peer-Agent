import { LOCAL_GIT_CAPABILITY, LOCAL_GIT_TOOL } from '@peer-agent/protocol';

export const LOCAL_GIT_SCHEMA = Object.freeze({
  type: 'object', properties: {
    path: { type: 'string', minLength: 1, description: 'Repository directory, absolute or relative to the workspace.' },
    operation: { type: 'string', enum: ['snapshot', 'status', 'log'] },
    limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum status entries or commits returned inline. Counts cover the observed top-level status; disabled external filters and uninspected submodules are explicit.' },
  }, required: ['path'], additionalProperties: false,
});
export const LOCAL_GIT_MODES = Object.freeze(['chat', 'plan', 'goal', 'explorer', 'project_agent']);
export const LOCAL_GIT_TOOL_DEFINITIONS = [{
  name: LOCAL_GIT_TOOL, capabilityId: LOCAL_GIT_CAPABILITY,
  availableInModes: LOCAL_GIT_MODES,
  runtime: { adapter: 'runtime-node.local-git-provider', executorCapabilityId: LOCAL_GIT_CAPABILITY, resultReplay: 'fresh_read' },
  permissionPolicy: { kind: 'file-read', requiresReviewForWrites: false },
  prompt: () => 'Read current local Git facts without shell or repository writes. snapshot (default) returns origin, branch, full HEAD, latest commit and tracked/untracked status; status returns working-tree state; log returns up to limit commits. Detached/unborn HEAD, truncation and changes during sampling are explicit. This is a timed observation, not an atomic snapshot. Submodules are counted but never inspected recursively. External content filters are disabled; filtersDisabled means status counts reflect this restricted observation. clean is null when a clean claim cannot be established. Use this in read-only work instead of bash/git commands or parsing .git files. It does not fetch or prove the remote is current. Use read_file on artifactPath for omitted entries; do not treat truncated output as complete.',
  inputSchema: LOCAL_GIT_SCHEMA,
  manifest: {
    capabilityId: LOCAL_GIT_CAPABILITY, name: LOCAL_GIT_TOOL,
    description: 'Observe local repository identity, worktree status and commit history.',
    source: 'native', riskLevel: 'L1_local_read', dataLevel: 'D2_sensitive', health: 'available',
    inputSchema: LOCAL_GIT_SCHEMA,
    evidencePolicy: { returnMode: 'artifact_ref', maxChars: 4000, redactSensitive: true },
  },
}];
