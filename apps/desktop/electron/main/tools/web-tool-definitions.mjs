/**
 * Web 能力本地工具定义（Manifest）—— 见 ADR 38（local.web.fetch）。
 *
 * 该工具经正规运行时链路暴露：
 *   Capability Provider(local.web.fetch) → Manifest(本文件) → Runtime Projection
 *     → Tool Call(web_fetch) → PermissionGrant → Evidence
 *
 * 用途：当用户给出文档/网页链接需要 agent 读取时，agent 调用本工具，由本地
 * 隐藏浏览器窗口加载页面、抽取正文，正文落本地 artifact，仅返回 标题 + 摘要 +
 * 最终 URL + artifactRef。
 *
 * 这是「联网」能力（L3_external_write）：首次联网由 permission-gate / provider 经
 * requestPermission 询问授权，授权真值留在 main 进程，不落 renderer state。
 */

export const WEB_TOOL_NAMES = Object.freeze({
  webFetch: 'web_fetch',
});

const WEB_FETCH_PROMPT = [
  'Fetch a web page and return its main readable content.',
  'Use this when the user provides a document/article URL (or asks you to read a link)',
  'and you need the page content. The page is loaded locally through a hidden browser',
  'window (handles JavaScript-rendered pages) and falls back to a static HTTP GET.',
  'The full body is stored as a local artifact; the tool returns the title, the final URL',
  '(after redirects), and a content summary plus an artifact reference.',
  'Network access requires user authorization on first use.',
].join(' ');

export const WEB_TOOL_DEFINITIONS = [
  {
    name: WEB_TOOL_NAMES.webFetch,
    capabilityId: 'local.web.fetch',
    prompt: () => WEB_FETCH_PROMPT,
    runtime: Object.freeze({
      adapter: 'runtime-gateway.local-web-provider',
      executorCapabilityId: 'local.web.fetch',
    }),
    permissionPolicy: {
      kind: 'web-fetch',
    },
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The absolute http(s) URL of the page to fetch.',
        },
        waitForRender: {
          type: 'boolean',
          description:
            'Whether to wait for client-side rendering before extracting content. Defaults to true.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Navigation timeout in milliseconds. Defaults to 30000.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
];
