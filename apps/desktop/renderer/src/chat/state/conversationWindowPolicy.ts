/** Scroll-up loads the next older page only after the user reaches the top. */
export function shouldLoadOlderHistory(input: {
  readonly scrollTop: number;
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly userInitiated: boolean;
}): boolean {
  return input.userInitiated && !input.loading && input.hasMore && input.scrollTop <= 64;
}
