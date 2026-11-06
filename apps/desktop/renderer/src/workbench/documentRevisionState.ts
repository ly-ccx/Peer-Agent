import type { BotDocumentReference, ConfirmedGitDocumentRevision, GitDocumentRevision } from '@peer-agent/protocol';

export function normalizeDocumentRevision(raw: unknown): GitDocumentRevision | undefined {
  if (!raw || typeof raw !== 'object') return;
  const value = raw as Record<string, unknown>;
  if (value.kind !== 'git' || typeof value.commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value.commit)
    || value.repositoryId !== undefined && (typeof value.repositoryId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.repositoryId))) return;
  return { kind: 'git', commit: value.commit.toLowerCase(), ...(value.repositoryId ? { repositoryId: value.repositoryId as string } : {}) };
}

export function confirmedDocumentRevision(raw: unknown): ConfirmedGitDocumentRevision | undefined {
  const value = normalizeDocumentRevision(raw);
  const path = (raw as { path?: unknown } | null)?.path;
  if (!value?.repositoryId || typeof path !== 'string' || !path || path.length > 8192 || /[\u0000-\u001f]/.test(path)
    || /^(?:[\\/]|[a-z]:[\\/])/i.test(path) || path.split(/[\\/]/).includes('..')) return;
  return { ...value, repositoryId: value.repositoryId, path };
}

/** File names can stay short while the immutable target stays in the reference. */
export function documentFileLabel(path: string, revision?: GitDocumentRevision, isZh = false): string {
  const name = path.split(/[\\/]/).pop() || path;
  return revision ? `${name} · ${isZh ? '历史' : 'History'} ${revision.commit.slice(0, 8)}` : name;
}

export function documentRevisionKey(revision: unknown): string {
  return revision === undefined ? 'live' : normalizeDocumentRevision(revision)?.commit ?? 'invalid';
}

/** Nested local links keep the host-confirmed repository/commit, including deleted origins. */
export function nestedDocumentReference(reference: BotDocumentReference, path: string, resolvedPath?: string,
  revision?: ConfirmedGitDocumentRevision): BotDocumentReference {
  return { workspaceId: reference.workspaceId, path, ...(reference.task ? { task: reference.task } : {}),
    ...(resolvedPath ? { relativeTo: resolvedPath } : reference.relativeTo ? { relativeTo: reference.relativeTo } : {}),
    ...(revision ? { revision: { kind: 'git', commit: revision.commit, repositoryId: revision.repositoryId } }
      : reference.revision ? { revision: reference.revision } : {}) };
}
