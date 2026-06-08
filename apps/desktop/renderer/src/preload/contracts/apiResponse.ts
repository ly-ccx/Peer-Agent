export interface PreloadApiResponse<T> {
  readonly code?: number;
  readonly success?: boolean;
  readonly data?: T;
  readonly errorMsg?: string;
}

export type PreloadResult<T> = Promise<PreloadApiResponse<T>>;
