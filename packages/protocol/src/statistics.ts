export interface ChatStatisticsDateRangeParams {
  readonly startDate: string;
  readonly endDate: string;
  readonly workId?: string;
}

export interface ChatStatisticsOverviewData {
  readonly [key: string]: unknown;
}

export interface ChatStatisticsTrendData {
  readonly list?: readonly Record<string, unknown>[];
  readonly items?: readonly Record<string, unknown>[];
  readonly trends?: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
}

export interface ChatStatisticsRankingData {
  readonly list?: readonly Record<string, unknown>[];
  readonly items?: readonly Record<string, unknown>[];
  readonly rankings?: readonly Record<string, unknown>[];
  readonly total?: number;
  readonly [key: string]: unknown;
}

export interface ChatStatisticsRealtimeData {
  readonly [key: string]: unknown;
}

export type ChatStatisticsExportFormat = 'json' | 'csv';

export interface ChatStatisticsLocalExportRequest {
  readonly reportType: 'statistics_snapshot';
  readonly format: ChatStatisticsExportFormat;
  readonly filename: string;
  readonly content: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ChatStatisticsLocalExportResult {
  readonly saved: boolean;
  readonly cancelled?: boolean;
  readonly filePath?: string;
  readonly bytes?: number;
  readonly reportType: 'statistics_snapshot';
  readonly format: ChatStatisticsExportFormat;
  readonly savedAt?: string;
}

export interface ChatStatisticsCloudExportRequest extends ChatStatisticsDateRangeParams {
  readonly format: ChatStatisticsExportFormat;
  readonly granularity?: 'day' | 'week' | 'month';
  readonly metrics?: readonly string[];
  readonly source?: 'desktop' | 'web';
}

export interface ChatStatisticsCloudExportResult {
  readonly fileUrl?: string;
  readonly downloadUrl?: string;
  readonly url?: string;
  readonly taskId?: string;
  readonly exportId?: string;
  readonly status?: string;
  readonly format?: ChatStatisticsExportFormat | string;
  readonly [key: string]: unknown;
}
