import { normalizeInputPredictionSettings, type InputPredictionSettings } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';

let value = normalizeInputPredictionSettings(null), loaded = false;
let request: Promise<void> | null = null;
let workspaces: readonly { id: string; path: string }[] = [];
const listeners = new Set<() => void>();
export function publishInputPredictionPreferences(next: unknown) {
  value = normalizeInputPredictionSettings(next); loaded = true;
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
