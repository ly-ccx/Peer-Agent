import { DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS } from '@peer-agent/runtime-core';

/**
 * L2 受控外部浏览器工具（ADR 71）。
 * Playwright 只在 Adapter 内执行，模型只看到这些 browser_external_* 工具。
 */
export const EXTERNAL_BROWSER_TOOL_NAMES = Object.freeze({
  open: DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalOpen.toolName,
  close: DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalClose.toolName,
  navigate: DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalNavigate.toolName,
  click: DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalClick.toolName,
  type: DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalType.toolName,
  hover: DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalHover.toolName,
  scroll: DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalScroll.toolName,
  screenshot: DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalScreenshot.toolName,
  readDom: DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalReadDom.toolName,
});

export const EXTERNAL_BROWSER_CAPABILITY_TO_TOOL = Object.freeze({
  [DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalOpen.capabilityId]: EXTERNAL_BROWSER_TOOL_NAMES.open,
  [DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalClose.capabilityId]: EXTERNAL_BROWSER_TOOL_NAMES.close,
  [DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalNavigate.capabilityId]: EXTERNAL_BROWSER_TOOL_NAMES.navigate,
  [DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalClick.capabilityId]: EXTERNAL_BROWSER_TOOL_NAMES.click,
  [DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalType.capabilityId]: EXTERNAL_BROWSER_TOOL_NAMES.type,
  [DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalHover.capabilityId]: EXTERNAL_BROWSER_TOOL_NAMES.hover,
  [DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalScroll.capabilityId]: EXTERNAL_BROWSER_TOOL_NAMES.scroll,
  [DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalScreenshot.capabilityId]: EXTERNAL_BROWSER_TOOL_NAMES.screenshot,
  [DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalReadDom.capabilityId]: EXTERNAL_BROWSER_TOOL_NAMES.readDom,
});

const MODE_SCOPES = Object.freeze(['chat', 'goal']);
const RUNTIME = Object.freeze({
  adapter: 'runtime-gateway.local-external-browser-provider',
});

function contractFields(contract) {
  return {
    capabilityId: contract.capabilityId,
    availableInModes: MODE_SCOPES,
    runtime: Object.freeze({
      ...RUNTIME,
      executorCapabilityId: contract.capabilityId,
    }),
  };
}

function tool(name, contract, prompt, inputSchema, extra = {}) {
  return {
    name,
    ...contractFields(contract),
    prompt: () => prompt,
    permissionPolicy: { kind: 'browser-control' },
    inputSchema,
    ...extra,
  };
}

const SELECTOR = {
  type: 'string',
  description: 'CSS selector. Optional frame:N prefix selects an iframe document.',
};

export const EXTERNAL_BROWSER_TOOL_DEFINITIONS = [
  tool(
    EXTERNAL_BROWSER_TOOL_NAMES.open,
    DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalOpen,
    'Open a temporary Peer-managed Chromium session for this conversation. Isolated from the in-app Browser workspace and from the user daily profile. This is not the default webpage entry; use in-app browser_* tools unless the task needs a separate profile or multi-page environment. Do not use this to control the visible Workbench webview. Optional url navigates after launch. Download and dialog are rejected until a later slice.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'Optional absolute http(s) URL to open after launch.' },
      },
    },
  ),
  tool(
    EXTERNAL_BROWSER_TOOL_NAMES.close,
    DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalClose,
    'Stop and destroy the current conversation temporary Peer-managed Chromium session.',
    { type: 'object', additionalProperties: false, properties: {} },
  ),
  tool(
    EXTERNAL_BROWSER_TOOL_NAMES.navigate,
    DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalNavigate,
    'Navigate the temporary Peer-managed Chromium session to an absolute http(s) URL. Requires an open external session.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to load.' },
      },
    },
  ),
  tool(
    EXTERNAL_BROWSER_TOOL_NAMES.click,
    DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalClick,
    'Click an element in the temporary Peer-managed Chromium session by CSS selector. Uses Playwright locator and auto-wait. Requires an open external session.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['selector'],
      properties: { selector: SELECTOR },
    },
  ),
  tool(
    EXTERNAL_BROWSER_TOOL_NAMES.type,
    DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalType,
    'Type text in the temporary Peer-managed Chromium session. Optionally focus a CSS selector first. Requires an open external session.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'The text to type.' },
        selector: SELECTOR,
        clear: { type: 'boolean', description: 'Clear the field before typing. Defaults to false.' },
        submit: { type: 'boolean', description: 'Press Enter after typing. Defaults to false.' },
      },
    },
  ),
  tool(
    EXTERNAL_BROWSER_TOOL_NAMES.hover,
    DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalHover,
    'Hover an element in the temporary Peer-managed Chromium session by CSS selector. Requires an open external session.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['selector'],
      properties: { selector: SELECTOR },
    },
  ),
  tool(
    EXTERNAL_BROWSER_TOOL_NAMES.scroll,
    DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalScroll,
    'Scroll the temporary Peer-managed Chromium session. Prefer a CSS selector; otherwise scroll the viewport. Requires an open external session.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        selector: SELECTOR,
        deltaX: { type: 'number', description: 'Horizontal scroll delta in CSS pixels.' },
        deltaY: { type: 'number', description: 'Vertical scroll delta in CSS pixels.' },
        block: { type: 'string', description: 'scrollIntoView block: start | center | end | nearest.' },
      },
    },
  ),
  tool(
    EXTERNAL_BROWSER_TOOL_NAMES.screenshot,
    DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalScreenshot,
    'Capture a screenshot of the temporary Peer-managed Chromium page. The PNG is stored as a local artifact. Requires an open external session.',
    { type: 'object', additionalProperties: false, properties: {} },
  ),
  tool(
    EXTERNAL_BROWSER_TOOL_NAMES.readDom,
    DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalReadDom,
    'Read text or HTML from the temporary Peer-managed Chromium DOM. Full content is stored as a local artifact. Requires an open external session.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        selector: SELECTOR,
        format: { type: 'string', description: 'text or html. Defaults to text.' },
      },
    },
  ),
];
