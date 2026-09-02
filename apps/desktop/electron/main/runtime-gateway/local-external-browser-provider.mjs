import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS } from '@peer-agent/runtime-core';
import { createFailedClientToolResult, createPermissionGrant, nowIso } from './tool-result-factory.mjs';
import {
  createExternalBrowserAdapter,
  ExternalBrowserActionError,
} from './external-browser-adapter.mjs';

/**
 * L2 受控外部浏览器 Capability Provider（ADR 71 第一刀）。
 * Playwright 只经 ExternalBrowserAdapter 执行，不接管 L1 webview。
 */

const OPEN = DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalOpen.capabilityId;
const CLOSE = DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalClose.capabilityId;
const NAVIGATE = DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalNavigate.capabilityId;
const CLICK = DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalClick.capabilityId;
const TYPE = DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalType.capabilityId;
const HOVER = DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalHover.capabilityId;
const SCROLL = DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalScroll.capabilityId;
const SCREENSHOT = DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalScreenshot.capabilityId;
const READ_DOM = DESKTOP_ONLY_LOCAL_TOOL_CONTRACTS.browserExternalReadDom.capabilityId;

const EXTERNAL_CAPABILITIES = Object.freeze([
  OPEN, CLOSE, NAVIGATE, CLICK, TYPE, HOVER, SCROLL, SCREENSHOT, READ_DOM,
]);

const CAPABILITY_TO_ACTION = Object.freeze({
  [OPEN]: 'open',
  [CLOSE]: 'close',
  [NAVIGATE]: 'navigate',
  [CLICK]: 'click',
  [TYPE]: 'type',
  [HOVER]: 'hover',
  [SCROLL]: 'scroll',
  [SCREENSHOT]: 'screenshot',
  [READ_DOM]: 'readDom',
});

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
    return new URL(url).host || url;
  } catch {
    return url || 'unknown';
  }
}

function permissionReason(capabilityId, { host, locale }) {
  const zh = locale === 'zh-CN';
  switch (capabilityId) {
    case OPEN:
      return zh ? '请求启动临时 Peer 托管 Chromium 会话' : 'Requesting to open a temporary Peer-managed Chromium session';
    case CLOSE:
      return zh ? '请求关闭临时 Peer 托管 Chromium 会话' : 'Requesting to close the temporary Peer-managed Chromium session';
    case NAVIGATE:
      return zh ? `请求在外部浏览器打开网页：${host}` : `Requesting to navigate the external browser to: ${host}`;
    case CLICK:
      return zh ? `请求在外部浏览器（${host}）中点击` : `Requesting to click in the external browser (${host})`;
    case TYPE:
      return zh ? `请求在外部浏览器（${host}）中输入` : `Requesting to type in the external browser (${host})`;
    case HOVER:
      return zh ? `请求在外部浏览器（${host}）中悬停` : `Requesting to hover in the external browser (${host})`;
    case SCROLL:
      return zh ? `请求在外部浏览器（${host}）中滚动` : `Requesting to scroll in the external browser (${host})`;
    case SCREENSHOT:
      return zh ? `请求截取外部浏览器（${host}）` : `Requesting to screenshot the external browser (${host})`;
    case READ_DOM:
      return zh ? `请求读取外部浏览器（${host}）DOM` : `Requesting to read the external browser DOM (${host})`;
    default:
      return zh ? '请求操控外部浏览器' : 'Requesting to control the external browser';
  }
}

function createExternalBrowserArtifactStore({ userDataPath }) {
  const rootPath = path.join(userDataPath, 'external-browser-artifacts');

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
      artifactRef: `local-external-browser-artifact://${actionId}`,
      artifactRefs: [
        `local-external-browser-artifact://${actionId}/content`,
        `local-external-browser-artifact://${actionId}/metadata`,
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
      artifactRef: `local-external-browser-artifact://${actionId}`,
      artifactRefs: [
        `local-external-browser-artifact://${actionId}/screenshot`,
        `local-external-browser-artifact://${actionId}/metadata`,
      ],
      screenshotPath: path.join(dir, 'screenshot.png'),
      bytes: pngBuffer.length,
      localPath: dir,
    };
  }

  return { writeTextArtifact, writeImageArtifact };
}

function failed({ call, locale, reason, status = 'failed', dataLevel = 'D2_sensitive' }) {
  return {
    call,
    result: createFailedClientToolResult({ call, locale, reason, dataLevel, status }),
  };
}

function actionErrorReason(err, locale) {
  const zh = locale === 'zh-CN';
  const code = err?.code ?? 'adapter_failed';
  const messages = {
    session_not_open: zh
      ? '当前会话没有打开的临时外部浏览器，请先调用 browser_external_open。'
      : 'No temporary Peer-managed Chromium session is open. Call browser_external_open first.',
    download_not_supported: zh
      ? 'L2 第一刀暂不支持 download。请改用白名单动作，或关闭会话后重试。'
      : 'L2 first slice refuses download. Use a whitelist action or close the session.',
    dialog_not_supported: zh
      ? 'L2 第一刀暂不支持 dialog。请改用白名单动作，或关闭会话后重试。'
      : 'L2 first slice refuses dialog. Use a whitelist action or close the session.',
    action_not_whitelisted: zh
      ? `动作不在 L2 白名单中：${err?.details?.action ?? ''}。`
      : `Action is not in the L2 whitelist: ${err?.details?.action ?? ''}.`,
    playwright_unavailable: zh
      ? '当前 Desktop 运行时没有可用的 Playwright。'
      : 'Playwright is not available in this Desktop runtime.',
    invalid_url: zh ? '仅支持 http(s) 网址。' : 'Only http(s) URLs are supported.',
    missing_url: zh ? '缺少必填参数 url。' : 'Missing required argument: url.',
    missing_selector: zh ? '缺少必填参数 selector。' : 'Missing required argument: selector.',
    missing_text: zh ? '缺少必填参数 text。' : 'Missing required argument: text.',
    missing_conversation: zh ? '缺少当前会话。' : 'No current conversation is available.',
  };
  if (messages[code]) return messages[code];
  return err?.message || (zh ? '外部浏览器执行失败。' : 'External browser action failed.');
}

export function createLocalExternalBrowserProvider({
  userDataPath,
  artifactStore = null,
  adapter = null,
  playwrightFactory = null,
  headless = false,
} = {}) {
  const store = artifactStore ?? createExternalBrowserArtifactStore({ userDataPath });
  const browserAdapter = adapter ?? createExternalBrowserAdapter({
    ...(playwrightFactory ? { playwrightFactory } : {}),
    userDataPath,
    headless,
  });

  async function executeCapability(request, context = {}) {
    const call = request?.call;
    const locale = context.locale ?? 'en-US';
    if (!call || !EXTERNAL_CAPABILITIES.includes(call.capabilityId)) return null;

    const zh = locale === 'zh-CN';
    const args = call.arguments ?? call.argumentsPreview ?? {};
    const capabilityId = call.capabilityId;
    const conversationId = context?.toolContext?.conversationId ?? null;

    if (!conversationId) {
      return failed({
        call,
        locale,
        reason: zh ? '缺少当前会话，无法操控外部浏览器。' : 'No current conversation is available for the external browser.',
        dataLevel: 'D1_internal',
      });
    }

    if (capabilityId === NAVIGATE || (capabilityId === OPEN && typeof args?.url === 'string' && args.url.trim())) {
      const url = String(args?.url ?? '').trim();
      if (capabilityId === NAVIGATE && !url) {
        return failed({ call, locale, reason: zh ? '缺少必填参数 url。' : 'Missing required argument: url.' });
      }
      if (url && !/^https?:\/\//i.test(url)) {
        return failed({ call, locale, reason: zh ? '仅支持 http(s) 网址。' : 'Only http(s) URLs are supported.' });
      }
    }
    if (capabilityId === CLICK || capabilityId === HOVER) {
      if (typeof args?.selector !== 'string' || args.selector.trim().length === 0) {
        return failed({ call, locale, reason: zh ? '缺少必填参数 selector。' : 'Missing required argument: selector.' });
      }
    }
    if (capabilityId === TYPE) {
      if (typeof args?.text !== 'string' || args.text.length === 0) {
        return failed({ call, locale, reason: zh ? '缺少必填参数 text。' : 'Missing required argument: text.' });
      }
    }

    const existing = browserAdapter.getSession?.(conversationId);
    const host = capabilityId === NAVIGATE || capabilityId === OPEN
      ? hostOf(String(args?.url ?? existing?.url ?? ''))
      : hostOf(existing?.url ?? '');
    const scope = {
      capabilityId,
      conversationId,
      host,
      profileKind: 'temporary',
    };
    const decision = await (context.requestPermission?.({
      call,
      locale,
      dataLevel: call.dataLevel ?? 'D2_sensitive',
      reason: permissionReason(capabilityId, { host, locale }),
    }) ?? { granted: true });
    const permissionGrant = createPermissionGrant({
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
          reason: zh ? '用户拒绝了外部浏览器操作。' : 'The user denied the external browser action.',
          dataLevel: 'D2_sensitive',
          status: 'denied',
        }),
      };
    }

    const action = CAPABILITY_TO_ACTION[capabilityId];
    const startedAt = nowIso();
    try {
      const result = await browserAdapter.execute(action, {
        conversationId,
        url: args.url,
        selector: args.selector,
        text: args.text,
        clear: args.clear,
        submit: args.submit,
        deltaX: args.deltaX,
        deltaY: args.deltaY,
        block: args.block,
        format: args.format,
      });

      const identity = {
        conversationId,
        sessionId: result.sessionId ?? existing?.sessionId ?? null,
        profileKind: 'temporary',
        isolatedFromL1: true,
        url: result.url ?? existing?.url ?? '',
        title: result.title ?? existing?.title ?? '',
      };

      let outputPreview;
      let output;
      let evidenceSummary;
      let evidenceArtifactRefs = [];
      let userArtifacts = [];
      let visualObservations = [];

      if (capabilityId === OPEN) {
        outputPreview = { status: 'success', action: 'open', ...identity };
        output = { action: 'open', ...identity };
        evidenceSummary = zh
          ? `已启动临时 Peer 托管 Chromium 会话（${identity.sessionId}），与内嵌浏览器隔离。`
          : `Opened a temporary Peer-managed Chromium session (${identity.sessionId}), isolated from the in-app browser.`;
      } else if (capabilityId === CLOSE) {
        outputPreview = { status: 'success', action: 'close', closed: result.closed, conversationId, sessionId: result.sessionId ?? null, profileKind: 'temporary' };
        output = { action: 'close', closed: result.closed, conversationId, sessionId: result.sessionId ?? null };
        evidenceSummary = zh
          ? '已关闭并销毁临时 Peer 托管 Chromium 会话。'
          : 'Closed and destroyed the temporary Peer-managed Chromium session.';
      } else if (capabilityId === NAVIGATE) {
        outputPreview = { status: 'success', action: 'navigate', ...identity };
        output = { action: 'navigate', ...identity };
        evidenceSummary = zh
          ? `外部浏览器已导航到 ${identity.url}。`
          : `External browser navigated to ${identity.url}.`;
      } else if (capabilityId === CLICK) {
        outputPreview = { status: 'success', action: 'click', selector: args.selector, ...identity };
        output = { action: 'click', selector: args.selector, ...identity };
        evidenceSummary = zh
          ? `外部浏览器已点击 ${args.selector}。`
          : `External browser clicked ${args.selector}.`;
      } else if (capabilityId === TYPE) {
        outputPreview = { status: 'success', action: 'type', selector: args.selector || null, ...identity };
        output = { action: 'type', selector: args.selector || null, ...identity };
        evidenceSummary = zh ? '外部浏览器已输入文本。' : 'External browser typed text.';
      } else if (capabilityId === HOVER) {
        outputPreview = { status: 'success', action: 'hover', selector: args.selector, ...identity };
        output = { action: 'hover', selector: args.selector, ...identity };
        evidenceSummary = zh
          ? `外部浏览器已悬停 ${args.selector}。`
          : `External browser hovered ${args.selector}.`;
      } else if (capabilityId === SCROLL) {
        outputPreview = { status: 'success', action: 'scroll', selector: args.selector || null, deltaX: args.deltaX ?? 0, deltaY: args.deltaY ?? 0, ...identity };
        output = { action: 'scroll', selector: args.selector || null, ...identity };
        evidenceSummary = zh ? '外部浏览器已滚动。' : 'External browser scrolled.';
      } else if (capabilityId === SCREENSHOT) {
        const actionId = randomUUID();
        const pngBuffer = result.pngBuffer ?? Buffer.from([]);
        const artifact = await store.writeImageArtifact({
          actionId,
          toolCallId: call.toolCallId,
          pngBuffer,
          metadata: { capability: SCREENSHOT, ...identity, startedAt, completedAt: nowIso() },
        });
        evidenceArtifactRefs = artifact.artifactRefs;
        userArtifacts = [{
          kind: 'image',
          ref: `${artifact.artifactRef}/screenshot`,
          path: artifact.screenshotPath,
          label: '外部浏览器截图',
        }];
        visualObservations = [{
          kind: 'browser_screenshot',
          mediaType: 'image/png',
          artifactRef: artifact.artifactRef,
        }];
        outputPreview = { status: 'success', action: 'screenshot', bytes: artifact.bytes, artifactRef: artifact.artifactRef, artifactRefs: artifact.artifactRefs, ...identity };
        output = {
          action: 'screenshot',
          artifactRef: artifact.artifactRef,
          visualObservation: {
            kind: 'browser_screenshot',
            mediaType: 'image/png',
            artifactRef: artifact.artifactRef,
          },
          ...identity,
        };
        evidenceSummary = zh
          ? `已对外部浏览器截图，图片已落盘（${artifact.artifactRef}）。`
          : `Captured the external browser; image stored at ${artifact.artifactRef}.`;
      } else if (capabilityId === READ_DOM) {
        const format = args.format === 'html' ? 'html' : 'text';
        const fullText = String(result.content ?? '');
        const actionId = randomUUID();
        const artifact = await store.writeTextArtifact({
          actionId,
          toolCallId: call.toolCallId,
          format,
          content: fullText,
          metadata: { capability: READ_DOM, selector: args.selector || null, format, chars: fullText.length, ...identity, startedAt, completedAt: nowIso() },
        });
        evidenceArtifactRefs = artifact.artifactRefs;
        const summary = summarize(fullText);
        outputPreview = { status: 'success', action: 'read_dom', format, chars: fullText.length, summary, artifactRef: artifact.artifactRef, artifactRefs: artifact.artifactRefs, truncated: artifact.truncated, ...identity };
        output = { action: 'read_dom', format, chars: fullText.length, summary, artifactRef: artifact.artifactRef, ...identity };
        evidenceSummary = zh
          ? `已读取外部浏览器页面（${format}，${fullText.length} 字符），内容已落盘（${artifact.artifactRef}）。`
          : `Read the external browser DOM (${format}, ${fullText.length} chars); content stored at ${artifact.artifactRef}.`;
      }

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
            returnedToCloud: false,
            dataLevel: 'D2_sensitive',
            redactions: [],
            artifactRefs: evidenceArtifactRefs,
            ...(userArtifacts.length > 0 ? { userArtifacts } : {}),
            ...(visualObservations.length > 0 ? { visualObservations } : {}),
          },
          completedAt: nowIso(),
        },
      };
    } catch (err) {
      const reason = err instanceof ExternalBrowserActionError || err?.code
        ? actionErrorReason(err, locale)
        : (err?.message ?? String(err));
      return {
        call,
        permissionGrant,
        result: createFailedClientToolResult({
          call,
          locale,
          reason,
          dataLevel: 'D2_sensitive',
          status: 'failed',
        }),
      };
    }
  }

  return {
    providerId: 'local.browser.external',
    capabilityIds: EXTERNAL_CAPABILITIES,
    executeCapability,
    artifactStore: store,
    adapter: browserAdapter,
  };
}
