/** ADR106/131: the existing Git Provider's concrete local read approval shape.
 * This is an audit scope, never a deserializable execution authority token.
 */
export interface LocalReadPermissionScope {
  readonly kind: 'file-read';
  readonly capabilityId: string;
  readonly path: string;
  readonly workspacePath: string | null;
}
