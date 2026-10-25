import { useContext, useMemo, type ReactNode } from 'react';
import type { BotResourceReferenceHint } from '@peer-agent/protocol';
import { DocumentPreviewContext } from '../../chat/components/markdown/DocumentPreviewContext';
import { botResourceCandidates, resolveBotResourceDisplay } from '../state/botResourceReference';

/** Only this exact turn's structured sources can expand its shortened display paths. */
export function ReplyResourceContext({ references = [], children }: {
  readonly references?: readonly BotResourceReferenceHint[]; readonly children: ReactNode;
}) {
  const parent = useContext(DocumentPreviewContext);
  const adapter = useMemo(() => parent ? { ...parent,
    resolve: (path: string) => resolveBotResourceDisplay(path, references),
    locate: (path: string) => parent.locate?.(path, botResourceCandidates(path, references)),
  } : null, [parent, references]);
  return <DocumentPreviewContext.Provider value={adapter}>{children}</DocumentPreviewContext.Provider>;
}
