function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function owner(ownerName, register) {
  return Object.freeze({ owner: ownerName, register });
}

function messageOf(error, fallback) {
  return error?.message || fallback;
}

export function createPasswordVaultIpcRegistrations({ passwordVault } = {}) {
  const ports = {
    listEntries: assertFunction(passwordVault?.listEntries, 'passwordVault.listEntries'),
    listForOrigin: assertFunction(passwordVault?.listForOrigin, 'passwordVault.listForOrigin'),
    upsertEntry: assertFunction(passwordVault?.upsertEntry, 'passwordVault.upsertEntry'),
    deleteEntry: assertFunction(passwordVault?.deleteEntry, 'passwordVault.deleteEntry'),
    revealPassword: assertFunction(passwordVault?.revealPassword, 'passwordVault.revealPassword'),
    fill: assertFunction(passwordVault?.fill, 'passwordVault.fill'),
  };

  return Object.freeze([
    owner('password-vault-ipc', (ipc) => {
      ipc.handle('password-vault:list', async (_event, { origin } = {}) => {
        try {
          const entries = origin ? ports.listForOrigin(origin) : ports.listEntries();
          return { ok: true, entries };
        } catch (error) {
          return { ok: false, error: messageOf(error, 'list_failed'), entries: [] };
        }
      });
      ipc.handle('password-vault:upsert', async (_event, payload = {}) => {
        try {
          return { ok: true, entry: ports.upsertEntry(payload) };
        } catch (error) {
          return { ok: false, error: messageOf(error, 'upsert_failed') };
        }
      });
      ipc.handle('password-vault:delete', async (_event, { id } = {}) => {
        try {
          return ports.deleteEntry(id);
        } catch (error) {
          return { ok: false, error: messageOf(error, 'delete_failed') };
        }
      });
      ipc.handle('password-vault:reveal', async (_event, { id } = {}) => {
        try {
          return ports.revealPassword(id);
        } catch (error) {
          return { ok: false, error: messageOf(error, 'reveal_failed') };
        }
      });
      ipc.handle('password-vault:fill', async (_event, payload = {}) => {
        try {
          return ports.fill(payload);
        } catch (error) {
          return { ok: false, error: messageOf(error, 'fill_failed') };
        }
      });
    }),
  ]);
}
