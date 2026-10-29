import { resourceEditRegistry } from './editing/resourceEditRegistry';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkbench } from './WorkbenchContext';
import { activateBrowserTab, closeBrowserTab, createBrowserTabSession } from './browserSessionState';
import { activateDocumentTab, closeDocumentTab, documentComparisonLabel } from './documentSessionState';
import { documentFileLabel } from './documentRevisionState';
import { LAUNCHER_TAB, normalizeResourcePreferences, reconcileResourceOrder, resourceKey, resourceNeighbor } from './resourceWorkspaceState';

function read(owner: string | null) {
  try { return normalizeResourcePreferences(owner ? JSON.parse(localStorage.getItem(`peer.resource-workspace.v1:${owner}`) ?? '{}') : null); }
  catch { return normalizeResourcePreferences(null); }
}

export function useResourcePresentation(enabled = true, isZh = false) {
  const workbench = useWorkbench();
  const { conversationId: owner, browserSession, documentSession, activeTab } = workbench;
  const [stored, setStored] = useState(() => ({ owner, value: read(enabled ? owner : null) }));
  let preferences = stored.value;
  if (stored.owner !== owner) {
    preferences = read(enabled ? owner : null);
    setStored({ owner, value: preferences });
  }
  const resources = useMemo(() => [
    ...documentSession.tabs.map(tab => ({ key: resourceKey('document', tab.id), kind: 'document' as const, id: tab.id,
      label: tab.comparison ? documentComparisonLabel(tab.comparison, isZh) : `${documentFileLabel(tab.absPath, tab.reference?.revision, isZh)}${tab.draftId ? (isZh ? ' · 草稿' : ' · Draft') : ''}`,
      title: [tab.comparison ? tab.comparison.comparison ? documentComparisonLabel(tab.comparison, isZh)
        : `${tab.comparison.fromRef} → ${tab.comparison.toRef ?? (isZh ? '工作树' : 'Working tree')}` : null,
        tab.reference?.revision?.commit, tab.reference?.relativeTo, tab.absPath].filter(Boolean).join('; ') })),
    ...browserSession.tabs.filter(tab => tab.url !== 'about:blank' || !!tab.title || (activeTab === 'browser' && tab.id === browserSession.activeTabId)).map(tab => ({ key: resourceKey('browser', tab.id),
      kind: 'browser' as const, id: tab.id, label: tab.title || tab.url, title: tab.url })),
    ...(activeTab === 'changes' || preferences.order.includes('comparison:workspace')
      ? [{ key: 'comparison:workspace', kind: 'comparison' as const, id: 'workspace', label: 'Diff', title: 'Diff' }] : []),
  ], [documentSession.tabs, browserSession.tabs, browserSession.activeTabId, activeTab, preferences.order, isZh]);
  const order = reconcileResourceOrder(preferences.order, resources.map(item => item.key));
  const ordered = order.flatMap(key => { const item = resources.find(item => item.key === key);
    if (!item) return [];
    return [{ ...item, label: item.kind === 'document' && resources.some(other => other.key !== item.key && other.kind === 'document' && other.label === item.label)
      ? `${item.label} · ${item.title}` : item.label }];
  });
  const active = activeTab === 'documents' ? resourceKey('document', documentSession.activeTabId ?? '')
    : activeTab === 'browser' ? resourceKey('browser', browserSession.activeTabId) : activeTab === 'changes' ? 'comparison:workspace' : activeTab === 'launcher' ? LAUNCHER_TAB : null;

  useEffect(() => {
    if (!enabled || !owner || stored.owner !== owner) return;
    const next = { ...stored.value, order };
    if (stored.value.order.join('\0') !== order.join('\0')) setStored(current => current.owner === owner ? { owner, value: { ...current.value, order } } : current);
    try { localStorage.setItem(`peer.resource-workspace.v1:${owner}`, JSON.stringify(next)); } catch { /* Navigation remains usable without storage. */ }
  }, [enabled, owner, stored, order.join('\0')]);

  const currentDocument = documentSession.tabs.find(tab => resourceKey('document', tab.id) === active);
  const currentWeb = browserSession.tabs.find(tab => resourceKey('browser', tab.id) === active);
  const visited = currentDocument && !currentDocument.draftId && (!currentDocument.reference?.revision || !!currentDocument.observation) ? JSON.stringify({ kind: currentDocument.comparison ? 'comparison' : 'document', path: currentDocument.absPath,
    relativeTo: currentDocument.reference?.relativeTo, task: currentDocument.reference?.task, comparison: currentDocument.comparison,
    ...(currentDocument.reference?.revision ? { revision: { ...currentDocument.reference.revision, repositoryId: currentDocument.observation?.sourceId } } : {}) })
    : currentWeb && currentWeb.url !== 'about:blank' ? JSON.stringify({ kind: 'browser', url: currentWeb.url }) : null;
  useEffect(() => {
    if (!enabled || !owner || !visited) return;
    setStored(current => current.owner !== owner || current.value.recent[0] === visited ? current
      : { owner, value: { ...current.value, recent: [visited, ...current.value.recent.filter(value => value !== visited)].slice(0, 16) } });
  }, [enabled, owner, visited]);

  const remember = (key: string) => {
    const doc = documentSession.tabs.find(tab => resourceKey('document', tab.id) === key);
    const web = browserSession.tabs.find(tab => resourceKey('browser', tab.id) === key);
    const descriptor = doc && !doc.draftId && (!doc.reference?.revision || !!doc.observation) ? JSON.stringify({ kind: doc.comparison ? 'comparison' : 'document', path: doc.absPath, relativeTo: doc.reference?.relativeTo, task: doc.reference?.task, comparison: doc.comparison,
      ...(doc.reference?.revision ? { revision: { ...doc.reference.revision, repositoryId: doc.observation?.sourceId } } : {}) })
      : web ? JSON.stringify({ kind: 'browser', url: web.url }) : null;
    setStored(current => {
      if (current.owner !== owner) return current;
      return { owner, value: { order: current.value.order, recent: descriptor ? [descriptor, ...current.value.recent.filter(value => value !== descriptor)].slice(0, 16) : current.value.recent } };
    });
  };
  const activate = (key: string) => {
    const item = resources.find(item => item.key === key);
    if (!item) { workbench.setActiveTab('launcher'); return; }
    if (item.kind === 'document') {
      workbench.setDocumentSession(current => activateDocumentTab(current, item.id)); workbench.setActiveTab('documents');
    } else if (item.kind === 'browser') {
      workbench.setBrowserSession(current => activateBrowserTab(current, item.id)); workbench.setActiveTab('browser');
    } else workbench.setActiveTab('changes');
    remember(key);
  };
  const latest = useRef({ owner, active, order, activate }); latest.current = { owner, active, order, activate };
  const closing = useRef(new Set<string>());
  const close = async (key: string) => {
    const item = resources.find(item => item.key === key);
    if (!item) { activate(order.at(-1) ?? LAUNCHER_TAB); return; }
    const closeKey = JSON.stringify([owner, key]); if (closing.current.has(closeKey)) return;
    closing.current.add(closeKey);
    try {
      const draft = item.kind === 'document' ? documentSession.tabs.find(tab => tab.id === item.id) : undefined;
      const registry = resourceEditRegistry();
      if (draft?.draftId && draft.reference && registry && !await registry.flushDraft(draft.reference.workspaceId, draft.draftId)) return;
      const next = resourceNeighbor(latest.current.owner === owner ? latest.current.order : order, key);
      if (item.kind === 'document') workbench.setDocumentSession(current => closeDocumentTab(current, item.id));
      else if (item.kind === 'browser') workbench.setBrowserSession(current => closeBrowserTab(current, item.id, createBrowserTabSession()));
      else setStored(current => ({ ...current, value: { ...current.value, order: current.value.order.filter(value => value !== key) } }));
      if (latest.current.owner === owner && latest.current.active === key) latest.current.activate(next);
    } finally { closing.current.delete(closeKey); }
  };
  return { resources: ordered, active, activate, close, recent: preferences.recent,
    launch: () => workbench.setActiveTab('launcher') };
}
