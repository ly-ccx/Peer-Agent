import { useCallback, useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';
import { projectAgentModeEnabled } from '../components/settings/developerPanelState';

/** Last server snapshot of developer.projectAgentMode. The renderer does not own the value. */
export function useDeveloperFlag() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<'load' | 'save' | ''>('');

  const reload = useCallback(async () => {
    const settings = await clientApi.getDeveloperSettings();
    setEnabled(projectAgentModeEnabled(settings));
    setError('');
  }, []);

  useEffect(() => {
    let cancelled = false;
    reload().catch(() => {
      if (!cancelled) setError('load');
    });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const setProjectAgentMode = useCallback(async (value: boolean) => {
    setError('');
    try {
      const settings = await clientApi.updateDeveloperSettings({ projectAgentMode: value });
      setEnabled(projectAgentModeEnabled(settings));
    } catch {
      setError('save');
    }
  }, []);

  return { enabled, error, reload, setProjectAgentMode };
}
