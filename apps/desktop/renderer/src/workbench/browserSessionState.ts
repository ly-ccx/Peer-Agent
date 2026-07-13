const FALLBACK_SESSION_KEY = '__none';
const HOME_URL = 'about:blank';

const browserUrlByConversation = new Map<string, string>();

function sessionKey(conversationId: string | null): string {
  return conversationId ?? FALLBACK_SESSION_KEY;
}

export function getBrowserSessionUrl(conversationId: string | null): string {
  return browserUrlByConversation.get(sessionKey(conversationId)) ?? HOME_URL;
}

export function setBrowserSessionUrl(conversationId: string | null, url: string): void {
  if (!url) return;
  browserUrlByConversation.set(sessionKey(conversationId), url);
}

export function resetBrowserSessionUrlsForTests(): void {
  browserUrlByConversation.clear();
}
