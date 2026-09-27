/**
 * Project memory contracts. Entries are facts for continuity, not instructions.
 */

import type { MessageDisposition } from './delegation.ts';

export type MemoryKind = 'fact' | 'preference' | 'decision' | 'procedure' | 'responsibility';

export type MemoryTrust = 'verified' | 'stated' | 'inferred';

export type MemoryStatus = 'active' | 'forgotten' | 'expired' | 'conflicted';

export interface MemoryItem {
  readonly id: string;
  readonly scope: 'project' | 'user';
  readonly workspaceId?: string;
  readonly kind: MemoryKind;
  readonly text: string;
  readonly trust: MemoryTrust;
  readonly sourceRefs: readonly string[];
  readonly pinned: boolean;
  readonly status: MemoryStatus;
  readonly confirmedCount: number;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
  readonly expiresAt?: string;
  /** The statement was taken from page, file, or tool content rather than the user. */
  readonly untrusted?: boolean;
}

export interface MemoryEpisode {
  readonly id: string;
  readonly workspaceId: string;
  readonly anchorMessageId: string;
  readonly dispositions: readonly MessageDisposition[];
  readonly summary: string;
  readonly openedAt: string;
  readonly closedAt: string;
}

export interface MemorySnapshot {
  readonly snapshotId: string;
  readonly itemIds: readonly string[];
  readonly createdAt: string;
}

/** 记忆页跨进程载荷。渲染层不读存储。 */
export interface ProjectMemoryRecord {
  readonly id: string;
  readonly scope: 'project' | 'user';
  readonly workspaceId?: string;
  readonly kind: MemoryKind;
  readonly text: string;
  readonly trust: MemoryTrust;
  readonly sourceRefs: readonly string[];
  readonly pinned: boolean;
  readonly status: MemoryStatus;
  readonly confirmedCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastUsedAt?: string;
  readonly anchorMessageId?: string;
  readonly forgetReason?: string;
}

export interface ProjectMemorySwitches {
  readonly memoryEnabled: boolean;
  readonly useMemory: boolean;
  readonly learnPreferences: boolean;
}

export interface ProjectMemoryListRequest {
  readonly workspaceId: string;
  readonly kind?: MemoryKind;
  readonly trust?: MemoryTrust;
  readonly status?: MemoryStatus;
  readonly ids?: readonly string[];
}

export interface ProjectMemoryListResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly items?: readonly ProjectMemoryRecord[];
  readonly switches?: ProjectMemorySwitches;
}

export interface ProjectMemoryPinRequest {
  readonly workspaceId: string;
  readonly id: string;
  readonly pinned: boolean;
}

export interface ProjectMemoryForgetRequest {
  readonly workspaceId: string;
  readonly id: string;
  readonly reason?: string;
}

export interface ProjectMemoryRestoreRequest {
  readonly workspaceId: string;
  readonly id: string;
}

export interface ProjectMemoryEditRequest {
  readonly workspaceId: string;
  readonly id: string;
  readonly text: string;
}

export interface ProjectMemoryItemResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly item?: ProjectMemoryRecord;
  readonly revokedId?: string;
}

export interface ProjectMemoryExportRequest {
  readonly workspaceId: string;
  readonly format: 'json' | 'markdown';
}

export interface ProjectMemoryExportResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly path?: string;
  readonly format?: 'json' | 'markdown';
}

export interface ProjectMemorySetSwitchesRequest {
  readonly workspaceId: string;
  readonly memoryEnabled?: boolean;
  readonly useMemory?: boolean;
  readonly learnPreferences?: boolean;
}

export interface ProjectMemorySetSwitchesResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly switches?: ProjectMemorySwitches;
}

export type MemoryAdmission =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

const SECRET = /sk-[A-Za-z0-9]{8,}|api[_-]?key\s*[:=]|bearer\s+[A-Za-z0-9._\-]{8,}/i;
const LOOSENING = /不用确认|跳过批准|跳过审批|always allow|skip approval|full_local|不用我批/i;
const STANDING_ORDER = /以后都|下次都|always do this/i;

/**
 * Whether a candidate may take effect. Verified items need a resolvable source.
 * Inferred preferences stay inactive until they have been confirmed three times.
 * Secrets, permission loosening, and untrusted standing orders are refused.
 */
export function assessMemoryCandidate(
  item: MemoryItem,
  options: { readonly resolvableRefs?: readonly string[] } = {},
): MemoryAdmission {
  if (item.status === 'forgotten' || item.status === 'expired') {
    return { ok: false, reason: 'inactive' };
  }
  if (item.status === 'conflicted') return { ok: false, reason: 'conflicted' };
  if (SECRET.test(item.text)) return { ok: false, reason: 'sensitive' };
  if (LOOSENING.test(item.text)) return { ok: false, reason: 'loosens_policy' };
  if (item.untrusted === true && (item.kind === 'preference' || STANDING_ORDER.test(item.text))) {
    return { ok: false, reason: 'untrusted_standing_order' };
  }
  if (item.trust === 'verified') {
    const resolvable = options.resolvableRefs;
    if (!resolvable || !item.sourceRefs.some((ref) => resolvable.includes(ref))) {
      return { ok: false, reason: 'evidence_unresolved' };
    }
  }
  if (item.kind === 'preference' && item.trust === 'inferred' && item.confirmedCount < 3) {
    return { ok: false, reason: 'preference_unconfirmed' };
  }
  if (item.trust === 'stated' || item.trust === 'verified' || item.trust === 'inferred') {
    return { ok: true };
  }
  return { ok: false, reason: 'inactive' };
}
