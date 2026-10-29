import type {RemoteProjectGrant} from './remote-access.ts';

/** Local settings contract. Callers cannot supply a delegation version in a patch. */
export interface RemoteAccessSettings {
  enabled: boolean;
  gatewayOrigin: string;
  workspaceId: string;
  projectGrants: readonly RemoteProjectGrant[];
  workspaceIds: readonly string[];
  delegationVersion: number;
}
export interface RemoteAccessPatch {
  enabled?: boolean;
  gatewayOrigin?: string;
  workspaceId?: string;
  projectGrants?: readonly RemoteProjectGrant[];
}
export interface RemoteAccessSummary {
  at: number;
  operation: 'project.list'|'project.conversation.read'|'project.session.read'|'project.input.submit';
  workspaceId?: string;
}
