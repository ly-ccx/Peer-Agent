import { useSyncExternalStore } from 'react';
import { highlightLanguageRevision, subscribeHighlightLanguages } from './codeHighlighter';

export function useHighlightLanguages() {
  return useSyncExternalStore(subscribeHighlightLanguages, highlightLanguageRevision, highlightLanguageRevision);
}
