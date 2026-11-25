import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

/** The optional v1 extension; legacy Helpers may still serve fresh tokens. */
export interface ModelOAuthVault {
  getSecret(key: string): string | null;
  supportsModelOAuthCas?(): boolean;
  getSnapshot?(key: string): { readonly secret: string | null; readonly revision: string | null };
  compareSet?(key: string, revision: string | null, secret: string | null): boolean;
}
export interface ModelOAuthTokens {
  readonly access: string;
  readonly expires?: number;
}
interface Receipt {
  readonly client: ModelOAuthVault;
  readonly key: string;
  readonly secret: string;
  readonly revision: string | null;
  readonly conditional: boolean;
  readonly view: object;
  readonly project?: (value: Record<string, unknown>) => object;
}
// A receipt belongs to the actual decoded read, not to caller-supplied JSON.
// Weak ownership retains neither completed requests nor historical token objects.
const receipts = new WeakMap<object, Receipt>();
function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
function decode(secret: string): Record<string, unknown> {
  if (Buffer.byteLength(secret) > 65536) fail('credential_oauth_tokens_invalid');
  let value: unknown;
  try { value = JSON.parse(secret); } catch { fail('credential_oauth_tokens_invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('credential_oauth_tokens_invalid');
  return value as Record<string, unknown>;
}
function ready(value: Record<string, unknown>): void {
  if (Object.hasOwn(value, 'peerModelRefresh')) fail('credential_oauth_refresh_pending');
}
function snapshot(client: ModelOAuthVault, key: string) {
  const conditional = client.supportsModelOAuthCas?.() === true;
  if (conditional) {
    if (!client.getSnapshot || !client.compareSet) fail('credential_oauth_helper_upgrade_required');
    return { ...client.getSnapshot(key), conditional };
  }
  return { secret: client.getSecret(key), revision: null, conditional };
}

/** Reads the same encrypted record and retains its opaque generation in memory. */
export function readModelOAuthTokens<T extends object>(client: ModelOAuthVault, key: string,
  project?: (value: Record<string, unknown>) => T): T | null {
  const current = snapshot(client, key);
  if (current.secret === null) return null;
  const raw = decode(current.secret);
  ready(raw);
  const tokens = project ? project(raw) : raw as T;
  receipts.set(tokens, { client, key, ...current, secret: current.secret, view: decode(JSON.stringify(tokens)), project });
  return tokens;
}

/**
 * Serializes a stored account's refresh with native hosts before any remote call.
 * The caller owns transport deadlines/cancellation. Once invoked, a failed remote
 * operation leaves the encrypted intent unresolved; it must never be replayed.
 * Configuration validation is synchronous and runs before dispatch and commit.
 * Metadata hints are not written here and cannot roll back a committed token.
 */
export async function refreshModelOAuthTokens<T extends ModelOAuthTokens>({
  client, key, authMethod, tokens, refresh, validate = () => {}, force = false,
  withConfiguration = action => action(),
}: {
  readonly client: ModelOAuthVault;
  readonly key: string;
  readonly authMethod: string;
  readonly tokens: T;
  readonly refresh: (tokens: T) => Promise<{ tokens: T; refreshed: boolean }>;
  readonly validate?: () => void;
  readonly force?: boolean;
  /** Own the host's short config -> Vault transaction; never wrap HTTP waits. */
  readonly withConfiguration?: <R>(action: () => R) => R;
}): Promise<{ tokens: T; refreshed: boolean }> {
  if (!['oauth_chatgpt', 'oauth_grok'].includes(authMethod)) fail('credential_oauth_auth_unsupported');
  const receipt = receipts.get(tokens);
  if (!receipt || receipt.client !== client || receipt.key !== key
      || !isDeepStrictEqual(tokens, receipt.view)) fail('credential_oauth_snapshot_required');
  const original = decode(receipt.secret);
  ready(original);
  if (typeof tokens.access !== 'string' || !tokens.access) fail('credential_oauth_tokens_invalid');
  if (authMethod === 'oauth_grok' && (typeof original.scope !== 'string'
      || !original.scope.split(/\s+/).includes('api:access'))) fail('grok_oauth_scope_upgrade_required');
  let effect: 'reservation' | 'commit' | null = null;
  const guarded = <R>(action: () => R): R => {
    try { return withConfiguration(action); }
    catch (error) {
      if (effect && error instanceof Error && ['model_config_lock_changed', 'model_config_commit_unknown'].includes(error.message)) {
        fail(effect === 'reservation' ? 'credential_oauth_reservation_unknown' : 'credential_oauth_commit_unknown');
      }
      throw error;
    }
  };
  const claim = guarded(() => {
    validate();
    const current = snapshot(client, key);
    if (current.secret !== receipt.secret || current.revision !== receipt.revision
        || current.conditional !== receipt.conditional) fail('credential_oauth_changed');
    if (!force && Number.isSafeInteger(tokens.expires) && tokens.expires! > Date.now() + 60_000) return null;
    if (!current.conditional || !client.compareSet || !client.getSnapshot) fail('credential_oauth_helper_upgrade_required');
    const pending = JSON.stringify({ ...original, peerModelRefresh: {
      schemaVersion: 1, attemptId: randomUUID(), authMethod, phase: 'in_flight', createdAt: Date.now(),
    } });
    decode(pending);
    effect = 'reservation';
    if (!client.compareSet(key, current.revision, pending)) fail('credential_oauth_changed');
    const claim = client.getSnapshot(key);
    if (claim.secret !== pending || claim.revision === null) fail('credential_oauth_changed');
    validate();
    return claim;
  });
  if (claim === null) return { tokens, refreshed: false };
  const result = await refresh(tokens);
  return guarded(() => {
    validate();
    let updated = receipt.secret;
    if (result.refreshed) {
      const next = decode(JSON.stringify(result.tokens));
      ready(next);
      if (typeof next.access !== 'string' || !next.access || !Number.isSafeInteger(next.expires)
          || (next.expires as number) <= Date.now()) fail('credential_oauth_refresh_invalid');
      updated = JSON.stringify({ ...original, ...next });
      decode(updated); // Unknown preserved fields also count toward the record cap.
    } else if (!isDeepStrictEqual(result.tokens, receipt.view)) {
      fail('credential_oauth_refresh_invalid');
    }
    if (!client.compareSet || !client.getSnapshot) fail('credential_oauth_helper_upgrade_required');
    effect = 'commit';
    if (!client.compareSet(key, claim.revision, updated)) fail('credential_oauth_changed');
    const committed = client.getSnapshot(key);
    if (committed.secret !== updated || committed.revision === null) fail('credential_oauth_commit_unknown');
    const next = receipt.project ? receipt.project(decode(updated)) : decode(updated);
    receipts.set(next, { client, key, secret: updated, revision: committed.revision, conditional: true,
      view: decode(JSON.stringify(next)), project: receipt.project });
    return { tokens: next as unknown as T, refreshed: result.refreshed };
  });
}
