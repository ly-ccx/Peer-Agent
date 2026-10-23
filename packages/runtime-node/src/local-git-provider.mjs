import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createEvidenceBundle } from '@peer-agent/runtime-core';
import { LOCAL_GIT_CAPABILITY } from '@peer-agent/protocol';
import { createGitRead, validateGitReadQuery } from './git-read.mjs';
import { writeToolResultArtifact } from './tool-artifact-store.ts';
import { createFailedClientToolResult, createPermissionGrant, nowIso } from './tool-result-factory.mjs';

const fail = (reason, status = 'failed') => Object.assign(new Error(reason), { reason, status });
const within = (path, root) => {
  const rel = relative(root, path);
  return !rel || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
};

/** Shared Provider: GitRead owns commands; this Module owns authorization and Evidence. */
export function createLocalGitProvider({ workspaceRoot, artifactBaseDir, query = createGitRead() } = {}) {
  return { providerId: 'local-git-provider', capabilityIds: [LOCAL_GIT_CAPABILITY],
    async executeCapability({ call }, { locale = 'zh-CN', toolContext = {}, workspaceRoot: executionRoot, signal, requestPermission } = {}) {
      if (call.capabilityId !== LOCAL_GIT_CAPABILITY) return null;
      let grant = createPermissionGrant({ toolCallId: call.toolCallId, granted: false, scope: LOCAL_GIT_CAPABILITY });
      const validations = [];
      const authorized = [];
      function guard() {
        if (signal?.aborted) throw fail('git_query_cancelled', 'cancelled');
        const denial = toolContext.checkAccessPolicy?.();
        if (denial || validations.some(validate => !validate())) {
          grant = { ...grant, granted: false, duration: 'denied' };
          throw fail(denial || 'permission_policy_changed', 'denied');
        }
      }
      try {
        const args = validateGitReadQuery(call.arguments);
        if (toolContext.permissionPolicy?.kind === 'objective_probe') throw fail('objective_probe_capability_denied', 'denied');
        const policy = toolContext.permissionPolicy;
        if (policy?.kind === 'automation' && (policy.blockedCapabilityIds?.includes(LOCAL_GIT_CAPABILITY)
          || !policy.allowedCapabilityIds?.includes(LOCAL_GIT_CAPABILITY))) throw fail('automation_capability_not_granted', 'denied');
        const root = toolContext.workspacePath || executionRoot || workspaceRoot;
        if (!root && !isAbsolute(args.path)) throw fail('git_absolute_path_required');
        const roots = [];
        for (const value of [root, ...(toolContext.readableRoots || [])].filter(Boolean)) roots.push(await realpath(value));
        const observation = await query({ ...args, path: resolve(root || '.', args.path) }, { signal, checkAuthority: guard,
          async authorize(path) {
            guard();
            if (!roots.some(rootPath => within(path, rootPath)) && !authorized.some(rootPath => within(path, rootPath))) {
              if (typeof requestPermission !== 'function') throw fail('git_read_permission_required', 'denied');
              const approval = await requestPermission({ capabilityId: LOCAL_GIT_CAPABILITY, tool: 'git_query', toolName: 'git_query',
                args: { ...args, path }, filePath: path, workspacePath: root,
                scope: { kind: 'file-read', capabilityId: LOCAL_GIT_CAPABILITY, path, workspacePath: root || null },
                riskLevel: 'L1_local_read', dataLevel: 'D2_sensitive', reason: 'Read local repository facts outside admitted read roots.' });
              if (!approval?.granted) throw fail('git_read_permission_denied', 'denied');
              if (typeof approval.validate === 'function') validations.push(approval.validate);
              guard(); authorized.push(path);
            }
            if (!grant.granted) grant = createPermissionGrant({ toolCallId: call.toolCallId, granted: true,
              scope: { capabilityId: LOCAL_GIT_CAPABILITY, operation: args.operation, paths: [...roots, ...authorized] } });
            else grant = { ...grant, scope: { capabilityId: LOCAL_GIT_CAPABILITY, operation: args.operation, paths: [...roots, ...authorized] } };
          },
        });
        guard();
        const full = { kind: 'local_git_observation', ...observation };
        const artifact = writeToolResultArtifact({ baseDir: artifactBaseDir,
          conversationId: toolContext.conversationId, toolCallId: `${call.toolCallId}-${randomUUID()}`, tool: 'git_query',
          content: JSON.stringify(full, null, 2), maxConversationBytes: Infinity });
        const preview = { ...full, origin: full.origin.slice(0, 3).map(value => value.slice(0, 400)), commits: full.commits.slice(0, args.limit),
          ...(full.status ? { status: { ...full.status, entries: full.status.entries.slice(0, args.limit), truncated: full.status.entries.length > args.limit } } : {}),
          ...(artifact ? { artifactPath: artifact.artifactPath, retrievalHint: { tool: 'read_file', path: artifact.artifactPath } } : {}) };
        while (JSON.stringify(preview).length > 4000 && (preview.status?.entries.length || preview.commits.length)) {
          if (preview.status?.entries.length) { preview.status.entries.pop(); preview.status.truncated = true; }
          else preview.commits.pop();
        }
        preview.contextPreviewTruncated = preview.status?.truncated === true || preview.commits.length < full.commits.length
          || JSON.stringify(preview.origin) !== JSON.stringify(full.origin);
        guard();
        return { call, grant, result: { toolCallId: call.toolCallId, status: 'success', outputPreview: preview, completedAt: nowIso(),
          evidence: createEvidenceBundle({ evidenceId: randomUUID(), toolCallId: call.toolCallId, locale, dataLevel: 'D2_sensitive',
            returnedToCloud: true, summary: `Git ${args.operation}: ${observation.repositoryPath}; observed ${observation.finishedAt}; consistent=${observation.consistent}`,
            artifactRefs: artifact ? [artifact.artifactPath] : [], metadata: { capabilityId: LOCAL_GIT_CAPABILITY, operation: args.operation,
              startedAt: observation.startedAt, finishedAt: observation.finishedAt, consistent: observation.consistent, atomic: false } }) } };
      } catch (error) {
        const reason = error.reason || (error.code === 'ENOENT' ? 'git_path_not_found' : 'git_query_failed');
        const status = error.status || 'failed';
        if (status === 'denied') grant = { ...grant, granted: false, duration: 'denied' };
        const result = createFailedClientToolResult({ call, locale, reason, status, dataLevel: 'D2_sensitive' });
        result.outputPreview = { ...result.outputPreview, ...(error.detail ? { detail: error.detail } : {}),
          diagnostic: { stage: ['objective_probe_capability_denied', 'automation_capability_not_granted'].includes(reason) ? 'role'
            : reason.startsWith('git_read_permission') || reason === 'permission_policy_changed' ? 'permission' : 'execution',
            capabilityId: LOCAL_GIT_CAPABILITY, reason, retryable: status !== 'denied' && !['git_query_invalid_input', 'git_query_output_limit', 'git_unavailable'].includes(reason),
            userActionRequired: reason === 'git_read_permission_required' } };
        return { call, grant, result };
      }
    } };
}
