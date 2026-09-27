import type { I18nRuntime } from '@peer-agent/i18n';
import { useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';
import {
  filterMemoryRecords,
  readMemoryItems,
  readMemoryRecords,
  readMemorySwitches,
  type DrawerMemoryItem,
  type MemoryRecord,
  type MemorySwitches,
} from '../state/drawerState';

const KINDS = ['', 'fact', 'preference', 'decision', 'procedure', 'responsibility'] as const;
const TRUSTS = ['', 'stated', 'verified'] as const;
const STATUSES = ['', 'active', 'forgotten'] as const;

export function MemoryTab({
  workspaceId,
  i18n,
  onItems,
}: {
  readonly workspaceId: string;
  readonly i18n: I18nRuntime;
  readonly onItems?: (items: readonly DrawerMemoryItem[]) => void;
}) {
  const [items, setItems] = useState<readonly MemoryRecord[]>([]);
  const [switches, setSwitches] = useState<MemorySwitches>({
    memoryEnabled: true,
    useMemory: true,
    learnPreferences: true,
  });
  const [kind, setKind] = useState('');
  const [trust, setTrust] = useState('');
  const [status, setStatus] = useState('');
  const [editingId, setEditingId] = useState('');
  const [draft, setDraft] = useState('');

  async function reload() {
    const result = await clientApi.projectMemoryList({ workspaceId });
    const next = readMemoryRecords(result?.items);
    setItems(next);
    setSwitches(readMemorySwitches(result?.switches));
    onItems?.(readMemoryItems(next));
  }

  useEffect(() => {
    let cancelled = false;
    void clientApi.projectMemoryList({ workspaceId }).then((result) => {
      if (cancelled) return;
      const next = readMemoryRecords(result?.items);
      setItems(next);
      setSwitches(readMemorySwitches(result?.switches));
      onItems?.(readMemoryItems(next));
    }).catch(() => {
      if (!cancelled) setItems([]);
    });
    return () => {
      cancelled = true;
    };
  }, [onItems, workspaceId]);

  const visible = filterMemoryRecords(items, { kind, trust, status });

  return (
    <div className="bot-drawer-tab">
      <div className="bot-memory-switches">
        <label>
          <input
            type="checkbox"
            checked={switches.memoryEnabled}
            onChange={(event) => {
              void clientApi.projectMemorySetSwitches({
                workspaceId,
                memoryEnabled: event.target.checked,
              }).then(() => reload());
            }}
          />
          {i18n.t('projectAgent.drawer.memory.projectSwitch')}
        </label>
        <label>
          <input
            type="checkbox"
            checked={switches.useMemory}
            onChange={(event) => {
              void clientApi.projectMemorySetSwitches({
                workspaceId,
                useMemory: event.target.checked,
              }).then(() => reload());
            }}
          />
          {i18n.t('projectAgent.drawer.memory.useMemory')}
        </label>
        <label>
          <input
            type="checkbox"
            checked={switches.learnPreferences}
            onChange={(event) => {
              void clientApi.projectMemorySetSwitches({
                workspaceId,
                learnPreferences: event.target.checked,
              }).then(() => reload());
            }}
          />
          {i18n.t('projectAgent.drawer.memory.learnPreferences')}
        </label>
      </div>
      <p className="bot-drawer-note">{i18n.t('projectAgent.drawer.memory.learnLater')}</p>
      <div className="bot-memory-filters">
        <label>
          {i18n.t('projectAgent.drawer.memory.filter.kind')}
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            {KINDS.map((value) => (
              <option key={value || 'all'} value={value}>
                {value || i18n.t('projectAgent.drawer.memory.filter.all')}
              </option>
            ))}
          </select>
        </label>
        <label>
          {i18n.t('projectAgent.drawer.memory.filter.trust')}
          <select value={trust} onChange={(event) => setTrust(event.target.value)}>
            {TRUSTS.map((value) => (
              <option key={value || 'all'} value={value}>
                {value || i18n.t('projectAgent.drawer.memory.filter.all')}
              </option>
            ))}
          </select>
        </label>
        <label>
          {i18n.t('projectAgent.drawer.memory.filter.status')}
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            {STATUSES.map((value) => (
              <option key={value || 'all'} value={value}>
                {value || i18n.t('projectAgent.drawer.memory.filter.all')}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="bot-memory-actions">
        <button type="button" onClick={() => { void clientApi.projectMemoryExport({ workspaceId, format: 'json' }); }}>
          {i18n.t('projectAgent.drawer.memory.exportJson')}
        </button>
        <button type="button" onClick={() => { void clientApi.projectMemoryExport({ workspaceId, format: 'markdown' }); }}>
          {i18n.t('projectAgent.drawer.memory.exportMarkdown')}
        </button>
      </div>
      {visible.length === 0 ? <p>{i18n.t('projectAgent.drawer.memory.empty')}</p> : (
        <ul>
          {visible.map((item) => (
            <li key={item.id}>
              <span>{item.kind}</span>
              <span>{item.trust}</span>
              <span>{item.status}</span>
              {editingId === item.id ? (
                <input value={draft} onChange={(event) => setDraft(event.target.value)} />
              ) : (
                <p>{item.text}</p>
              )}
              <div className="bot-memory-actions">
                {item.status === 'active' ? (
                  <button
                    type="button"
                    onClick={() => {
                      void clientApi.projectMemoryPin({
                        workspaceId,
                        id: item.id,
                        pinned: item.pinned !== true,
                      }).then(() => reload());
                    }}
                  >
                    {i18n.t(item.pinned ? 'projectAgent.drawer.memory.unpin' : 'projectAgent.drawer.memory.pin')}
                  </button>
                ) : null}
                {item.status === 'forgotten' ? (
                  <button
                    type="button"
                    onClick={() => {
                      void clientApi.projectMemoryRestore({ workspaceId, id: item.id }).then(() => reload());
                    }}
                  >
                    {i18n.t('projectAgent.drawer.memory.restore')}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      void clientApi.projectMemoryForget({ workspaceId, id: item.id }).then(() => reload());
                    }}
                  >
                    {i18n.t('projectAgent.drawer.memory.revoke')}
                  </button>
                )}
                {item.status === 'active' && editingId === item.id ? (
                  <button
                    type="button"
                    onClick={() => {
                      void clientApi.projectMemoryEdit({ workspaceId, id: item.id, text: draft }).then(() => {
                        setEditingId('');
                        setDraft('');
                        return reload();
                      });
                    }}
                  >
                    {i18n.t('projectAgent.drawer.memory.save')}
                  </button>
                ) : null}
                {item.status === 'active' && editingId !== item.id ? (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(item.id);
                      setDraft(item.text);
                    }}
                  >
                    {i18n.t('projectAgent.drawer.memory.edit')}
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
