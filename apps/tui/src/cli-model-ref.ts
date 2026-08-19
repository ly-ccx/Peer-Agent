/**
 * Exec model binding.
 *
 * Protocol identity is `providerId::modelId` (`contextAccountingModelKey`).
 * Do not join with `/` — OpenRouter model ids already contain slashes.
 *
 * CLI accepts either two fields or the same composite on `--model`.
 */

export const EXEC_MODEL_SEPARATOR = '::';

export interface ExecCatalogEntry {
  readonly providerId: string;
  readonly modelId: string;
  readonly available?: boolean;
  readonly entryId?: string;
}

export interface ExecModelRef {
  readonly provider?: string;
  readonly model?: string;
}

export function formatExecModelRef(
  providerId: string,
  modelId: string,
): string {
  return `${providerId}${EXEC_MODEL_SEPARATOR}${modelId}`;
}

export function parseExecModelToken(value: string): {
  readonly provider?: string;
  readonly model: string;
} {
  const trimmed = value.trim();
  const separator = trimmed.indexOf(EXEC_MODEL_SEPARATOR);
  if (separator <= 0) return { model: trimmed };
  const provider = trimmed.slice(0, separator).trim();
  const model = trimmed.slice(separator + EXEC_MODEL_SEPARATOR.length).trim();
  if (!provider || !model) return { model: trimmed };
  return { provider, model };
}

export function resolveExecCatalogEntry(
  catalog: readonly ExecCatalogEntry[],
  ref: ExecModelRef,
):
  | { readonly ok: true; readonly entry: ExecCatalogEntry }
  | { readonly ok: false; readonly message: string } {
  const qualified = ref.model ? parseExecModelToken(ref.model) : undefined;
  if (ref.provider && qualified?.provider && ref.provider !== qualified.provider) {
    return {
      ok: false,
      message:
        `peer exec: --provider ${ref.provider} conflicts with --model ${ref.model}`,
    };
  }

  const providerToken = ref.provider ?? qualified?.provider;
  const modelToken = qualified?.model;

  let candidates = [...catalog];
  if (providerToken) {
    candidates = candidates.filter((entry) =>
      entry.providerId === providerToken || entry.entryId === providerToken);
    if (candidates.length === 0) {
      return {
        ok: false,
        message: `peer exec: unknown --provider ${providerToken}`,
      };
    }
  }
  if (modelToken) {
    candidates = candidates.filter((entry) => entry.modelId === modelToken);
    if (candidates.length === 0) {
      return {
        ok: false,
        message: providerToken
          ? `peer exec: unknown --model ${modelToken} for provider ${providerToken}`
          : `peer exec: unknown --model ${modelToken}`,
      };
    }
  }

  if (candidates.length === 1) {
    return { ok: true, entry: candidates[0]! };
  }

  const available = candidates.filter((entry) => entry.available);
  if (available.length === 1) {
    return { ok: true, entry: available[0]! };
  }

  const ambiguous = (available.length > 1 ? available : candidates)
    .map((entry) => `  ${formatExecModelRef(entry.providerId, entry.modelId)}`)
    .join('\n');
  const subject = modelToken
    ? `--model ${modelToken}`
    : providerToken
      ? `--provider ${providerToken}`
      : `--model ${ref.model}`;
  return {
    ok: false,
    message: [
      `peer exec: ${subject} is ambiguous. Use --provider <id> or --model <provider>::<model>:`,
      ambiguous,
    ].join('\n'),
  };
}
