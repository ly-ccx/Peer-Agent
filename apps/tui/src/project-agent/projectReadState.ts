/** Read-only snapshots, scoped to the current workspace. A failed read never becomes a true empty state. */
export function createProjectReadState() {
  const snapshots = new Map<string, readonly unknown[]>();
  return {
    read<T>(key: string, read: () => readonly T[] | { ok: boolean; items?: readonly T[] }) {
      try {
        const result = read();
        const rows = Array.isArray(result) ? result : (result as { ok: boolean; items?: readonly T[] }).ok
          ? (result as { items?: readonly T[] }).items : undefined;
        if (!Array.isArray(rows)) throw Error('READ_FAILED');
        snapshots.set(key, rows);
        return { rows: rows as readonly T[], error: false };
      } catch { return { rows: (snapshots.get(key) ?? []) as readonly T[], error: true }; }
    },
  };
}
