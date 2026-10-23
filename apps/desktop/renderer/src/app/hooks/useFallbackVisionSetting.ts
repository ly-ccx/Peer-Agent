import { clientApi } from '../../clientApi';
import { useEditableResource } from '../../ui/forms/useEditableResource';
import { useUnsavedChanges } from '../../ui/forms/UnsavedChanges';

function read(settings: Record<string, unknown>) {
  const value = settings.fallbackVision;
  return typeof value === 'string' ? value.trim() : value && typeof value === 'object' && typeof (value as { providerId?: unknown }).providerId === 'string' ? String((value as { providerId: string }).providerId).trim() : '';
}
export function useFallbackVisionSetting() {
  const form = useEditableResource('settings.fallback-vision', '', {
    read: async () => read(await clientApi.getSettings()),
    write: async draft => read(await clientApi.updateSettings({ fallbackVision: draft ? { providerId: draft } : null })),
  });
  useUnsavedChanges({ dirty: form.dirty, busy: form.saving, save: form.save, discard: form.reset });
  const change = async (value: string) => {
    if (!form.loaded || form.saving) return;
    form.edit(value === '__none__' ? '' : value); await form.save();
  };
  return { ...form, change };
}
