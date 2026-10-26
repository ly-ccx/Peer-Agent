/** Human-initiated preview only. This reference never grants model/tool access. */
export interface BotDocumentReference {
  readonly workspaceId: string;
  readonly path: string;
  readonly relativeTo?: string;
  /** Host revalidates Session/GoalPlan ownership on every read; never a root or grant. */
  readonly task?: { readonly sessionId: string; readonly planId: string };
  /** Explicit UI navigation intent; never an authorization root. */
  readonly kind?: 'file' | 'directory';
  /** Resolve/stat only; never returns file contents. */
  readonly metadataOnly?: boolean;
}

export interface LocalDocumentReadResult {
  readonly metadataOnly?: boolean;
  readonly ok: boolean;
  readonly status: 'ok' | 'not_found' | 'not_file' | 'too_large' | 'binary' | 'invalid_path' | 'error'
    | 'permission_denied' | 'scope_denied' | 'ambiguous_path' | 'workspace_unavailable' | 'relative_base_required';
  readonly content: string;
  readonly size?: number;
  readonly resolvedFrom?: string;
  readonly resolvedPath?: string;
  /** Confirmed locations for an explicit human choice; never an authorization ticket. */
  readonly candidates?: readonly { readonly path: string; readonly root: string }[];
  readonly error?: string;
}

/** Bounded presentation metadata from a known local file Tool Result in the same turn.
 * A restored hint must be re-resolved under the current Bot scope before reading. */
export interface BotResourceReferenceHint {
  readonly path: string;
  readonly tool: 'read_file' | 'write_file' | 'edit_file';
}

/** Human-initiated, bounded filename discovery; every selected hit is re-authorized on read. */
export interface BotResourceSearchResult {
  readonly ok: boolean;
  readonly status: LocalDocumentReadResult['status'] | 'not_dir';
  readonly scoped?: boolean;
  readonly workspacePath?: string;
  readonly files: readonly { readonly relPath: string; readonly name: string; readonly kind: 'file' | 'directory' }[];
  readonly truncated?: boolean;
  readonly visited?: number;
  readonly error?: string;
}
