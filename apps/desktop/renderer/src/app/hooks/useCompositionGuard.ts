import { useEffect, useRef } from 'react';
import { createCompositionGuard } from '../../chat/state/compositionGuard';
export function useCompositionGuard() {
  const guard = useRef<ReturnType<typeof createCompositionGuard> | null>(null);
  if (!guard.current) guard.current = createCompositionGuard();
  useEffect(() => () => guard.current?.reset(), []);
  return guard.current;
}
