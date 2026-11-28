import { normalizeInputPredictionSettings, type InputPredictionSettings } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';

let value = normalizeInputPredictionSettings(null), loaded = false;
let request: Promise<void> | null = null;
let workspaces: readonly { id: string; path: string }[] = [];
const listeners = new Set<() => void>();

function samePreferences(a: InputPredictionSettings, b: InputPredictionSettings): boolean {
  return a.enabled === b.enabled
    && a.continuationEnabled === b.continuationEnabled
    && a.dailyRequestLimit === b.dailyRequestLimit
    && a.dailyTokenLimit === b.dailyTokenLimit
    && a.disabledWorkspaceIds.length === b.disabledWorkspaceIds.length
    && a.disabledWorkspaceIds.every((id, index) => id === b.disabledWorkspaceIds[index]);
}

export function publishInputPredictionPreferences(next: unknown) {
  const normalized = normalizeInputPredictionSettings(next);
  const unchanged = loaded && samePreferences(value, normalized);
  loaded = true;
  if (unchanged) return;
  value = normalized;
  for (const listener of listeners) listener();
}
export const inputPredictionPreferences = {
  getSnapshot: (): InputPredictionSettings => value,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  workspaceIdFor(path: string | null | undefined) { return workspaces.find(row => row.path === path)?.id ?? ''; },
  async refresh() {
    if (!request) request = clientApi.getSettings().then(settings => {
      workspaces = Array.isArray(settings.workspaces) ? settings.workspaces : [];
      publishInputPredictionPreferences(settings.inputPrediction);
    }).catch(() => { if (!loaded) publishInputPredictionPreferences(null); }).finally(() => { request = null; });
    await request;
  },
};
