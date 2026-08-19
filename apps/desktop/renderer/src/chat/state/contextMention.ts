import type { ChatAttachment } from './types';
import { insertSessionMention } from './sessionReference.ts';

export type MentionScope = 'all' | 'files' | 'chats';

export type WorkspaceFileHit = {
  readonly relPath: string;
  readonly name: string;
  readonly kind?: 'file' | 'directory';
};

export type ContextMentionHit =
  | { readonly type: 'file'; readonly file: WorkspaceFileHit }
  | { readonly type: 'session'; readonly id: string; readonly title?: string }
  | { readonly type: 'category'; readonly id: 'files' | 'chats' }
  | { readonly type: 'back'; readonly to: 'all'; readonly from: 'files' | 'chats' };

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
  const relPath = hit.relPath.replaceAll('\\', '/').replace(/\/+$/, '');
  const name = hit.name || relPath.split('/').pop() || relPath;
  const isDirectory = hit.kind === 'directory';
  return {
    id: `workspace-${isDirectory ? 'dir' : 'file'}-${relPath}`,
    name,
    mimeType: isDirectory ? 'inode/directory' : 'text/plain',
    size: 0,
    kind: 'unsupported',
    sourceKind: isDirectory ? 'workspace_dir' : 'workspace_file',
    workspaceRelPath: relPath,
  };
}

export function fileMentionSubtitle(relPath: string): string {
  const normalized = relPath.replaceAll('\\', '/').replace(/\/+$/, '');
  const slash = normalized.lastIndexOf('/');
  if (slash <= 0) return '.';
  return normalized.slice(0, slash);
}

export function mergeContextMentionHits(params: {
  readonly query: string;
  readonly mentionScope?: MentionScope;
  readonly files?: readonly WorkspaceFileHit[];
  readonly sessions?: readonly { id: string; title?: string }[];
}): ContextMentionHit[] {
  const query = params.query.trim();
  const mentionScope = params.mentionScope ?? 'all';
  const files = params.files ?? [];
  const sessions = params.sessions ?? [];
  const hits: ContextMentionHit[] = [];

  if (mentionScope === 'all' && !query) {
    hits.push({ type: 'category', id: 'files' });
    hits.push({ type: 'category', id: 'chats' });
    return hits;
  }

  if (mentionScope === 'files' || mentionScope === 'chats') {
    hits.push({ type: 'back', to: 'all', from: mentionScope });
  }

  if (mentionScope !== 'chats') {
    for (const file of files) {
      hits.push({ type: 'file', file });
    }
  }
  if (mentionScope !== 'files') {
    for (const session of sessions) {
      hits.push({ type: 'session', id: session.id, title: session.title });
    }
  }
  return hits;
}
