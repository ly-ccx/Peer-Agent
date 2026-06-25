/**
 * 内嵌浏览器操控工具定义（Manifest）—— 见 ADR 40（local.web.control）。
 *
 * 这些工具经正规运行时链路暴露：
 *   Capability Provider(local.web.control.*) → Manifest(本文件) → Runtime Projection
 *     → Tool Call(browser_*) → PermissionGrant → Evidence
 *
 * 用途：让 Agent 操控「用户眼前那个可见的」Workbench 浏览器面板（<webview>）：
 * 导航、点击、输入、截图、读取 DOM。renderer 在 webview dom-ready 后把
 * getWebContentsId() 上报给 main（见 browser-control-registry.mjs），provider 用
 * webContents.fromId(id) 直接操控同一个 WebContents，操作对用户实时可见。
 *
 * 风险与授权：这是「联网/外部副作用」能力（L3_external_write）。由 provider 经
 * requestPermission 询问授权，同一会话内的浏览器操控授权一次后复用。截图与 DOM
 * 落本地 artifact，仅向模型返回摘要 + artifactRef（evidencePolicy=artifact_ref）。
 */

export const BROWSER_TOOL_NAMES = Object.freeze({
  navigate: 'browser_navigate',
  click: 'browser_click',
  type: 'browser_type',
  screenshot: 'browser_screenshot',
  readDom: 'browser_read_dom',
});

/**
 * 子能力 → 工具名映射。provider 以 Object.keys(本表) 作为 capabilityIds，
 * 并按 call.capabilityId 分流到具体工具（仿 local.file provider）。
 */
export const BROWSER_CAPABILITY_TO_TOOL = Object.freeze({
  'local.web.control.navigate': BROWSER_TOOL_NAMES.navigate,
  'local.web.control.click': BROWSER_TOOL_NAMES.click,
  'local.web.control.type': BROWSER_TOOL_NAMES.type,
  'local.web.control.screenshot': BROWSER_TOOL_NAMES.screenshot,
  'local.web.control.readDom': BROWSER_TOOL_NAMES.readDom,
});

const NAVIGATE_PROMPT = [
  'Navigate the visible in-app browser panel (the one the user can see in the Workbench',
  '"Browser" tab) to an absolute http(s) URL. The page loads in that same visible webview,',
  'so the user watches the navigation happen in real time. Returns the final URL and title.',
  'Network access requires user authorization on first use in the session.',
].join(' ');

const CLICK_PROMPT = [
  'Click an element in the visible in-app browser. Provide a CSS "selector" to click the',
  'first matching element, or "x"/"y" viewport coordinates to click a point. The click is',
  'dispatched on the same webview the user is looking at. Returns a short result summary.',
].join(' ');

const TYPE_PROMPT = [
  'Type text into the visible in-app browser. If "selector" is given, the element is focused',
  '(and optionally cleared) first; otherwise text goes to the currently focused element. Set',
  '"submit" to press Enter afterwards. Acts on the same visible webview. Returns a summary.',
].join(' ');

const SCREENSHOT_PROMPT = [
  'Capture a screenshot of the visible in-app browser page. The PNG is stored as a local',
  'artifact and only a summary plus an artifact reference is returned (the image is not',
  'inlined into the model context). Use this to see what the page currently looks like.',
].join(' ');

const READ_DOM_PROMPT = [
  'Read text/HTML content from the visible in-app browser DOM. Provide an optional CSS',
  '"selector" to scope extraction (defaults to document.body). The extracted content is',
  'stored as a local artifact; only a truncated summary plus an artifact reference is',
  'returned. Use this to understand page structure before clicking or typing.',
].join(' ');

const BROWSER_CONTROL_RUNTIME = Object.freeze({
  adapter: 'runtime-gateway.local-browser-control-provider',
});

function navigateTool() {
  return {
    name: BROWSER_TOOL_NAMES.navigate,
    capabilityId: 'local.web.control.navigate',
    prompt: () => NAVIGATE_PROMPT,
    runtime: Object.freeze({
      ...BROWSER_CONTROL_RUNTIME,
      executorCapabilityId: 'local.web.control.navigate',
    }),
    permissionPolicy: { kind: 'browser-control' },
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The absolute http(s) URL to load in the visible browser.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  };
}

function clickTool() {
  return {
    name: BROWSER_TOOL_NAMES.click,
    capabilityId: 'local.web.control.click',
    prompt: () => CLICK_PROMPT,
    runtime: Object.freeze({
      ...BROWSER_CONTROL_RUNTIME,
      executorCapabilityId: 'local.web.control.click',
    }),
    permissionPolicy: { kind: 'browser-control' },
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector of the element to click (first match).',
        },
        x: {
          type: 'number',
          description: 'Viewport X coordinate to click (used when selector is omitted).',
        },
        y: {
          type: 'number',
          description: 'Viewport Y coordinate to click (used when selector is omitted).',
        },
      },
      additionalProperties: false,
    },
  };
}

function typeTool() {
  return {
    name: BROWSER_TOOL_NAMES.type,
    capabilityId: 'local.web.control.type',
    prompt: () => TYPE_PROMPT,
    runtime: Object.freeze({
      ...BROWSER_CONTROL_RUNTIME,
      executorCapabilityId: 'local.web.control.type',
    }),
    permissionPolicy: { kind: 'browser-control' },
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to type into the page.',
        },
        selector: {
          type: 'string',
          description: 'Optional CSS selector to focus before typing.',
        },
        clear: {
          type: 'boolean',
          description: 'Clear the target field before typing. Defaults to false.',
        },
        submit: {
          type: 'boolean',
          description: 'Press Enter after typing. Defaults to false.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  };
}

function screenshotTool() {
  return {
    name: BROWSER_TOOL_NAMES.screenshot,
    capabilityId: 'local.web.control.screenshot',
    prompt: () => SCREENSHOT_PROMPT,
    runtime: Object.freeze({
      ...BROWSER_CONTROL_RUNTIME,
      executorCapabilityId: 'local.web.control.screenshot',
    }),
    permissionPolicy: { kind: 'browser-control' },
    inputSchema: {
      type: 'object',
      properties: {
        fullPage: {
          type: 'boolean',
          description: 'Reserved; currently captures the visible viewport. Defaults to false.',
        },
      },
      additionalProperties: false,
    },
  };
}

function readDomTool() {
  return {
    name: BROWSER_TOOL_NAMES.readDom,
    capabilityId: 'local.web.control.readDom',
    prompt: () => READ_DOM_PROMPT,
    runtime: Object.freeze({
      ...BROWSER_CONTROL_RUNTIME,
      executorCapabilityId: 'local.web.control.readDom',
    }),
    permissionPolicy: { kind: 'browser-control' },
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'Optional CSS selector to scope extraction (defaults to document.body).',
        },
        maxChars: {
          type: 'number',
          description: 'Max characters to summarize back (full content goes to artifact).',
        },
      },
      additionalProperties: false,
    },
  };
}

export const BROWSER_TOOL_DEFINITIONS = [
  navigateTool(),
  clickTool(),
  typeTool(),
  screenshotTool(),
  readDomTool(),
];
