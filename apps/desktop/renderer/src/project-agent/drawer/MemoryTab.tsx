import type { I18nRuntime } from '@peer-agent/i18n';
import { useEffect, useState } from 'react';
import { Dropdown } from '../../app/components/Dropdown';
import { clientApi } from '../../clientApi';
import { Switch } from '../../ui/boolean-controls';
import {
  filterMemoryRecords,
  readMemoryItems,
  readMemoryRecords,
  readMemorySwitches,
  type DrawerMemoryItem,
  type MemoryRecord,
  type MemorySwitches,
} from '../state/drawerState';

const KINDS = [
  { value: '', key: 'projectAgent.drawer.memory.filter.all' },
  { value: 'fact', key: 'projectAgent.drawer.memory.kind.fact' },
  { value: 'preference', key: 'projectAgent.drawer.memory.kind.preference' },
  { value: 'decision', key: 'projectAgent.drawer.memory.kind.decision' },
  { value: 'procedure', key: 'projectAgent.drawer.memory.kind.procedure' },
  { value: 'responsibility', key: 'projectAgent.drawer.memory.kind.responsibility' },
] as const;
const TRUSTS = [
  { value: '', key: 'projectAgent.drawer.memory.filter.all' },
  { value: 'stated', key: 'projectAgent.drawer.memory.trust.stated' },
  { value: 'verified', key: 'projectAgent.drawer.memory.trust.verified' },
] as const;
const STATUSES = [
  { value: '', key: 'projectAgent.drawer.memory.filter.all' },
  { value: 'active', key: 'projectAgent.drawer.memory.status.active' },
  { value: 'forgotten', key: 'projectAgent.drawer.memory.status.forgotten' },
  { value: 'expired', key: 'projectAgent.drawer.memory.status.expired' },
  { value: 'conflicted', key: 'projectAgent.drawer.memory.status.conflicted' },
] as const;

function memoryLabel(i18n: I18nRuntime, value: string, options: readonly { value: string; key: Parameters<I18nRuntime['t']>[0] }[]) {
  const option = options.find((item) => item.value === value);
  return option ? i18n.t(option.key) : value;
}

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

  function updateSwitch(patch: Partial<MemorySwitches>) {
    void clientApi.projectMemorySetSwitches({ workspaceId, ...patch }).then(() => reload());
  }

  return (
    <div className="bot-drawer-tab bot-memory-tab">
      <section className="bot-memory-section">
        <h2>{i18n.t('projectAgent.drawer.memory.controls')}</h2>
        <div className="bot-memory-settings-card">
          <div className="bot-memory-setting-group">
            <span className="bot-memory-setting-scope">{i18n.t('projectAgent.drawer.memory.scope.project')}</span>
            <div className="bot-memory-setting-row">
              <span>{i18n.t('projectAgent.drawer.memory.projectSwitch')}</span>
              <Switch
                checked={switches.memoryEnabled}
                aria-label={i18n.t('projectAgent.drawer.memory.projectSwitch')}
                onCheckedChange={(checked) => updateSwitch({ memoryEnabled: checked })}
              />
            </div>
          </div>
          <div className="bot-memory-setting-group">
            <span className="bot-memory-setting-scope">{i18n.t('projectAgent.drawer.memory.scope.global')}</span>
            <div className="bot-memory-setting-row">
              <span>{i18n.t('projectAgent.drawer.memory.useMemory')}</span>
              <Switch
                checked={switches.useMemory}
                aria-label={i18n.t('projectAgent.drawer.memory.useMemory')}
                onCheckedChange={(checked) => updateSwitch({ useMemory: checked })}
              />
            </div>
            <div className="bot-memory-setting-row">
              <span>{i18n.t('projectAgent.drawer.memory.learnPreferences')}</span>
              <Switch
                checked={switches.learnPreferences}
                aria-label={i18n.t('projectAgent.drawer.memory.learnPreferences')}
                onCheckedChange={(checked) => updateSwitch({ learnPreferences: checked })}
              />
            </div>
            <p className="bot-drawer-note">{i18n.t('projectAgent.drawer.memory.learnLater')}</p>
          </div>
        </div>
      </section>
      <section className="bot-memory-section">
        <h2>{i18n.t('projectAgent.drawer.memory.saved')}</h2>
        {items.length === 0 ? (
          <div className="bot-memory-empty" role="status">
            <svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">
              <path d="M8 10c4-2 8-2 12 0 4-2 8-2 12 0v20c-4-2-8-2-12 0-4-2-8-2-12 0V10Z" />
              <path d="M20 10v20M12 15h4M24 15h4" />
            </svg>
            <strong>{i18n.t('projectAgent.drawer.memory.empty')}</strong>
            <p>{i18n.t('projectAgent.drawer.memory.emptyHint')}</p>
          </div>
        ) : (
          <>
            <div className="bot-memory-filters">
              <div className="bot-memory-filter">
                <span>{i18n.t('projectAgent.drawer.memory.filter.kind')}</span>
                <Dropdown
                  value={kind}
                  ariaLabel={i18n.t('projectAgent.drawer.memory.filter.kind')}
                  className="bot-memory-filter-dropdown"
                  options={KINDS.map((item) => ({ value: item.value, label: i18n.t(item.key) }))}
                  onChange={setKind}
                />
              </div>
              <div className="bot-memory-filter">
                <span>{i18n.t('projectAgent.drawer.memory.filter.trust')}</span>
                <Dropdown
                  value={trust}
                  ariaLabel={i18n.t('projectAgent.drawer.memory.filter.trust')}
                  className="bot-memory-filter-dropdown"
                  options={TRUSTS.map((item) => ({ value: item.value, label: i18n.t(item.key) }))}
                  onChange={setTrust}
                />
              </div>
              <div className="bot-memory-filter">
                <span>{i18n.t('projectAgent.drawer.memory.filter.status')}</span>
                <Dropdown
                  value={status}
                  ariaLabel={i18n.t('projectAgent.drawer.memory.filter.status')}
                  className="bot-memory-filter-dropdown"
                  options={STATUSES.map((item) => ({ value: item.value, label: i18n.t(item.key) }))}
                  onChange={setStatus}
                />
              </div>
            </div>
            {visible.length === 0 ? <p className="bot-memory-filter-empty">{i18n.t('projectAgent.drawer.memory.filterEmpty')}</p> : null}
            <ul className="bot-memory-list">
              {visible.map((item) => (
                <li key={item.id}>
                  <div className="bot-memory-item-meta">
                    <span>{memoryLabel(i18n, item.kind, KINDS)}</span>
                    <span>{memoryLabel(i18n, item.trust, TRUSTS)}</span>
                    <span>{memoryLabel(i18n, item.status, STATUSES)}</span>
                    {item.needsReverify ? <span>{i18n.t('projectAgent.drawer.memory.needsReverify')}</span> : null}
                  </div>
                  {editingId === item.id ? (
                    <input aria-label={i18n.t('projectAgent.drawer.memory.edit')} value={draft} onChange={(event) => setDraft(event.target.value)} />
                  ) : (
                    <p>{item.text}</p>
                  )}
                  {item.sourceRefs?.length ? <p className="bot-drawer-note">{i18n.t('projectAgent.drawer.memory.sources')}: {item.sourceRefs.join(' · ')}</p> : null}
                  <div className="bot-memory-item-actions">
                    {item.status === 'conflicted' ? <button type="button" onClick={() => {
                      void clientApi.projectMemoryRestore({ workspaceId, id: item.id, resolveConflict: true }).then(() => reload());
                    }}>{i18n.t('projectAgent.drawer.memory.keepThis')}</button> : null}
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
            <div className="bot-memory-export-actions">
              <button type="button" onClick={() => { void clientApi.projectMemoryExport({ workspaceId, format: 'json' }); }}>
                {i18n.t('projectAgent.drawer.memory.exportJson')}
              </button>
              <button type="button" onClick={() => { void clientApi.projectMemoryExport({ workspaceId, format: 'markdown' }); }}>
                {i18n.t('projectAgent.drawer.memory.exportMarkdown')}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
