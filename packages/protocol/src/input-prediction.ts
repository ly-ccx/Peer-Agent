/** Suggestions are ephemeral presentation data, never input receipts or grants. */
export type InputPredictionMode = 'next_turn' | 'continuation';
export type InputPredictionSurface = 'desktop_bot' | 'desktop_classic';

export interface InputPredictionSettings {
  readonly schemaVersion: 1;
  readonly enabled: boolean;
  readonly continuationEnabled: boolean;
  readonly disabledWorkspaceIds: readonly string[];
  readonly dailyRequestLimit: number;
  readonly dailyTokenLimit: number;
}

export const INPUT_PREDICTION_LIMITS = Object.freeze({
  inputTokens: 4096, outputTokens: 128, draftLength: 2048,
  candidateLength: 240, candidateGraphemes: 120,
  timeoutMs: 2000, validationMs: 150, ttlMs: 60_000,
  requestIntervalMs: 3000, requestsPerMinute: 12,
});

export function normalizeInputPredictionSettings(value: unknown): InputPredictionSettings {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const input = raw.schemaVersion === undefined || raw.schemaVersion === 1 ? raw : {};
  const limit = (value: unknown, fallback: number) => typeof value === 'number'
    && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  return {
    schemaVersion: 1,
    enabled: input.enabled === true,
    continuationEnabled: input.continuationEnabled === true,
    disabledWorkspaceIds: Array.isArray(input.disabledWorkspaceIds)
      ? [...new Set(input.disabledWorkspaceIds.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200))] : [],
    dailyRequestLimit: limit(input.dailyRequestLimit, 100),
    dailyTokenLimit: limit(input.dailyTokenLimit, 100_000),
  };
}

export interface InputPredictionRequest {
  readonly requestId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly composerInstanceId: string;
  readonly surface: InputPredictionSurface;
  readonly mode: InputPredictionMode;
  readonly draftVersion: number;
  readonly draftText: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly quoteMessageId?: string;
}

export interface InputCandidate {
  readonly candidateId: string;
  readonly requestId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly composerInstanceId: string;
  readonly mode: InputPredictionMode;
  readonly insertionText: string;
  readonly draftVersion: number;
  /** Host context identity only. This conveys no permission. */
  readonly contextToken: string;
  readonly expiresAt: string;
}

export type InputPredictionResult =
  | { readonly kind: 'candidate'; readonly candidate: InputCandidate }
  | { readonly kind: 'none'; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'error'; readonly code: string };

export interface InputPredictionReference {
  readonly composerInstanceId: string;
  readonly requestId: string;
  readonly candidateId?: string;
}
export type InputPredictionValidation = { readonly kind: 'valid' | 'stale' | 'expired' | 'unavailable' };
export interface InputPredictionPort {
  request(request: InputPredictionRequest): Promise<InputPredictionResult>;
  cancel(reference: InputPredictionReference): Promise<unknown>;
  validate(reference: InputPredictionReference): Promise<InputPredictionValidation>;
}

export interface InputPredictionStatus {
  readonly reason: 'ready' | 'disabled' | 'model_unconfigured' | 'budget' | 'usage_unavailable' | 'provider_error';
  readonly requests: number;
  readonly tokens: number;
  readonly estimated: boolean;
}

export function isInputPredictionRequest(value: unknown): value is InputPredictionRequest {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  const id = (key: string) => typeof row[key] === 'string' && (row[key] as string).length > 0 && (row[key] as string).length <= 200;
  return ['requestId', 'workspaceId', 'conversationId', 'composerInstanceId'].every(id)
    && ['desktop_bot', 'desktop_classic'].includes(String(row.surface))
    && ['next_turn', 'continuation'].includes(String(row.mode))
    && Number.isSafeInteger(row.draftVersion) && Number(row.draftVersion) >= 0
    && typeof row.draftText === 'string' && row.draftText.length <= INPUT_PREDICTION_LIMITS.draftLength
    && Number.isSafeInteger(row.selectionStart) && Number.isSafeInteger(row.selectionEnd)
    && Number(row.selectionStart) >= 0 && Number(row.selectionStart) === Number(row.selectionEnd)
    && Number(row.selectionEnd) === row.draftText.length
    && (row.mode === 'next_turn' ? row.draftText === '' : row.draftText.length > 0)
    && (row.quoteMessageId === undefined || id('quoteMessageId'));
}

export function isInputPredictionReference(value: unknown): value is InputPredictionReference {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return ['composerInstanceId', 'requestId'].every(key => typeof row[key] === 'string' && row[key].length > 0 && row[key].length <= 200)
    && (row.candidateId === undefined || typeof row.candidateId === 'string' && row.candidateId.length > 0 && row.candidateId.length <= 200);
}
