import { createContext, useContext, type ReactNode } from 'react';
import type { ResourceFeedback, ResourceFeedbackRecipient } from '@peer-agent/protocol';
import { prepareResourceFeedbackDraft } from './feedbackDraft';
export interface ResourceFeedbackPort {
  readonly recipient: ResourceFeedbackRecipient;
  readonly prepare: (feedback: ResourceFeedback) => Promise<{ readonly ok: boolean; readonly code?: string }>;
}
const Context = createContext<ResourceFeedbackPort | null>(null);
export const useResourceFeedback = () => useContext(Context);
export function ResourceFeedbackProvider({ recipient, prepare = prepareResourceFeedbackDraft, children }: {
  readonly recipient: ResourceFeedbackRecipient | null; readonly prepare?: ResourceFeedbackPort['prepare']; readonly children: ReactNode;
}) {
  return <Context.Provider value={recipient ? { recipient, prepare } : null}>{children}</Context.Provider>;
}
