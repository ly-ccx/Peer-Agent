export interface GitDocumentRevision {
  readonly kind: 'git';
  /** Complete immutable commit SHA only; never a branch or Git expression. */
  readonly commit: string;
  /** Host-confirmed device-local repository binding, not an authorization ticket. */
  readonly repositoryId?: string;
}

export interface ConfirmedGitDocumentRevision extends GitDocumentRevision {
  readonly repositoryId: string;
  readonly path: string;
}

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
  /** Conditional text/image read only; an observation never grants access. */
  readonly expectedObservation?: { readonly resourceId: string; readonly contentVersion?: string };
  readonly revision?: GitDocumentRevision;
}

/** Device-local locator identity, revalidated by the host on every access. */
export interface LocalDocumentIdentity {
  readonly sourceId: string;
  readonly resourceId: string;
  readonly relativePath: string;
}

/** Version of the actual bytes returned by a successful read; not a saved snapshot. */
export interface LocalDocumentObservation extends LocalDocumentIdentity {
  readonly contentVersion: string;
}

export interface LocalDocumentReadResult {
  readonly metadataOnly?: boolean;
  readonly ok: boolean;
  readonly status: 'ok' | 'not_found' | 'not_file' | 'too_large' | 'binary' | 'invalid_path' | 'error'
    | 'permission_denied' | 'scope_denied' | 'ambiguous_path' | 'workspace_unavailable' | 'relative_base_required'
    | 'version_changed' | 'source_changed' | 'version_unavailable'
    | 'not_git_repo' | 'invalid_ref' | 'revision_unavailable' | 'unsupported_entry';
  readonly content: string;
  readonly size?: number;
  readonly resolvedFrom?: string;
  readonly resolvedPath?: string;
  readonly identity?: LocalDocumentIdentity;
  readonly observation?: LocalDocumentObservation;
  readonly revision?: ConfirmedGitDocumentRevision;
  /** Confirmed locations for an explicit human choice; never an authorization ticket. */
  readonly candidates?: readonly { readonly path: string; readonly root: string }[];
  /** Bot project root used when a file citation was not found. Not an authorization root. */
  readonly attemptedRoot?: string;
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
