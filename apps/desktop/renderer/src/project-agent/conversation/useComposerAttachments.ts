import { useCallback, useEffect, useRef, useState } from 'react';
import { intakeAttachments } from '../../chat/state/attachmentIntake';
import type { ProjectInputAttachment } from '@peer-agent/protocol';

/** Serialize reads so paste/drop/picker races cannot overflow or cross a send. */
export function useComposerAttachments(isZh: boolean) {
  const [attachments, setAttachments] = useState<readonly ProjectInputAttachment[]>([]);
  const current = useRef<readonly ProjectInputAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const reads = useRef(0);
  const queue = useRef(Promise.resolve());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const replace = useCallback((next: readonly ProjectInputAttachment[]) => {
    current.current = next;
    if (mounted.current) setAttachments(next);
  }, []);
  const add = useCallback((files: readonly File[]) => {
    if (!files.length) return;
    reads.current += 1;
    setReading(true);
    queue.current = queue.current.then(async () => {
      if (!mounted.current) return;
      const result = await intakeAttachments([...files], current.current.length, isZh);
      if (!mounted.current) return;
      replace([...current.current, ...result.attachments]);
      setError(result.error);
    }).catch(cause => {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Failed to read attachment');
    }).finally(() => {
      reads.current -= 1;
      if (mounted.current) setReading(reads.current > 0);
    });
  }, [isZh, replace]);
  return { attachments, error, reading, add,
    isReading: () => reads.current > 0,
    remove: (id: string) => { replace(current.current.filter(item => item.id !== id)); setError(null); },
    clear: () => { replace([]); setError(null); },
  };
}
