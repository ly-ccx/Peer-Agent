import type { ChatAttachment } from './types';
import { insertSessionMention } from './sessionReference.ts';

export type WorkspaceFileHit = {
  readonly relPath: string;
  readonly name: string;
  readonly kind?: 'file' | 'directory';
};

export type ContextMentionHit =
  | { readonly type: 'file'; readonly file: WorkspaceFileHit }
  | { readonly type: 'session'; readonly id: string; readonly title?: string }
  | { readonly type: 'category'; readonly id: 'files' | 'chats' };

export function insertFileMention(
  text: string,
  start: number,
  query: string,
  relPath: string,
): string {
  const safePath = relPath.replaceAll('\\', '/').replace(/\s+/g, ' ').trim();
  return insertSessionMention(text, start, query, safePath);
}

export function buildWorkspaceFileAttachment(hit: WorkspaceFileHit): ChatAttachment {
  const relPath = hit.relPath.replaceAll('\\', '/');
  const name = hit.name || relPath.split('/').pop() || relPath;
  return {
    id: `workspace-file-${relPath}`,
    name,
    mimeType: 'text/plain',
    size: 0,
    kind: 'unsupported',
    sourceKind: 'workspace_file',
    workspaceRelPath: relPath,
  };
}

export function mergeContextMentionHits(params: {
  readonly query: string;
  readonly files?: readonly WorkspaceFileHit[];
  readonly sessions?: readonly { id: string; title?: string }[];
  readonly includeCategories?: boolean;
}): ContextMentionHit[] {
  const query = params.query.trim().toLowerCase();
  const files = params.files ?? [];
  const sessions = params.sessions ?? [];
  const hits: ContextMentionHit[] = [];

  if (!query && params.includeCategories !== false) {
    hits.push({ type: 'category', id: 'files' });
    hits.push({ type: 'category', id: 'chats' });
  }

  for (const file of files) {
    hits.push({ type: 'file', file });
  }
  for (const session of sessions) {
    hits.push({ type: 'session', id: session.id, title: session.title });
  }
  return hits;
}
