import type {
  AgentCronRunListData,
  AgentCronSessionListData,
  ExecutionDetailData,
  ExecutionListData,
  OpenClawGovernanceListData,
  RelatedShadowExecutionListData,
  ToolCallListData,
  ToolCallRecord,
} from '@zeus-atlas/protocol';
import { type ApiResponse, unwrap } from './apiResponse';

export function normalizeAgentCronSessionListData(raw: AgentCronSessionListData): AgentCronSessionListData {
  const items = raw.items ?? raw.list ?? [];
  return {
    ...raw,
    items,
    list: items,
    total: typeof raw.total === 'number' ? raw.total : items.length,
  };
}

export function normalizeAgentCronRunListData(raw: AgentCronRunListData): AgentCronRunListData {
  const items = raw.items ?? raw.list ?? [];
  return {
    ...raw,
    items,
    list: items,
    total: typeof raw.total === 'number' ? raw.total : items.length,
  };
}

function isToolCallRecordArray(raw: ToolCallListData | readonly ToolCallRecord[]): raw is readonly ToolCallRecord[] {
  return Array.isArray(raw);
}

export function normalizeToolCallListData(raw: ToolCallListData | readonly ToolCallRecord[]): ToolCallListData {
  if (isToolCallRecordArray(raw)) {
    return {
      items: raw,
      list: raw,
      total: raw.length,
    };
  }

  const items = raw.items ?? raw.list ?? [];
  return {
    ...raw,
    items,
    list: items,
    total: typeof raw.total === 'number' ? raw.total : items.length,
  };
}

function isExecutionDetailArray(raw: ExecutionListData | RelatedShadowExecutionListData | readonly ExecutionDetailData[]): raw is readonly ExecutionDetailData[] {
  return Array.isArray(raw);
}

export function normalizeExecutionListData(raw: ExecutionListData | readonly ExecutionDetailData[]): ExecutionListData {
  if (isExecutionDetailArray(raw)) {
    return {
      items: raw,
      list: raw,
      total: raw.length,
    };
  }

  const items = raw.items ?? raw.list ?? [];
  return {
    ...raw,
    items,
    list: items,
    total: typeof raw.total === 'number' ? raw.total : items.length,
  };
}

export function normalizeRelatedShadowExecutionListData(
  raw: RelatedShadowExecutionListData | readonly ExecutionDetailData[],
): RelatedShadowExecutionListData {
  if (isExecutionDetailArray(raw)) {
    return {
      items: raw,
      list: raw,
      total: raw.length,
    };
  }

  const items = raw.items ?? raw.list ?? [];
  return {
    ...raw,
    items,
    list: items,
    total: typeof raw.total === 'number' ? raw.total : items.length,
  };
}

function isOpenClawGovernanceRecordArray(
  raw: OpenClawGovernanceListData | readonly Record<string, unknown>[],
): raw is readonly Record<string, unknown>[] {
  return Array.isArray(raw);
}

export function normalizeOpenClawGovernanceListData(
  raw: OpenClawGovernanceListData | readonly Record<string, unknown>[],
): OpenClawGovernanceListData {
  if (isOpenClawGovernanceRecordArray(raw)) {
    return {
      items: raw,
      list: raw,
      total: raw.length,
    };
  }

  const items = raw.items ?? raw.list ?? [];
  return {
    ...raw,
    items,
    list: items,
    total: typeof raw.total === 'number' ? raw.total : items.length,
  };
}

export async function unwrapOpenClawGovernanceList(
  response: Promise<ApiResponse<OpenClawGovernanceListData | readonly Record<string, unknown>[]>>,
  fallbackMessage: string,
): Promise<OpenClawGovernanceListData> {
  return normalizeOpenClawGovernanceListData(unwrap(await response, fallbackMessage));
}
