import { resolve } from 'node:path';

import type { CapabilityManifest, CapabilityProvider } from '@peer-agent/runtime-core';
import type { RuntimeSdkToolCall } from '@peer-agent/runtime-sdk';

import type { NodeCapabilityApprovalPort } from './provider-contracts.ts';
import {
  asRecord,
  createNodePermissionGrant,
  createNodeToolResult,
  createProviderRuntimeClock,
} from './provider-utils.ts';
import {
  createNodeWebArtifactStore,
  type NodeWebArtifactStore,
} from './web-artifact-store.ts';
import {
  fetchNodeWebPage,
  type NodeFetchLike,
  type NodeWebFetchResult,
} from './web-fetch-engine.ts';

const CAPABILITY_ID = 'local.web.fetch';
const SUMMARY_CHARS = 4_000;
const WEB_MODE_SCOPES = Object.freeze(['chat', 'plan', 'goal'] as const);

export const NODE_WEB_FETCH_CAPABILITY_MANIFESTS: readonly CapabilityManifest[] = Object.freeze([
  {
    capabilityId: CAPABILITY_ID,
    displayName: 'Fetch web page',
    description: 'Fetch an http(s) page, extract readable content, and return a summary plus local artifact references.',
    riskLevel: 'L3_sensitive',
    modeScopes: WEB_MODE_SCOPES,
    metadata: { modelToolName: 'web_fetch' },
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to fetch.' },
        waitForRender: {
          type: 'boolean',
          description: 'Accepted for cross-host compatibility; CLI static HTTP fetch cannot render client JavaScript.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Fetch timeout in milliseconds (default 30000, maximum 120000).',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
]);

export interface NodeWebFetchProviderOptions {
  readonly workspaceRoot: string;
  readonly requestApproval?: NodeCapabilityApprovalPort;
  readonly artifactStore?: NodeWebArtifactStore;
  readonly artifactRoot?: string;
  readonly fetcher?: NodeFetchLike;
  readonly webFetcher?: (input: {
    readonly url: string;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly fetcher?: NodeFetchLike;
  }) => Promise<NodeWebFetchResult>;
  readonly now?: () => string;
  readonly idFactory?: () => string;
}

function requireUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('invalid_url');
  return value.trim();
}

function summarize(content: string): string {
  if (content.length <= SUMMARY_CHARS) return content;
  return `${content.slice(0, SUMMARY_CHARS)}\n...[content stored in artifact]`;
}

export function createNodeWebFetchProvider(options: NodeWebFetchProviderOptions): CapabilityProvider {
  if (!options?.workspaceRoot) throw new TypeError('Node web fetch provider requires workspaceRoot.');
  const workspaceRoot = resolve(options.workspaceRoot);
  const clock = createProviderRuntimeClock(options);
  const store = options.artifactStore ?? createNodeWebArtifactStore({
    rootPath: options.artifactRoot,
    now: () => new Date(clock.now()),
    idFactory: clock.idFactory,
  });
  const webFetcher = options.webFetcher ?? fetchNodeWebPage;

  return {
    providerId: 'runtime-node.web-fetch',
    capabilities: NODE_WEB_FETCH_CAPABILITY_MANIFESTS,
    async execute(request, context) {
      const call = request.toolCall as RuntimeSdkToolCall;
      const input = asRecord(request.input ?? request.toolCall.input);
      if (context.signal?.aborted) {
        return createNodeToolResult({
          clock,
          call,
          status: 'cancelled',
          summary: 'Web fetch was cancelled.',
          error: { code: 'aborted', message: 'aborted', recoverable: true },
          dataLevel: 'D2_sensitive',
        });
      }

      try {
        const url = requireUrl(input.url);
        const approval = options.requestApproval
          ? await options.requestApproval({
              tool: 'web_fetch',
              toolName: 'web_fetch',
              capabilityId: CAPABILITY_ID,
              args: { url },
              workspacePath: workspaceRoot,
              reason: `Allow network access to fetch ${url}?`,
              confirmation: {
                kind: 'capability-approval',
                approvalKind: 'web-fetch',
                reason: `Allow network access to fetch ${url}?`,
              },
              scope: { kind: 'capability-approval', capabilityId: CAPABILITY_ID, workspaceRoot },
              riskLevel: 'L3_sensitive',
              dataLevel: 'D2_sensitive',
              metadata: { url, operation: 'web_fetch' },
            })
          : { granted: false, reason: 'approval_unavailable' };
        if (!approval?.granted) {
          const reason = approval?.reason ?? 'user_denied';
          return createNodeToolResult({
            clock,
            call,
            status: 'denied',
            summary: `Web fetch denied: ${reason}.`,
            grant: createNodePermissionGrant({ clock, call, decision: 'deny', reason }),
            error: { code: reason, message: reason, recoverable: false },
            dataLevel: 'D2_sensitive',
            metadata: { url, operation: 'web_fetch' },
          });
        }

        const grant = createNodePermissionGrant({
          clock,
          call,
          decision: 'allow',
          reason: approval.reason ?? 'approved',
          metadata: { url, operation: 'web_fetch' },
        });
        const startedAt = clock.now();
        const fetched = await webFetcher({
          url,
          timeoutMs: typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined,
          signal: context.signal,
          fetcher: options.fetcher,
        });
        if (!fetched.ok) {
          const reason = fetched.error ?? 'web_fetch_failed';
          const status = reason === 'aborted'
            ? 'cancelled'
            : reason === 'timeout' ? 'timeout' : 'failed';
          return createNodeToolResult({
            clock,
            call,
            status,
            summary: `Web fetch failed: ${reason}.`,
            grant,
            error: { code: reason, message: reason, recoverable: true },
            dataLevel: 'D2_sensitive',
            metadata: {
              url,
              operation: 'web_fetch',
              fetchMode: fetched.fetchMode,
              ...(fetched.httpStatus === undefined ? {} : { httpStatus: fetched.httpStatus }),
            },
          });
        }

        const completedAt = clock.now();
        const finalUrl = fetched.finalUrl ?? url;
        const title = fetched.title ?? '';
        const content = fetched.content ?? '';
        const contentType = fetched.contentType ?? 'text/plain';
        const artifact = await store.writeFetchArtifact({
          toolCallId: call.toolCallId,
          requestedUrl: url,
          finalUrl,
          title,
          content,
          contentType,
          httpStatus: fetched.httpStatus,
          fetchMode: fetched.fetchMode,
          startedAt,
          completedAt,
        });
        const output = {
          status: 'success',
          requestedUrl: url,
          finalUrl,
          title,
          summary: summarize(content),
          contentType,
          httpStatus: fetched.httpStatus,
          fetchMode: fetched.fetchMode,
          waitForRenderRequested: input.waitForRender !== false,
          rendered: false,
          artifactRef: artifact.artifactRef,
          artifactRefs: artifact.artifactRefs,
          contentTruncated: artifact.truncated,
        };
        return createNodeToolResult({
          clock,
          call,
          status: 'completed',
          summary: title ? `Fetched ${title}.` : `Fetched ${finalUrl}.`,
          output,
          outputPreview: output,
          grant,
          dataLevel: 'D2_sensitive',
          artifactRefs: artifact.artifactRefs,
          metadata: {
            url,
            finalUrl,
            operation: 'web_fetch',
            fetchMode: fetched.fetchMode,
            ...(fetched.httpStatus === undefined ? {} : { httpStatus: fetched.httpStatus }),
          },
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return createNodeToolResult({
          clock,
          call,
          status: reason === 'aborted' ? 'cancelled' : 'failed',
          summary: `Web fetch failed: ${reason}.`,
          grant: createNodePermissionGrant({ clock, call, decision: 'deny', reason }),
          error: { code: reason, message: reason, recoverable: true },
          dataLevel: 'D2_sensitive',
        });
      }
    },
  };
}
