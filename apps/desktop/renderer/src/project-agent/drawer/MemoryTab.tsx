import type { I18nRuntime } from '@peer-agent/i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Dropdown } from '../../app/components/Dropdown';
import { clientApi } from '../../clientApi';
import { Switch } from '../../ui/boolean-controls';
import { ResourceFeedback } from '../../ui/resources/ResourceFeedback';
import { ResourceEditor } from '../../ui/resources/ResourceEditor';
import { useResourceActions, useResourceRead } from '../../ui/resources/useResourceState';
import { PeerIcon } from '../../ui/icons';
import { memoryPage } from '../state/memoryPage';
import {
  readMemoryItems,
  readMemoryRecords,
  readMemorySwitches,
  type DrawerMemoryItem,
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

export function MemoryTab(props: MemoryTabProps) { return <MemoryScope key={props.workspaceId} {...props} />; }
interface MemoryTabProps {
  readonly workspaceId: string; readonly i18n: I18nRuntime; readonly onItems?: (items: readonly DrawerMemoryItem[]) => void;
}

function MemoryScope({
  workspaceId,
  i18n,
  onItems,
}: {
  readonly workspaceId: string;
  readonly i18n: I18nRuntime;
  readonly onItems?: (items: readonly DrawerMemoryItem[]) => void;
}) {
  const resource = useResourceRead(workspaceId, async () => {
    const result = await clientApi.projectMemoryList({ workspaceId });
    if (!result.ok || !result.items || !result.switches) throw Error(result.code || 'READ_FAILED');
    return { items: readMemoryRecords(result.items), switches: readMemorySwitches(result.switches) };
  });
  useEffect(() => clientApi.onProjectAgentChanged(event => {
    if (event.workspaceIds?.includes(workspaceId)) void resource.reload();
  }), [workspaceId, resource.reload]);
  const actions = useResourceActions(workspaceId);
  const items = resource.value?.items ?? [];
  const switches = resource.value?.switches;
  const notify = useRef(onItems); notify.current = onItems;
  useEffect(() => { if (resource.value) notify.current?.(readMemoryItems(resource.value.items)); }, [resource.value]);
  const [exported, setExported] = useState<string | null>(null);
  const memoryRoot = useRef<HTMLDivElement | null>(null);
  const editorTrigger = useRef<HTMLButtonElement | null>(null);
  const locked = !resource.loaded || resource.error;
  const [kind, setKind] = useState('');
  const [trust, setTrust] = useState('');
  const [status, setStatus] = useState('');
  const [pageState, setPageState] = useState({ scope: '', index: 0 });
  const [editingId, setEditingId] = useState('');
  const editingRef = useRef(editingId); editingRef.current = editingId;
  const reload = resource.reload;
  const restoreEditorFocus = useRef(false);
  const closeEditor = () => { restoreEditorFocus.current = true; setEditingId(''); };
  useLayoutEffect(() => { if (!editingId && restoreEditorFocus.current) { restoreEditorFocus.current = false; (editorTrigger.current?.isConnected ? editorTrigger.current : memoryRoot.current)?.focus({ preventScroll: true }); } }, [editingId]);
  async function command(key: string, write: () => Promise<{ ok: boolean; code?: string }>) {
    const confirmed = await actions.run(key, async () => { const result = await write(); if (!result.ok) throw Error(result.code); });
    if (confirmed) void reload();
  }
  async function exportMemory(format: 'json' | 'markdown') {
    await actions.run('export', async () => {
      const result = await clientApi.projectMemoryExport({ workspaceId, format });
      if (!result.ok && result.code === 'CANCELLED') return false;
      if (!result.ok || !result.path) throw Error(result.code || 'NO_EXPORT_PATH');
      setExported(result.path);
    });
  }

  const pageScope = JSON.stringify([workspaceId, kind, trust, status]);
  useEffect(() => { setPageState({ scope: pageScope, index: 0 }); }, [pageScope]);
  const page = memoryPage(items, { kind, trust, status }, pageState.scope === pageScope ? pageState.index : 0);
  const visible = page.items;

  function updateSwitch(patch: Partial<MemorySwitches>) {
    void command('switches', () => clientApi.projectMemorySetSwitches({ workspaceId, ...patch }));
  }

  return (
    <div ref={memoryRoot} tabIndex={-1} className="bot-drawer-tab bot-memory-tab">
      <section className="bot-memory-section">
        <h2>{i18n.t('projectAgent.drawer.memory.saved')}</h2>
        <p className="bot-drawer-note">{i18n.t('resources.memoryScope')}</p>
        <ResourceFeedback i18n={i18n} loading={resource.loading && !resource.loaded} error={resource.error} onReload={reload} />
        {resource.loaded && !resource.error && items.length === 0 ? (
          <div className="bot-memory-empty" role="status">
            <svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">
              <path d="M8 10c4-2 8-2 12 0 4-2 8-2 12 0v20c-4-2-8-2-12 0-4-2-8-2-12 0V10Z" />
              <path d="M20 10v20M12 15h4M24 15h4" />
            </svg>
            <strong>{i18n.t('projectAgent.drawer.memory.empty')}</strong>
            <p>{i18n.t('projectAgent.drawer.memory.emptyHint')}</p>
          </div>
        ) : resource.loaded ? (
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
            {visible.length === 0 && !resource.error && !resource.loading ? <p className="bot-memory-filter-empty">{i18n.t('projectAgent.drawer.memory.filterEmpty')}</p> : null}
            <ul className="bot-memory-list">
              {visible.map((item) => (
                <li key={item.id}>
                  <div className="bot-memory-item-meta">
                    <span>{memoryLabel(i18n, item.kind, KINDS)}</span>
                    {item.status !== 'active' ? <span>{memoryLabel(i18n, item.status, STATUSES)}</span> : null}
                    {item.needsReverify ? <span>{i18n.t('projectAgent.drawer.memory.needsReverify')}</span> : null}
                  </div>
                  {editingId === item.id ? (
                    <ResourceEditor identity={`memory:${workspaceId}:${item.id}`} initial={{ text: item.text }} i18n={i18n}
                      fields={[{ key: 'text', label: i18n.t('projectAgent.drawer.memory.edit'), multiline: true }]}
                      read={async () => {
                        const result = await clientApi.projectMemoryList({ workspaceId, ids: [item.id] });
                        const current = result.items?.find(row => row.id === item.id);
                        if (!result.ok || !current || current.status !== 'active') throw Error('MEMORY_UNAVAILABLE');
                        return { text: current.text };
                      }}
                      write={async draft => {
                        const result = await clientApi.projectMemoryEdit({ workspaceId, id: item.id, text: draft.text });
                        if (!result.ok || !result.item) throw Error(result.code);
                        void reload(); return { text: result.item.text };
                      }} onClose={closeEditor} onSaved={() => { if (editingRef.current === item.id) closeEditor(); }} />
                  ) : (
                    <p>{item.text}</p>
                  )}
                  <details className="bot-memory-provenance"><summary><PeerIcon name="chevronRight" size={12} />{i18n.t('projectAgent.drawer.memory.details')}</summary>
                    <p>{memoryLabel(i18n, item.trust, TRUSTS)}</p>
                    {item.sourceRefs?.length ? <p className="bot-drawer-note">{i18n.t('projectAgent.drawer.memory.sources')}: <code>{item.sourceRefs.join(' · ')}</code></p> : null}
                  </details>
                  <ResourceFeedback i18n={i18n} action={actions.get(item.id)} onReload={reload} />
                  <div className="bot-memory-item-actions" aria-busy={actions.get(item.id).pending}>
                    {item.status === 'conflicted' ? <button type="button" disabled={locked || actions.get(item.id).pending || editingId === item.id} onClick={() => {
                      void command(item.id, () => clientApi.projectMemoryRestore({ workspaceId, id: item.id, resolveConflict: true }));
                    }}>{i18n.t('projectAgent.drawer.memory.keepThis')}</button> : null}
                    {item.status === 'active' ? (
                      <button
                        type="button" disabled={locked || actions.get(item.id).pending || editingId === item.id}
                        onClick={() => {
                          void command(item.id, () => clientApi.projectMemoryPin({
                            workspaceId,
                            id: item.id,
                            pinned: item.pinned !== true,
                          }));
                        }}
                      >
                        {i18n.t(item.pinned ? 'projectAgent.drawer.memory.unpin' : 'projectAgent.drawer.memory.pin')}
                      </button>
                    ) : null}
                    {item.status === 'forgotten' ? (
                      <button
                        type="button" disabled={locked || actions.get(item.id).pending || editingId === item.id}
                        onClick={() => {
                          void command(item.id, () => clientApi.projectMemoryRestore({ workspaceId, id: item.id }));
                        }}
                      >
                        {i18n.t('projectAgent.drawer.memory.restore')}
                      </button>
                    ) : (
                      <button
                        type="button" disabled={locked || actions.get(item.id).pending || editingId === item.id}
                        onClick={() => {
                          void command(item.id, () => clientApi.projectMemoryForget({ workspaceId, id: item.id }));
                        }}
                      >
                        {i18n.t('projectAgent.drawer.memory.revoke')}
                      </button>
                    )}
                    {item.status === 'active' ? (
                      <button
                        type="button" disabled={locked || actions.get(item.id).pending || editingId === item.id}
                        onClick={event => {
                          editorTrigger.current = event.currentTarget; setEditingId(item.id);
                        }}
                      >
                        {i18n.t('projectAgent.drawer.memory.edit')}
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            {page.total > 0 ? <div className="bot-memory-pages" role="group" aria-label={i18n.t('projectAgent.drawer.memory.saved')}>
              <button type="button" disabled={page.page === 0} onClick={() => setPageState({ scope: pageScope, index: page.page - 1 })}>
                {i18n.t('projectAgent.drawer.memory.previous')}
              </button>
              <span role="status">{i18n.t('projectAgent.drawer.memory.page', { start: page.start, end: page.end, total: page.total })}</span>
              <button type="button" disabled={page.page + 1 >= page.pages} onClick={() => setPageState({ scope: pageScope, index: page.page + 1 })}>
                {i18n.t('projectAgent.drawer.memory.next')}
              </button>
            </div> : null}
            <div className="bot-memory-export-actions">
              <button type="button" disabled={locked || actions.get('export').pending} onClick={() => { void exportMemory('json'); }}>
                {i18n.t('projectAgent.drawer.memory.exportJson')}
              </button>
              <button type="button" disabled={locked || actions.get('export').pending} onClick={() => { void exportMemory('markdown'); }}>
                {i18n.t('projectAgent.drawer.memory.exportMarkdown')}
              </button>
            </div>
          </>
        ) : null}
      </section>
      <ResourceFeedback i18n={i18n} action={actions.get('export')} onReload={reload} />
      {exported ? <div><p>{i18n.t('resources.exported')}: <code>{exported}</code></p>
        <button type="button" className="ui-button" disabled={actions.get('openExport').pending} onClick={() => void actions.run('openExport', async () => {
          const result = await clientApi.openPath(exported, undefined, { mode: 'reveal' }); if (!result.ok) throw Error('OPEN_FAILED');
        })}>{i18n.t('resources.openFile')}</button><ResourceFeedback i18n={i18n} action={actions.get('openExport')} /></div> : null}
      <ResourceFeedback i18n={i18n} action={actions.get('switches')} onReload={reload} />
      <details className="bot-memory-controls">
        <summary><PeerIcon name="chevronRight" size={13} />{i18n.t('projectAgent.drawer.memory.controls')}</summary>
        <div className="bot-memory-settings-card" hidden={!switches}>
          <div className="bot-memory-setting-group">
            <span className="bot-memory-setting-scope">{i18n.t('projectAgent.drawer.memory.scope.project')}</span>
            <div className="bot-memory-setting-row">
              <span>{i18n.t('projectAgent.drawer.memory.projectSwitch')}</span>
              <Switch
                disabled={locked || actions.get('switches').pending}
                checked={switches?.memoryEnabled ?? false}
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
                disabled={locked || actions.get('switches').pending}
                checked={switches?.useMemory ?? false}
                aria-label={i18n.t('projectAgent.drawer.memory.useMemory')}
                onCheckedChange={(checked) => updateSwitch({ useMemory: checked })}
              />
            </div>
            <div className="bot-memory-setting-row">
              <span>{i18n.t('projectAgent.drawer.memory.learnPreferences')}</span>
              <Switch
                disabled={locked || actions.get('switches').pending}
                checked={switches?.learnPreferences ?? false}
                aria-label={i18n.t('projectAgent.drawer.memory.learnPreferences')}
                onCheckedChange={(checked) => updateSwitch({ learnPreferences: checked })}
              />
            </div>
            <p className="bot-drawer-note">{i18n.t('projectAgent.drawer.memory.learnLater')}</p>
          </div>
        </div>
      </details>
    </div>
  );
}
