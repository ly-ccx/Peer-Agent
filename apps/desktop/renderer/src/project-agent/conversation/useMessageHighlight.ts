import { useEffect, useRef, useState } from 'react';

/** Start the feedback after paged or virtualized content actually appears. */
export function useMessageHighlight(id: string | null, requestId: number, visible: boolean) {
  const shown = useRef({ request: '', until: 0 });
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!id || !visible) { setActive(null); shown.current.until = 0; return; }
    const request = `${requestId}:${id}`;
    if (shown.current.request !== request) shown.current = { request, until: Date.now() + 1800 };
    const remaining = shown.current.until - Date.now();
    if (remaining <= 0) { setActive(null); return; }
    setActive(id);
    // A StrictMode effect replay rearms the remaining time, without replaying the feedback.
    const timer = setTimeout(() => setActive(null), remaining);
    return () => clearTimeout(timer);
  }, [id, requestId, visible]);
  return visible ? active : null;
}
