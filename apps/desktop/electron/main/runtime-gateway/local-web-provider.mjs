import { randomUUID } from 'node:crypto';
import { createFailedClientToolResult, createPermissionGrant, nowIso } from './tool-result-factory.mjs';
import { createWebArtifactStore } from './web-artifacts.mjs';
import { fetchWebPage } from './web-fetch-engine.mjs';

/**
 * 本地 Web 能力 Provider —— 见 ADR 38（local.web.fetch）。
 *
 * 经正规运行时链路暴露：
 *   Capability Provider(local.web.fetch) → Manifest(capabilities/local.web.fetch.json)
 *     → Runtime Projection → Tool Call(web_fetch) → PermissionGrant → Evidence
 *
 * 设计要点（与 AGENTS.md 非协商运行时链一致）：
 * - 联网是 L3_external_write：先经 context.requestPermission 申请联网授权，
 *   授权真值留在 main 进程，不落 renderer state。未授权则返回 denied 结果。
 * - 正文落本地 artifact（web-artifacts），仅向模型返回 标题 + 摘要 + 最终 URL + ref，
 *   符合 evidencePolicy=artifact_ref。
 * - 抓取细节（隐藏 BrowserWindow / HTTP 退化）封装在 web-fetch-engine，本 Provider
 *   只负责权限、落盘、Evidence 组装。
 */

const WEB_FETCH_CAPABILITY = 'local.web.fetch';
const SUMMARY_MAX_CHARS = 2_000;

function buildScope({ url }) {
  let host = 'unknown';
  try {
    host = new URL(url).host;
  } catch {
    host = 'unknown';
  }
  return {
    kind: 'web-fetch',
    host,
    url,
  };
}

function summarize(content, maxChars = SUMMARY_MAX_CHARS) {
  const text = String(content ?? '').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

export function createLocalWebProvider({ userDataPath, artifactStore = null, webFetcher = fetchWebPage } = {}) {
  const store = artifactStore ?? createWebArtifactStore({ userDataPath });

  async function executeCapability(request, context = {}) {
    const call = request?.call;
    const locale = context.locale ?? 'en-US';
    if (!call || call.capabilityId !== WEB_FETCH_CAPABILITY) return null;

    const args = call.arguments ?? call.argumentsPreview ?? {};
    const url = String(args?.url ?? '').trim();
    if (!url) {
      return {
        call,
        result: createFailedClientToolResult({
          call,
          locale,
          reason: locale === 'zh-CN' ? '缺少必填参数 url。' : 'Missing required argument: url.',
          dataLevel: 'D2_sensitive',
          status: 'failed',
        }),
      };
    }

    const scope = buildScope({ url });

    // 联网授权：默认放行真值由上游 permission-gate / requestPermission 决定。
    let permissionGrant = createPermissionGrant({
      toolCallId: call.toolCallId,
      granted: true,
      scope,
    });

    if (typeof context.requestPermission === 'function') {
      const decision = await context.requestPermission({
        toolCallId: call.toolCallId,
        capabilityId: call.capabilityId,
        toolName: call.toolName,
        arguments: args,
        scope,
        riskLevel: call.riskLevel ?? 'L3_external_write',
        dataLevel: call.dataLevel ?? 'D2_sensitive',
        reason:
          locale === 'zh-CN'
            ? `请求联网抓取网页：${scope.host}`
            : `Requesting network access to fetch: ${scope.host}`,
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
            reason:
              locale === 'zh-CN'
                ? '联网抓取未获授权，已拒绝。'
                : 'Network fetch was not authorized; request denied.',
            dataLevel: 'D2_sensitive',
            status: 'denied',
          }),
        };
      }
    }

    const startedAt = nowIso();
    let fetchResult;
    try {
      fetchResult = await webFetcher({
        url,
        waitForRender: args?.waitForRender !== false,
        timeoutMs: Number.isFinite(args?.timeoutMs) ? args.timeoutMs : undefined,
      });
    } catch (error) {
      return {
        call,
        permissionGrant,
        result: createFailedClientToolResult({
          call,
          locale,
          reason:
            locale === 'zh-CN'
              ? `网页抓取异常：${String(error?.message ?? error)}`
              : `Web fetch error: ${String(error?.message ?? error)}`,
          dataLevel: 'D2_sensitive',
          status: 'failed',
        }),
      };
    }

    if (!fetchResult?.ok) {
      return {
        call,
        permissionGrant,
        result: createFailedClientToolResult({
          call,
          locale,
          reason:
            locale === 'zh-CN'
              ? `网页抓取失败：${fetchResult?.error ?? 'unknown'}（mode=${fetchResult?.fetchMode ?? 'none'}）`
              : `Web fetch failed: ${fetchResult?.error ?? 'unknown'} (mode=${fetchResult?.fetchMode ?? 'none'})`,
          dataLevel: 'D2_sensitive',
          status: 'failed',
        }),
      };
    }

    const completedAt = nowIso();
    const fetchId = randomUUID();
    const artifact = await store.writeFetchArtifacts({
      fetchId,
      toolCallId: call.toolCallId,
      requestedUrl: url,
      finalUrl: fetchResult.finalUrl,
      title: fetchResult.title,
      content: fetchResult.content,
      contentType: fetchResult.contentType,
      httpStatus: fetchResult.httpStatus,
      fetchMode: fetchResult.fetchMode,
      startedAt,
      completedAt,
    });

    const summary = summarize(fetchResult.content);
    const status = 'success';

    return {
      call,
      permissionGrant,
      result: {
        toolCallId: call.toolCallId,
        status,
        outputPreview: {
          status,
          title: fetchResult.title,
          finalUrl: fetchResult.finalUrl,
          fetchMode: fetchResult.fetchMode,
          httpStatus: fetchResult.httpStatus,
          contentChars: String(fetchResult.content ?? '').length,
          summary,
          artifactRef: artifact.artifactRef,
          artifactRefs: artifact.artifactRefs,
          truncated: artifact.truncated,
        },
        output: {
          title: fetchResult.title,
          finalUrl: fetchResult.finalUrl,
          summary,
          artifactRef: artifact.artifactRef,
        },
        evidence: {
          toolCallId: call.toolCallId,
          summary:
            locale === 'zh-CN'
              ? `已抓取网页「${fetchResult.title || fetchResult.finalUrl}」，正文已落盘（${artifact.artifactRef}）。`
              : `Fetched web page "${fetchResult.title || fetchResult.finalUrl}"; content stored at ${artifact.artifactRef}.`,
          locale,
          returnedToCloud: true,
          dataLevel: 'D2_sensitive',
          redactions: [],
          artifactRefs: artifact.artifactRefs,
          origin: {
            providerId: 'local.web',
            capabilityId: call.capabilityId,
            requestedUrl: url,
            finalUrl: fetchResult.finalUrl,
            fetchMode: fetchResult.fetchMode,
            httpStatus: fetchResult.httpStatus,
          },
        },
        completedAt,
      },
    };
  }

  return {
    providerId: 'local.web',
    capabilityIds: [WEB_FETCH_CAPABILITY],
    executeCapability,
    artifactStore: store,
  };
}
