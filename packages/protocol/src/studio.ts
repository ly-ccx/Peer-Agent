export interface OpenClawSceneData {
  readonly [key: string]: unknown;
}

export interface OpenClawSceneEventListData {
  readonly list?: readonly Record<string, unknown>[];
  readonly items?: readonly Record<string, unknown>[];
  readonly events?: readonly Record<string, unknown>[];
  readonly total?: number;
  readonly [key: string]: unknown;
}

export interface OpenClawAgentChannelListData {
  readonly list?: readonly Record<string, unknown>[];
  readonly items?: readonly Record<string, unknown>[];
  readonly channels?: readonly Record<string, unknown>[];
  readonly total?: number;
  readonly [key: string]: unknown;
}

export interface OpenClawAgentChannelSessionListData {
  readonly list?: readonly Record<string, unknown>[];
  readonly items?: readonly Record<string, unknown>[];
  readonly sessions?: readonly Record<string, unknown>[];
  readonly total?: number;
  readonly [key: string]: unknown;
}

export interface OpenClawEnterResultData {
  readonly [key: string]: unknown;
}
