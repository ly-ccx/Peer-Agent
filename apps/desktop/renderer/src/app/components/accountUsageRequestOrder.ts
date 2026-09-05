/** Owns request ordering only; contains no account data or credentials. */
export function createAccountUsageRequestOrder() {
  let sequence = 0;
  let loadingOwner = 0;
  const latest = new Map<string, number>();
  return {
    begin(id: string) {
      const ticket = ++sequence;
      latest.set(id, ticket);
      loadingOwner = ticket;
      return {
        current: () => latest.get(id) === ticket,
        finish: () => {
          const ownsLoading = loadingOwner === ticket;
          if (ownsLoading) loadingOwner = 0;
          return ownsLoading;
        },
      };
    },
  };
}
