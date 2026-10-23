import { useLayoutEffect, useRef, useState } from 'react';
import { useGuardedNavigation, useUnsavedChanges } from '../../ui/forms/UnsavedChanges';

/** Sensitive connection fields remain in their current editor; never put them in a draft cache. */
export function useProviderFormGuard(form: unknown, open: boolean, busy: boolean, close: () => void, save?: () => Promise<boolean>) {
  const [baseline, setBaseline] = useState('');
  const latest = useRef({ form, close }); latest.current = { form, close };
  const navigate = useGuardedNavigation();
  useLayoutEffect(() => { setBaseline(open ? JSON.stringify(latest.current.form) : ''); }, [open]);
  const dirty = open && baseline !== '' && JSON.stringify(form) !== baseline;
  useUnsavedChanges({ dirty, busy: open && busy, save, discard: () => latest.current.close() });
  return () => {
    if (!dirty && !busy) return true;
    navigate(() => latest.current.close()); return false;
  };
}
