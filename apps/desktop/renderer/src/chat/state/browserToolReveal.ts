/**
 * Browser 面板只响应当前前台会话的内置可见浏览器工具。
 * 工具执行、权限与 Evidence 仍由 Runtime Gateway 负责；这里仅决定表达层是否聚焦面板。
 */
export function shouldRevealBrowserPanel(
  tool: string,
  conversationId: string,
  activeConversationId: string | null,
): boolean {
  return conversationId === activeConversationId && tool.startsWith('browser_');
}
