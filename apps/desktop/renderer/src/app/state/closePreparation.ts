/** A view may save/validate before closing. Late or rejected preparations never dismiss it. */
export function createClosePreparation() {
  let generation = 0, pending = false;
  return {
    request(prepare: () => boolean | Promise<boolean>, accept: () => void) {
      if (pending) return;
      const ticket = ++generation;
      const finish = (allowed: boolean) => {
        if (ticket !== generation) return;
        pending = false;
        if (allowed) accept();
      };
      try {
        const allowed = prepare();
        if (typeof allowed === 'boolean') finish(allowed);
        else { pending = true; void allowed.then(finish, () => finish(false)); }
      } catch { finish(false); }
    },
    cancel() { generation++; pending = false; },
  };
}
