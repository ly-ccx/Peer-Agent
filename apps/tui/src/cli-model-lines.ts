export interface CliModelRow {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
}

export function selectableModelRows(catalog: readonly {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly available?: boolean;
}[]): readonly CliModelRow[] {
  return catalog
    .filter((entry) => entry.available !== false)
    .map((entry) => ({
      providerId: entry.providerId,
      modelId: entry.modelId,
      displayName: entry.displayName,
    }));
}

export function formatModelLines(models: readonly CliModelRow[]): string {
  return models
    .map((model) => `${model.providerId}\t${model.modelId}\t${model.displayName.replace(/[\t\r\n]+/g, ' ')}`)
    .join('\n');
}
