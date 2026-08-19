import type {
  CapabilityManifest,
  CapabilityProvider,
  RuntimeProjection,
  RuntimeToolDefinition,
} from '@peer-agent/runtime-core';
import type {
  RuntimePipelineToolCall,
  RuntimePipelineToolExecutor,
  RuntimeSdk,
  RuntimeSdkEvent,
  RuntimeSdkHookRunner,
  RuntimeSdkProviderExecution,
} from '@peer-agent/runtime-sdk';

import type {
  NodeRuntimeCapabilityPermissionPrompt,
  NodeRuntimeExecutionContext,
  NodeRuntimePermissionResponse,
  NodeRuntimeSession,
} from './contracts.ts';
import type { NodeShellArtifactStore } from './shell-artifact-store.ts';
import type { NodeShellSessionManager } from './shell-session.ts';
import type { NodeShellTaskManager } from './shell-task-manager.ts';

export type NodeCapabilityApprovalKind = 'file-write' | 'shell-exec' | 'web-fetch';

export interface NodeCapabilityPermissionPrompt
  extends NodeRuntimeCapabilityPermissionPrompt {
  readonly confirmation: NodeRuntimeCapabilityPermissionPrompt['confirmation'] & {
    readonly approvalKind: NodeCapabilityApprovalKind;
  };
}

export type NodeCapabilityApprovalPort = (
  prompt: NodeCapabilityPermissionPrompt,
) => Promise<NodeRuntimePermissionResponse> | NodeRuntimePermissionResponse;

export interface NodeFileProviderOptions {
  readonly workspaceRoot: string;
  readonly requestApproval?: NodeCapabilityApprovalPort;
  readonly now?: () => string;
  readonly idFactory?: () => string;
  readonly maxReadBytes?: number;
}

export interface NodeShellProviderOptions {
  readonly workspaceRoot: string;
  readonly requestApproval?: NodeCapabilityApprovalPort;
  readonly now?: () => string;
  readonly idFactory?: () => string;
  readonly defaultTimeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly shellPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly artifactRoot?: string;
  readonly killGraceMs?: number;
  readonly taskManager?: NodeShellTaskManager;
  readonly sessionManager?: NodeShellSessionManager;
  readonly artifactStore?: NodeShellArtifactStore;
}

export interface CreateNodeProviderBundleOptions {
  readonly workspaceRoot: string;
  readonly sessionProvider?: {
    getSession(): NodeRuntimeSession;
  };
  readonly requestPermission?: NodeRuntimeExecutionContext['requestPermission'];
  readonly requestCapabilityApproval?: NodeCapabilityApprovalPort;
  readonly hookRunner?: RuntimeSdkHookRunner | null;
  readonly now?: () => string;
  readonly idFactory?: () => string;
  readonly mode?: string;
  readonly file?: Omit<NodeFileProviderOptions, 'workspaceRoot' | 'requestApproval' | 'now' | 'idFactory'> | false;
  readonly shell?: Omit<NodeShellProviderOptions, 'workspaceRoot' | 'requestApproval' | 'now' | 'idFactory'> | false;
  readonly web?: { readonly artifactRoot?: string } | false;
  /** Pass false to omit request_user_input from the bundle. */
  readonly interaction?: false;
}

export interface NodeProviderBundle {
  readonly workspaceRoot: string;
  readonly manifests: readonly CapabilityManifest[];
  readonly toolDefinitions: readonly RuntimeToolDefinition[];
  readonly projection: RuntimeProjection;
  readonly providers: readonly CapabilityProvider[];
  readonly runtime: RuntimeSdk;
  readonly pipelineToolExecutor: RuntimePipelineToolExecutor<
    unknown,
    RuntimePipelineToolCall,
    RuntimeSdkProviderExecution
  >;
  readonly events: {
    subscribe(listener: (event: RuntimeSdkEvent) => void): () => void;
  };
  dispose(): Promise<void>;
}
