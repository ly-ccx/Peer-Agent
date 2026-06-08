export interface ApiResponse<T> {
  readonly code?: number;
  readonly success?: boolean;
  readonly data?: T;
  readonly errorMsg?: string;
}

export function unwrap<T>(response: ApiResponse<T>, fallbackMessage: string): T {
  if ((response.success === true || response.code === 0) && response.data !== undefined) {
    return response.data;
  }
  throw new Error(response.errorMsg || fallbackMessage);
}
