/**
 * Password manager Phase 1 UI：列表 / 增删改 / 揭示 / 填充当前页。
 * 列表不含 password 明文；reveal/fill 仅用户手势触发。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientApi } from '../../clientApi';

export interface PasswordManagerPanelProps {
  readonly open: boolean;
  readonly isZh: boolean;
  readonly pageUrl?: string | null;
  readonly webContentsId?: number | null;
  readonly onClose: () => void;
  readonly onStatus?: (message: string) => void;
}

type VaultEntry = {
  readonly id: string;
  readonly origin: string;
  readonly username: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastUsedAt?: string;
};

export function PasswordManagerPanel({
  open,
  isZh,
  pageUrl,
  webContentsId,
  onClose,
  onStatus,
}: PasswordManagerPanelProps) {
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [formOrigin, setFormOrigin] = useState('');
  const [formUsername, setFormUsername] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  const t = useMemo(
    () => ({
      title: isZh ? '密码管理' : 'Password manager',
      subtitle: isZh
        ? '仅保存在本机。不会导入浏览器密码库，也不会提供给 Agent。'
        : 'Stored on this device only. Does not import browser password DBs or expose secrets to the Agent.',
      close: isZh ? '关闭' : 'Close',
      search: isZh ? '搜索站点或用户名' : 'Search origin or username',
      origin: isZh ? '站点 origin' : 'Origin',
      username: isZh ? '用户名' : 'Username',
      password: isZh ? '密码' : 'Password',
      save: isZh ? '保存' : 'Save',
      update: isZh ? '更新' : 'Update',
      cancel: isZh ? '取消编辑' : 'Cancel edit',
      fill: isZh ? '填充到当前页' : 'Fill current page',
      show: isZh ? '显示' : 'Show',
      hide: isZh ? '隐藏' : 'Hide',
      remove: isZh ? '删除' : 'Delete',
      empty: isZh ? '暂无保存的密码。' : 'No saved passwords yet.',
      reload: isZh ? '刷新' : 'Refresh',
      pageHint: isZh ? '当前页' : 'Current page',
      noWebview: isZh ? '当前标签页尚未就绪，无法填充。' : 'Current tab is not ready to fill.',
      saved: isZh ? '已保存' : 'Saved',
      deleted: isZh ? '已删除' : 'Deleted',
      filled: isZh ? '已填充到当前页' : 'Filled into current page',
      confirmDelete: isZh ? '删除这条密码？' : 'Delete this password entry?',
    }),
    [isZh],
  );

  const pageOrigin = useMemo(() => {
    if (!pageUrl || pageUrl === 'about:blank') return '';
    try {
      return new URL(pageUrl).origin;
    } catch {
      return '';
    }
  }, [pageUrl]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await clientApi.listPasswordVaultEntries();
      if (!res?.ok) {
        setError(res?.error || 'list_failed');
        setEntries([]);
        return;
      }
      setEntries((res.entries || []) as VaultEntry[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setRevealed({});
      setEditingId(null);
      setFormPassword('');
      return;
    }
    if (pageOrigin && !formOrigin) setFormOrigin(pageOrigin);
    void load();
  }, [open, pageOrigin]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) =>
        e.origin.toLowerCase().includes(q) ||
        e.username.toLowerCase().includes(q),
    );
  }, [entries, filter]);

  const resetForm = () => {
    setEditingId(null);
    setFormUsername('');
    setFormPassword('');
    setFormOrigin(pageOrigin || '');
  };

  const onSave = async () => {
    setError(null);
    try {
      const res = await clientApi.upsertPasswordVaultEntry({
        id: editingId || undefined,
        origin: formOrigin,
        username: formUsername,
        password: formPassword,
      });
      if (!res?.ok) {
        setError(res?.error || 'upsert_failed');
        return;
      }
      setFormPassword('');
      setEditingId(null);
      onStatus?.(t.saved);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onDelete = async (id: string) => {
    if (!window.confirm(t.confirmDelete)) return;
    const res = await clientApi.deletePasswordVaultEntry(id);
    if (!res?.ok) {
      setError(res?.error || 'delete_failed');
      return;
    }
    setRevealed((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    onStatus?.(t.deleted);
    await load();
  };

  const onReveal = async (id: string) => {
    if (revealed[id]) {
      setRevealed((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    const res = await clientApi.revealPasswordVaultEntry(id);
    if (!res?.ok || !res.password) {
      setError(res?.error || 'reveal_failed');
      return;
    }
    setRevealed((prev) => ({ ...prev, [id]: res.password as string }));
  };

  const onFill = async (id: string) => {
    if (!webContentsId) {
      setError(t.noWebview);
      return;
    }
    const res = await clientApi.fillPasswordVaultEntry({
      id,
      webContentsId,
      fillUsername: true,
    });
    if (!res?.ok) {
      setError(res?.error || 'fill_failed');
      return;
    }
    onStatus?.(t.filled);
  };

  const startEdit = (entry: VaultEntry) => {
    setEditingId(entry.id);
    setFormOrigin(entry.origin);
    setFormUsername(entry.username);
    setFormPassword('');
  };

  if (!open) return null;

  return (
    <div className="session-import-overlay" role="dialog" aria-modal="true" aria-label={t.title}>
      <div className="session-import-modal password-manager-modal">
        <header className="session-import-header">
          <div>
            <h2 className="session-import-title">{t.title}</h2>
            <p className="session-import-sub">{t.subtitle}</p>
            {pageOrigin ? (
              <p className="session-import-sub">
                {t.pageHint}: {pageOrigin}
              </p>
            ) : null}
          </div>
          <button type="button" className="session-import-close" onClick={onClose}>
            {t.close}
          </button>
        </header>

        {error ? <div className="session-import-error">{error}</div> : null}

        <section className="session-import-body">
          <div className="password-manager-form">
            <input
              className="password-manager-input"
              placeholder={t.origin}
              value={formOrigin}
              onChange={(e) => setFormOrigin(e.target.value)}
            />
            <input
              className="password-manager-input"
              placeholder={t.username}
              value={formUsername}
              onChange={(e) => setFormUsername(e.target.value)}
              autoComplete="username"
            />
            <input
              className="password-manager-input"
              type="password"
              placeholder={t.password}
              value={formPassword}
              onChange={(e) => setFormPassword(e.target.value)}
              autoComplete="new-password"
            />
            <div className="session-import-footer">
              {editingId ? (
                <button type="button" className="session-import-btn" onClick={resetForm}>
                  {t.cancel}
                </button>
              ) : null}
              <button
                type="button"
                className="session-import-btn session-import-btn--primary"
                disabled={!formOrigin || !formUsername || !formPassword}
                onClick={() => void onSave()}
              >
                {editingId ? t.update : t.save}
              </button>
            </div>
          </div>

          <div className="password-manager-toolbar">
            <input
              className="password-manager-input"
              placeholder={t.search}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <button type="button" className="session-import-btn" onClick={() => void load()} disabled={loading}>
              {t.reload}
            </button>
          </div>

          {loading ? <p className="session-import-hint">…</p> : null}
          {!loading && filtered.length === 0 ? (
            <p className="session-import-hint">{t.empty}</p>
          ) : (
            <ul className="session-import-list">
              {filtered.map((entry) => (
                <li key={entry.id} className="password-manager-row">
                  <div className="password-manager-row-main">
                    <div className="session-import-list-main">{entry.origin}</div>
                    <div className="session-import-list-meta">{entry.username}</div>
                    {revealed[entry.id] ? (
                      <div className="password-manager-secret">{revealed[entry.id]}</div>
                    ) : null}
                  </div>
                  <div className="password-manager-row-actions">
                    <button type="button" className="session-import-btn" onClick={() => void onFill(entry.id)}>
                      {t.fill}
                    </button>
                    <button type="button" className="session-import-btn" onClick={() => void onReveal(entry.id)}>
                      {revealed[entry.id] ? t.hide : t.show}
                    </button>
                    <button type="button" className="session-import-btn" onClick={() => startEdit(entry)}>
                      {t.update}
                    </button>
                    <button type="button" className="session-import-btn" onClick={() => void onDelete(entry.id)}>
                      {t.remove}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
