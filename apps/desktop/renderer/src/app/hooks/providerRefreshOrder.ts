/** Monotonic refresh ordering: accepts newer replies even while another refresh is in flight, while rejecting out-of-order stale replies. */
export function createProviderRefreshOrder() {
  let issued = 0;
  let applied = 0;
  let alive = true;
  return {
    mount() { alive = true; },
    unmount() { alive = false; applied = ++issued; },
    begin() { return ++issued; },
    canApply(ticket: number) {
      if (!alive || ticket <= applied) return false;
      applied = ticket;
      return true;
    },
    isLatest(ticket: number) { return alive && ticket === issued; },
    isAlive() { return alive; },
  };
}
