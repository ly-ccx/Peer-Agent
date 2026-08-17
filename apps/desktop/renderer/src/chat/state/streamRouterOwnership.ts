/**
 * App 顶层流路由器与各 ChatSurface 之间的副作用桥。
 * 订阅本身只挂一份；浏览器工具自动展开仍按会话分发给当前挂载的工作台。
 */

type BrowserToolRevealHandler = (tool: string) => void;

const browserToolRevealHandlers = new Map<string, Set<BrowserToolRevealHandler>>();

export function registerBrowserToolReveal(
  conversationId: string | null | undefined,
  handler: BrowserToolRevealHandler,
): () => void {
  if (!conversationId) return () => {};
  let handlers = browserToolRevealHandlers.get(conversationId);
  if (!handlers) {
    handlers = new Set();
    browserToolRevealHandlers.set(conversationId, handlers);
  }
  handlers.add(handler);
  return () => {
    const current = browserToolRevealHandlers.get(conversationId);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) browserToolRevealHandlers.delete(conversationId);
  };
}

export function dispatchBrowserToolReveal(
  conversationId: string | null | undefined,
  tool: string,
): void {
  if (!conversationId) return;
  const handlers = browserToolRevealHandlers.get(conversationId);
  if (!handlers) return;
  for (const handler of handlers) handler(tool);
}

export function resetBrowserToolRevealHandlersForTests(): void {
  browserToolRevealHandlers.clear();
}
