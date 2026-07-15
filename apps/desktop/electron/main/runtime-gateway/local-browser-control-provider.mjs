import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import electron from 'electron';
import { createFailedClientToolResult, createPermissionGrant, nowIso } from './tool-result-factory.mjs';
import { getActiveBrowserEntry } from './browser-control-registry.mjs';

const { webContents: electronWebContents } = electron;

/**
 * 内嵌浏览器操控 Provider —— 见 ADR 40（local.web.control）。
 *
 * 经正规运行时链路暴露：
 *   Capability Provider(local.web.control.*) → Manifest(capabilities/local.web.control.*.json)
 *     → Tool(browser-tool-definitions.mjs) → Runtime Projection → Tool Call(browser_*)
 *     → PermissionGrant → Evidence
 *
 * 关键设计：Agent 操控的是「用户眼前那个可见的」Workbench 浏览器面板 <webview>。
 * renderer 在 webview `dom-ready` 后把 getWebContentsId() 上报给 main（见
 * browser-control-registry.mjs）；本 provider 用 webContents.fromId(id) 直接拿到
 * 同一个 WebContents 操控（loadURL / executeJavaScript / sendInputEvent / capturePage），
 * 避免逐跳 IPC 往返的脆弱链路。所有操作对用户实时可见。
 *
 * 截图与 DOM 读取属「事实/用户上下文」，体量可能很大且不应整段回灌进模型上下文：
 * Provider 把完整内容落到本地 artifact，仅向模型返回 摘要 + artifactRef，符合
 * evidencePolicy=artifact_ref。
 */

const NAVIGATE = 'local.web.control.navigate';
const CLICK = 'local.web.control.click';
const TYPE = 'local.web.control.type';
const SCREENSHOT = 'local.web.control.screenshot';
const READ_DOM = 'local.web.control.readDom';

const CONTROL_CAPABILITIES = Object.freeze([NAVIGATE, CLICK, TYPE, SCREENSHOT, READ_DOM]);

const SUMMARY_MAX_CHARS = 2_000;
const MAX_ARTIFACT_CHARS = 2_000_000;

function dateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function summarize(content, maxChars = SUMMARY_MAX_CHARS) {
  const text = String(content ?? '').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

/**
 * 浏览器操控 artifact 落盘：截图 PNG / DOM 文本，与 web-artifacts 同构。
 */
function createBrowserArtifactStore({ userDataPath }) {
  const rootPath = path.join(userDataPath, 'browser-artifacts');

  async function writeTextArtifact({ actionId, toolCallId, format, content, metadata = {} }) {
    const dir = path.join(rootPath, dateKey(), actionId);
    await mkdir(dir, { recursive: true });
    const raw = String(content ?? '');
    const truncated = raw.length > MAX_ARTIFACT_CHARS;
    const capped = truncated ? `${raw.slice(0, MAX_ARTIFACT_CHARS)}\n...[artifact truncated]` : raw;
    const ext = format === 'html' ? 'html' : 'txt';
    await writeFile(path.join(dir, `content.${ext}`), capped, 'utf8');
    await writeFile(
      path.join(dir, 'metadata.json'),
      `${JSON.stringify({ actionId, toolCallId, contentTruncated: truncated, ...metadata }, null, 2)}\n`,
      'utf8',
    );
    return {
      artifactRef: `local-browser-artifact://${actionId}`,
      artifactRefs: [
        `local-browser-artifact://${actionId}/content`,
        `local-browser-artifact://${actionId}/metadata`,
      ],
      localPath: dir,
      truncated,
    };
  }

  async function writeImageArtifact({ actionId, toolCallId, pngBuffer, metadata = {} }) {
    const dir = path.join(rootPath, dateKey(), actionId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'screenshot.png'), pngBuffer);
    await writeFile(
      path.join(dir, 'metadata.json'),
      `${JSON.stringify({ actionId, toolCallId, bytes: pngBuffer.length, ...metadata }, null, 2)}\n`,
      'utf8',
    );
    return {
      artifactRef: `local-browser-artifact://${actionId}`,
      artifactRefs: [
        `local-browser-artifact://${actionId}/screenshot`,
        `local-browser-artifact://${actionId}/metadata`,
      ],
      localPath: dir,
      bytes: pngBuffer.length,
    };
  }

  return { rootPath, writeTextArtifact, writeImageArtifact };
}

function permissionReason(capabilityId, { host, locale }) {
  const zh = locale === 'zh-CN';
  switch (capabilityId) {
    case NAVIGATE:
      return zh ? `请求在内嵌浏览器中打开网页：${host}` : `Requesting to navigate the in-app browser to: ${host}`;
    case CLICK:
      return zh ? `请求在内嵌浏览器（${host}）中点击元素` : `Requesting to click in the in-app browser (${host})`;
    case TYPE:
      return zh ? `请求在内嵌浏览器（${host}）中输入文本` : `Requesting to type in the in-app browser (${host})`;
    case SCREENSHOT:
      return zh ? `请求对内嵌浏览器（${host}）截图` : `Requesting to screenshot the in-app browser (${host})`;
    case READ_DOM:
      return zh ? `请求读取内嵌浏览器（${host}）的页面内容` : `Requesting to read the in-app browser DOM (${host})`;
    default:
      return zh ? '请求操控内嵌浏览器' : 'Requesting to control the in-app browser';
  }
}

export function createLocalBrowserControlProvider({
  userDataPath,
  artifactStore = null,
  // 便于测试注入：默认用 electron 的 webContents.fromId(注册的 id)。
  resolveWebContents = (id) => electronWebContents.fromId(id),
} = {}) {
  const store = artifactStore ?? createBrowserArtifactStore({ userDataPath });

  function resolveTarget(context = {}) {
    const conversationId = context?.toolContext?.conversationId ?? null;
    const entry = getActiveBrowserEntry(conversationId);
    const id = entry?.webContentsId ?? null;
    if (!id) {
      return { ok: false, reason: 'no_active_browser' };
    }
    const wc = resolveWebContents(id);
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
      return { ok: false, reason: 'browser_unavailable' };
    }
    return { ok: true, id, wc, entry, conversationId };
  }

  function failed({ call, locale, reason, status = 'failed', dataLevel = 'D2_sensitive' }) {
    return {
      call,
      result: createFailedClientToolResult({ call, locale, reason, dataLevel, status }),
    };
  }

  async function executeCapability(request, context = {}) {
    const call = request?.call;
    const locale = context.locale ?? 'en-US';
    if (!call || !CONTROL_CAPABILITIES.includes(call.capabilityId)) return null;

    const zh = locale === 'zh-CN';
    const args = call.arguments ?? call.argumentsPreview ?? {};
    const capabilityId = call.capabilityId;

    // navigate 必填 url 的早校验。
    if (capabilityId === NAVIGATE) {
      const url = String(args?.url ?? '').trim();
      if (!url) {
        return failed({ call, locale, reason: zh ? '缺少必填参数 url。' : 'Missing required argument: url.' });
      }
      if (!/^https?:\/\//i.test(url)) {
        return failed({
          call,
          locale,
          reason: zh ? '仅支持 http(s) 网址。' : 'Only http(s) URLs are supported.',
        });
      }
    }
    if (capabilityId === TYPE) {
      const text = args?.text;
      if (typeof text !== 'string' || text.length === 0) {
        return failed({ call, locale, reason: zh ? '缺少必填参数 text。' : 'Missing required argument: text.' });
      }
    }
    if (capabilityId === CLICK) {
      const hasSelector = typeof args?.selector === 'string' && args.selector.trim().length > 0;
      const hasPoint = Number.isFinite(Number(args?.x)) && Number.isFinite(Number(args?.y));
      if (!hasSelector && !hasPoint) {
        return failed({
          call,
          locale,
          reason: zh ? '需要提供 selector 或 x/y 坐标之一。' : 'Provide either a selector or x/y coordinates.',
        });
      }
    }

    const activeEntry = getActiveBrowserEntry(context?.toolContext?.conversationId ?? null);
    const host = capabilityId === NAVIGATE ? hostOf(String(args?.url ?? '')) : hostOf(activeEntry?.url ?? '');
    const scope = { kind: 'browser-control', capabilityId, host };

    // 授权：导航类复用联网授权语义；点击/输入/截图/读DOM 在已授权的可见浏览器上执行。
    let permissionGrant = createPermissionGrant({ toolCallId: call.toolCallId, granted: true, scope });
    if (typeof context.requestPermission === 'function') {
      const decision = await context.requestPermission({
        toolCallId: call.toolCallId,
        capabilityId,
        toolName: call.toolName,
        arguments: args,
        scope,
        riskLevel: call.riskLevel ?? (capabilityId === SCREENSHOT || capabilityId === READ_DOM ? 'L2_external_read' : 'L3_external_write'),
        dataLevel: call.dataLevel ?? 'D2_sensitive',
        reason: permissionReason(capabilityId, { host, locale }),
      });
      permissionGrant = createPermissionGrant({
        toolCallId: call.toolCallId,
        granted: decision?.granted !== false,
        scope,
        duration: decision?.duration,
      });
      if (decision?.granted === false) {
        return {
          call,
          permissionGrant,
          result: createFailedClientToolResult({
            call,
            locale,
            reason: zh ? '操控内嵌浏览器未获授权，已拒绝。' : 'Browser control was not authorized; request denied.',
            dataLevel: 'D2_sensitive',
            status: 'denied',
          }),
        };
      }
    }

    // 解析目标 WebContents（用户眼前那个可见 webview）。
    const target = resolveTarget(context);
    if (!target.ok) {
      const reason =
        target.reason === 'no_active_browser'
          ? zh
            ? '未检测到可见的内嵌浏览器，请先打开「浏览器」面板并加载一个网页。'
            : 'No visible in-app browser detected. Open the Browser panel and load a page first.'
          : zh
            ? '内嵌浏览器已不可用（可能已关闭）。'
            : 'The in-app browser is no longer available (it may have been closed).';
      return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason, dataLevel: 'D2_sensitive', status: 'failed' }) };
    }

    const { wc } = target;
    const targetIdentity = {
      conversationId: target.entry?.conversationId ?? target.conversationId,
      browserTabId: target.entry?.browserTabId ?? null,
    };
    const startedAt = nowIso();

    try {
      let outputPreview;
      let output;
      let evidenceSummary;
      let evidenceArtifactRefs = [];
      let returnedToCloud = true;

      if (capabilityId === NAVIGATE) {
        const url = String(args.url).trim();
        await wc.loadURL(url);
        const finalUrl = typeof wc.getURL === 'function' ? wc.getURL() : url;
        const title = typeof wc.getTitle === 'function' ? wc.getTitle() : '';
        outputPreview = { status: 'success', action: 'navigate', requestedUrl: url, finalUrl, title, ...targetIdentity };
        output = { action: 'navigate', finalUrl, title, ...targetIdentity };
        evidenceSummary = zh
          ? `已在内嵌浏览器打开「${title || finalUrl}」。`
          : `Navigated the in-app browser to "${title || finalUrl}".`;
      } else if (capabilityId === CLICK) {
        const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
        let point = { x: Number(args.x), y: Number(args.y) };
        let locatedBy = 'point';
        if (selector) {
          const located = await wc.executeJavaScript(
            `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block:'center',inline:'center'}); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()`,
            true,
          );
          if (!located) {
            return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: zh ? `未找到匹配 selector 的元素：${selector}` : `No element matched selector: ${selector}`, dataLevel: 'D2_sensitive', status: 'failed' }) };
          }
          point = located;
          locatedBy = 'selector';
        }
        wc.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
        outputPreview = { status: 'success', action: 'click', locatedBy, selector: selector || undefined, x: point.x, y: point.y, ...targetIdentity };
        output = { action: 'click', locatedBy, x: point.x, y: point.y, ...targetIdentity };
        evidenceSummary = zh
          ? `已在内嵌浏览器点击${selector ? `元素「${selector}」` : `坐标 (${point.x}, ${point.y})`}。`
          : `Clicked ${selector ? `element "${selector}"` : `point (${point.x}, ${point.y})`} in the in-app browser.`;
      } else if (capabilityId === TYPE) {
        const text = String(args.text);
        const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
        const clear = args.clear === true;
        const submit = args.submit === true;
        if (selector) {
          const focused = await wc.executeJavaScript(
            `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); if (${clear ? 'true' : 'false'} && 'value' in el) { el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); } return true; })()`,
            true,
          );
          if (!focused) {
            return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: zh ? `未找到匹配 selector 的输入元素：${selector}` : `No input element matched selector: ${selector}`, dataLevel: 'D2_sensitive', status: 'failed' }) };
          }
        }
        if (typeof wc.insertText === 'function') {
          await wc.insertText(text);
        } else {
          for (const ch of text) {
            wc.sendInputEvent({ type: 'char', keyCode: ch });
          }
        }
        if (submit) {
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
          wc.sendInputEvent({ type: 'char', keyCode: '\r' });
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
        }
        outputPreview = { status: 'success', action: 'type', selector: selector || undefined, chars: text.length, cleared: clear, submitted: submit, ...targetIdentity };
        output = { action: 'type', chars: text.length, submitted: submit, ...targetIdentity };
        evidenceSummary = zh
          ? `已在内嵌浏览器输入 ${text.length} 个字符${submit ? '并回车提交' : ''}。`
          : `Typed ${text.length} characters into the in-app browser${submit ? ' and submitted' : ''}.`;
        // 输入内容可能含敏感信息，不回灌原文。
        returnedToCloud = false;
      } else if (capabilityId === SCREENSHOT) {
        const image = await wc.capturePage();
        const pngBuffer = image.toPNG();
        const size = typeof image.getSize === 'function' ? image.getSize() : { width: 0, height: 0 };
        const actionId = randomUUID();
        const finalUrl = typeof wc.getURL === 'function' ? wc.getURL() : (activeEntry?.url ?? '');
        const title = typeof wc.getTitle === 'function' ? wc.getTitle() : (activeEntry?.title ?? '');
        const artifact = await store.writeImageArtifact({
          actionId,
          toolCallId: call.toolCallId,
          pngBuffer,
          metadata: { capability: SCREENSHOT, finalUrl, title, width: size.width, height: size.height, ...targetIdentity, startedAt, completedAt: nowIso() },
        });
        evidenceArtifactRefs = artifact.artifactRefs;
        outputPreview = { status: 'success', action: 'screenshot', width: size.width, height: size.height, bytes: artifact.bytes, artifactRef: artifact.artifactRef, artifactRefs: artifact.artifactRefs, ...targetIdentity };
        output = { action: 'screenshot', width: size.width, height: size.height, artifactRef: artifact.artifactRef, ...targetIdentity };
        evidenceSummary = zh
          ? `已对内嵌浏览器截图（${size.width}×${size.height}），图片已落盘（${artifact.artifactRef}）。`
          : `Captured the in-app browser (${size.width}×${size.height}); image stored at ${artifact.artifactRef}.`;
      } else if (capabilityId === READ_DOM) {
        const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
        const format = args.format === 'html' ? 'html' : 'text';
        const prop = format === 'html' ? 'outerHTML' : 'innerText';
        const expr = selector
          ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.${prop} : null; })()`
          : `(() => { const el = document.body; return el ? el.${prop} : ''; })()`;
        const dom = await wc.executeJavaScript(expr, true);
        if (selector && dom == null) {
          return { call, permissionGrant, result: createFailedClientToolResult({ call, locale, reason: zh ? `未找到匹配 selector 的元素：${selector}` : `No element matched selector: ${selector}`, dataLevel: 'D2_sensitive', status: 'failed' }) };
        }
        const actionId = randomUUID();
        const finalUrl = typeof wc.getURL === 'function' ? wc.getURL() : (activeEntry?.url ?? '');
        const title = typeof wc.getTitle === 'function' ? wc.getTitle() : (activeEntry?.title ?? '');
        const fullText = String(dom ?? '');
        const artifact = await store.writeTextArtifact({
          actionId,
          toolCallId: call.toolCallId,
          format,
          content: fullText,
          metadata: { capability: READ_DOM, selector: selector || null, format, finalUrl, title, chars: fullText.length, ...targetIdentity, startedAt, completedAt: nowIso() },
        });
        evidenceArtifactRefs = artifact.artifactRefs;
        const summary = summarize(fullText);
        const maxChars = Number.isFinite(Number(args.maxChars)) ? Number(args.maxChars) : SUMMARY_MAX_CHARS;
        outputPreview = { status: 'success', action: 'read_dom', format, chars: fullText.length, summary: summarize(fullText, maxChars), artifactRef: artifact.artifactRef, artifactRefs: artifact.artifactRefs, truncated: artifact.truncated, ...targetIdentity };
        output = { action: 'read_dom', format, chars: fullText.length, summary, artifactRef: artifact.artifactRef, ...targetIdentity };
        evidenceSummary = zh
          ? `已读取内嵌浏览器页面（${format}，${fullText.length} 字符），内容已落盘（${artifact.artifactRef}）。`
          : `Read the in-app browser DOM (${format}, ${fullText.length} chars); content stored at ${artifact.artifactRef}.`;
      }

      const completedAt = nowIso();
      return {
        call,
        permissionGrant,
        result: {
          toolCallId: call.toolCallId,
          status: 'success',
          outputPreview,
          output,
          evidence: {
            toolCallId: call.toolCallId,
            summary: evidenceSummary,
            locale,
            returnedToCloud,
            dataLevel: 'D2_sensitive',
            redactions: [],
            artifactRefs: evidenceArtifactRefs,
            origin: {
              providerId: 'local.browser.control',
              capabilityId,
              host,
              ...targetIdentity,
            },
          },
          completedAt,
        },
      };
    } catch (err) {
      return {
        call,
        permissionGrant,
        result: createFailedClientToolResult({
          call,
          locale,
          reason: (zh ? '操控内嵌浏览器失败：' : 'Browser control failed: ') + (err?.message ?? String(err)),
          dataLevel: 'D2_sensitive',
          status: 'failed',
        }),
      };
    }
  }

  return {
    providerId: 'local.browser.control',
    capabilityIds: CONTROL_CAPABILITIES,
    executeCapability,
    artifactStore: store,
  };
}
