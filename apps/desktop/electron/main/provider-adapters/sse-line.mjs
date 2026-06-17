// 共享的 SSE 行解析（三个 provider adapter: anthropic-messages / openai-chat /
// openai-responses 复用同一口径），避免在多处散落易碎的前缀判断。
//
// 背景：此前各 adapter 用 `trimmed.startsWith('data: ')` + `slice(6)` 解析 SSE，
// 硬编码了 "data:" 后必须跟一个空格。但 SSE 规范(WHATWG)规定 `data:` 字段值前的
// 单个前导空格是可选的：合规网关既可发 `data: {...}`，也可发 `data:{...}`。
// 部分网关(如 1688 anthropic 网关 https://claude-1688-gateway.alibaba-inc.com)
// 输出无空格的 `data:{...}`，导致每行都被当成 ignored_line，真实对话流式结果为空，
// 而非流式的连通性测试(只看 HTTP 200)却能通过。
//
// 解析口径：识别以 `data:` 开头的行，剥离字段名后至多一个前导空格，返回 payload；
// 其余行(如 `event:` / 注释 / 空行)返回 null，交由调用方记录为 ignored。

/**
 * 从单行 SSE 文本中提取 data 字段的 payload。
 * @param {string} trimmedLine 已 trim 的单行文本
 * @returns {string | null} data 字段的值；非 data 行返回 null
 */
export function parseSseDataPayload(trimmedLine) {
  if (typeof trimmedLine !== 'string') return null;
  if (!trimmedLine.startsWith('data:')) return null;
  // 剥离 "data:" 前缀，再按 SSE 规范去掉至多一个前导空格。
  let payload = trimmedLine.slice(5);
  if (payload.startsWith(' ')) payload = payload.slice(1);
  return payload;
}
