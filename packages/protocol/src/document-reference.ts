/** Human-initiated preview only. This reference never grants model/tool access. */
export interface BotDocumentReference {
  readonly workspaceId: string;
  readonly path: string;
  readonly relativeTo?: string;
}

export interface LocalDocumentReadResult {
  readonly ok: boolean;
  readonly status: 'ok' | 'not_found' | 'not_file' | 'too_large' | 'binary' | 'invalid_path' | 'error'
    | 'permission_denied' | 'scope_denied' | 'ambiguous_path' | 'workspace_unavailable';
  readonly content: string;
  readonly size?: number;
  readonly resolvedFrom?: string;
  readonly resolvedPath?: string;
  readonly error?: string;
}
