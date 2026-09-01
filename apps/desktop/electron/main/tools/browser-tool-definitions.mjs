import { DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS } from '@peer-agent/runtime-core';

/**
 * 内嵌浏览器操控工具定义（Manifest）—— 见 ADR 40（local.web.control）。
 *
 * 这些工具经正规运行时链路暴露：
 *   Capability Provider(local.web.control.*) → Manifest(本文件) → Runtime Projection
 *     → Tool Call(browser_*) → PermissionGrant → Evidence
 *
 * 用途：让 Agent 操控当前会话 Workbench 浏览器的活跃网页标签（<webview>）：
 * 导航、点击、输入、悬停、滚动、截图、读取 DOM。renderer 在 webview dom-ready 后把
 * getWebContentsId() 上报给 main（见 browser-control-registry.mjs），provider 用
 * webContents.fromId(id) 直接操控同一个 WebContents，操作对用户实时可见。
 *
 * 风险与授权：这是「联网/外部副作用」能力（L3_external_write）。由 provider 经
 * requestPermission 询问授权，同一会话内的浏览器操控授权一次后复用。截图与 DOM
 * 落本地 artifact，仅向模型返回摘要 + artifactRef（evidencePolicy=artifact_ref）。
 */

export const BROWSER_TOOL_NAMES = Object.freeze({
  openPanel: DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserOpenPanel.toolName,
  navigate: DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserNavigate.toolName,
  click: DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserClick.toolName,
  type: DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserType.toolName,
  screenshot: DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserScreenshot.toolName,
  readDom: DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserReadDom.toolName,
  hover: DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserHover.toolName,
  scroll: DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserScroll.toolName,
  key: DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserKey.toolName,
  drag: DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserDrag.toolName,
});

/**
 * 子能力 → 工具名映射。provider 以 Object.keys(本表) 作为 capabilityIds，
 * 并按 call.capabilityId 分流到具体工具（仿 local.file provider）。
 */
export const BROWSER_CAPABILITY_TO_TOOL = Object.freeze({
  [DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserOpenPanel.capabilityId]: BROWSER_TOOL_NAMES.openPanel,
  [DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserNavigate.capabilityId]: BROWSER_TOOL_NAMES.navigate,
  [DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserClick.capabilityId]: BROWSER_TOOL_NAMES.click,
  [DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserType.capabilityId]: BROWSER_TOOL_NAMES.type,
  [DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserScreenshot.capabilityId]: BROWSER_TOOL_NAMES.screenshot,
  [DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserReadDom.capabilityId]: BROWSER_TOOL_NAMES.readDom,
  [DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserHover.capabilityId]: BROWSER_TOOL_NAMES.hover,
  [DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserScroll.capabilityId]: BROWSER_TOOL_NAMES.scroll,
  [DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserKey.capabilityId]: BROWSER_TOOL_NAMES.key,
  [DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserDrag.capabilityId]: BROWSER_TOOL_NAMES.drag,
});

const BROWSER_CONTROL_MODE_SCOPES = Object.freeze(['chat', 'goal']);

const OPEN_PANEL_PROMPT = [
  'Open the embedded Browser workspace for the current conversation.',
  'This operation is idempotent: it expands the Workbench, selects Browser, and reuses',
  'or creates the conversation Browser session without navigating or duplicating tabs.',
].join(' ');

const NAVIGATE_PROMPT = [
  'Navigate the active browser tab bound to the current conversation (the one shown in the',
  'Workbench "Browser" view) to an absolute http(s) URL. The page loads in that same webview,',
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

const HOVER_PROMPT = [
  'Hover an element in the visible in-app browser. Provide a CSS "selector" to hover the first',
  'matching element (supports optional frame:N prefix), or "x"/"y" viewport coordinates to hover',
  'a point. Use this to reveal tooltips or submenus. The hover is dispatched on the same webview',
  'the user is looking at.',
].join(' ');

const SCROLL_PROMPT = [
  'Scroll the visible in-app browser. Provide an optional CSS "selector" to target an element or',
  'its nearest scrollable ancestor (supports frame:N prefix). Use "deltaX"/"deltaY" for incremental',
  'scroll, or "block"/"inline" (start|center|end|nearest) to scrollIntoView. Without a selector,',
  'the document viewport scrolls. Prefer element scroll over whole-page jumps.',
].join(' ');

const KEY_PROMPT = [
  'Send keyboard keys or shortcuts in the visible in-app browser. Provide "keys" as an ordered',
  'array of whitelist names: Tab, Enter, Escape, Backspace, Delete, ArrowUp/Down/Left/Right,',
  'Home, End, PageUp, PageDown, Space, or Modifier+Key (Meta|Control|Alt|Shift). Optionally',
  'focus a CSS "selector" first (supports frame:N). This is not for typing text; use browser_type',
  'for character insertion. Enter may submit forms.',
].join(' ');

const DRAG_PROMPT = [
  'Drag from a source to a target in the visible in-app browser. Provide fromSelector or',
  'fromX/fromY, and toSelector or toX/toY. Uses mouseDown, interpolated mouseMove steps, then',
  'mouseUp. Selectors support frame:N. For sliders, reorder, and canvas pan — not HTML5 file drop.',
].join(' ');

const BROWSER_CONTROL_RUNTIME = Object.freeze({
  adapter: 'runtime-gateway.local-browser-control-provider',
});

function browserContractFields(contract) {
  return {
    capabilityId: contract.capabilityId,
    availableInModes: BROWSER_CONTROL_MODE_SCOPES,
    runtime: Object.freeze({
      ...BROWSER_CONTROL_RUNTIME,
      executorCapabilityId: contract.capabilityId,
    }),
  };
}

function openPanelTool() {
  const contract = DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserOpenPanel;
  return {
    name: contract.toolName,
    description: 'Open the embedded Browser workspace for the current conversation. This is idempotent: it reuses the conversation Browser session and does not navigate or duplicate tabs.',
    ...browserContractFields(contract),
    prompt: () => OPEN_PANEL_PROMPT,
    permissionPolicy: Object.freeze({ kind: 'browser-reveal' }),
    inputSchema: {
      type: 'object',
      properties: {
        focus: {
          type: 'boolean',
          description: 'Focus the Browser workspace after opening. Defaults to true.',
        },
      },
      additionalProperties: false,
    },
  };
}

function navigateTool() {
  return {
    name: BROWSER_TOOL_NAMES.navigate,
    ...browserContractFields(DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserNavigate),
    prompt: () => NAVIGATE_PROMPT,
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
    ...browserContractFields(DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserClick),
    prompt: () => CLICK_PROMPT,
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
    ...browserContractFields(DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserType),
    prompt: () => TYPE_PROMPT,
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
    ...browserContractFields(DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserScreenshot),
    prompt: () => SCREENSHOT_PROMPT,
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
    ...browserContractFields(DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserReadDom),
    prompt: () => READ_DOM_PROMPT,
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

function hoverTool() {
  return {
    name: BROWSER_TOOL_NAMES.hover,
    ...browserContractFields(DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserHover),
    prompt: () => HOVER_PROMPT,
    permissionPolicy: { kind: 'browser-control' },
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector of the element to hover (first match). Supports optional frame:N prefix.',
        },
        x: {
          type: 'number',
          description: 'Viewport X coordinate to hover (used when selector is omitted).',
        },
        y: {
          type: 'number',
          description: 'Viewport Y coordinate to hover (used when selector is omitted).',
        },
      },
      additionalProperties: false,
    },
  };
}

function scrollTool() {
  return {
    name: BROWSER_TOOL_NAMES.scroll,
    ...browserContractFields(DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserScroll),
    prompt: () => SCROLL_PROMPT,
    permissionPolicy: { kind: 'browser-control' },
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector of the element or nearest scrollable ancestor. Supports optional frame:N prefix.',
        },
        deltaX: {
          type: 'number',
          description: 'Horizontal scroll delta in CSS pixels.',
        },
        deltaY: {
          type: 'number',
          description: 'Vertical scroll delta in CSS pixels.',
        },
        block: {
          type: 'string',
          description: 'scrollIntoView block alignment: start | center | end | nearest.',
        },
        inline: {
          type: 'string',
          description: 'scrollIntoView inline alignment: start | center | end | nearest.',
        },
      },
      additionalProperties: false,
    },
  };
}

function keyTool() {
  return {
    name: BROWSER_TOOL_NAMES.key,
    ...browserContractFields(DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserKey),
    prompt: () => KEY_PROMPT,
    permissionPolicy: { kind: 'browser-control' },
    inputSchema: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered whitelist key names, e.g. ["Tab"], ["Enter"], ["Meta+K"].',
        },
        selector: {
          type: 'string',
          description: 'Optional CSS selector to focus before sending keys. Supports frame:N prefix.',
        },
      },
      required: ['keys'],
      additionalProperties: false,
    },
  };
}

function dragTool() {
  return {
    name: BROWSER_TOOL_NAMES.drag,
    ...browserContractFields(DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserDrag),
    prompt: () => DRAG_PROMPT,
    permissionPolicy: { kind: 'browser-control' },
    inputSchema: {
      type: 'object',
      properties: {
        fromSelector: {
          type: 'string',
          description: 'CSS selector of the drag source. Supports optional frame:N prefix.',
        },
        fromX: {
          type: 'number',
          description: 'Viewport X of the drag source (used when fromSelector is omitted).',
        },
        fromY: {
          type: 'number',
          description: 'Viewport Y of the drag source (used when fromSelector is omitted).',
        },
        toSelector: {
          type: 'string',
          description: 'CSS selector of the drag target. Supports optional frame:N prefix.',
        },
        toX: {
          type: 'number',
          description: 'Viewport X of the drag target (used when toSelector is omitted).',
        },
        toY: {
          type: 'number',
          description: 'Viewport Y of the drag target (used when toSelector is omitted).',
        },
      },
      additionalProperties: false,
    },
  };
}

export const BROWSER_TOOL_DEFINITIONS = [
  openPanelTool(),
  navigateTool(),
  clickTool(),
  typeTool(),
  screenshotTool(),
  readDomTool(),
  hoverTool(),
  scrollTool(),
  keyTool(),
  dragTool(),
];
