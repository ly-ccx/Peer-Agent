// A token may rotate even when the response is lost. Never replay this POST.
// Keep the chosen host transport (including Grok/proxy policy) and bound the
// entire response body as well as connection establishment.
export function createOAuthRefreshFetch(transport) {
  return (input, init = {}) => {
    const deadline = AbortSignal.timeout(15_000);
    return transport(input, {
      ...init,
      redirect: 'error',
      signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
    }, { retryDelaysMs: [] });
  };
}
