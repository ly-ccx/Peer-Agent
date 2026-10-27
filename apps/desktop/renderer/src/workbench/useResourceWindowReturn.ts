import { useEffect, useRef, useState } from 'react';
import type { BotDocumentReference, ResourceWindowReturnRequest, ResourceWindowReturnAck } from '@peer-agent/protocol';
import type { useWorkbench } from './WorkbenchContext';
import { returnDocumentSession, seedSourceDirectory } from './resourceWindowReturnState';

/** Two-way presentation handoff; only the captured main window may acknowledge the request. */
export function useResourceWindowReturn({ owner, ready, active, workbench, reveal, openDirectory }: {
  readonly owner: { readonly workspaceId: string; readonly conversationId: string | null } | null; readonly ready: boolean; readonly active: boolean;
  readonly workbench: ReturnType<typeof useWorkbench>; readonly reveal: () => void; readonly openDirectory: (reference: BotDocumentReference) => void;
}) {
  const [request, setRequest] = useState<ResourceWindowReturnRequest | null>(null);
  const [receipt, setReceipt] = useState<(ResourceWindowReturnAck & { targetId?: string | null }) | null>(null);
  const pending = useRef<ResourceWindowReturnRequest | null>(null), applied = useRef('');
  const acknowledge = (request: ResourceWindowReturnRequest, status: ResourceWindowReturnAck['status']) => {
    void window.peerAgent?.resourceWindowAcknowledgeReturn?.({ requestId: request.requestId, identity: request.context, status }).catch(() => {});
  };
  useEffect(() => {
    const unsubscribe = window.peerAgent?.onResourceWindowReturn?.(next => {
      if (!next?.context || !next.requestId || !Number.isFinite(next.expiresAt) || next.expiresAt <= Date.now()) return;
      if (pending.current) acknowledge(pending.current, 'cancelled');
      pending.current = next; setRequest(next);
    });
    return () => { unsubscribe?.(); if (pending.current) acknowledge(pending.current, 'cancelled'); pending.current = null; };
  }, []);
  useEffect(() => {
    if (!request) return;
    const timer = setTimeout(() => {
      if (pending.current?.requestId === request.requestId) { acknowledge(request, 'cancelled'); pending.current = null; setRequest(null); setReceipt(null); }
    }, Math.max(0, request.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [request]);
  useEffect(() => {
    if (!request || applied.current === request.requestId || request.expiresAt <= Date.now() || !ready || !active || !owner
      || request.context.owner.workspaceId !== owner?.workspaceId || request.context.owner.conversationId !== owner?.conversationId) return;
    applied.current = request.requestId;
    const context = request.context, resource = context.resource;
    workbench.setMaximized(false);
    let status: ResourceWindowReturnAck['status'] = 'returned', targetId: string | null = null;
    if (resource.kind === 'directory') {
      workbench.setDirectorySession(owner.workspaceId, current => seedSourceDirectory(current, context));
      openDirectory(resource.reference);
    } else {
      const target = returnDocumentSession(workbench.documentSession, context); status = target.status; targetId = target.session.activeTabId;
      if (target.status === 'source_tab_closed') workbench.setOpen(false);
      else { workbench.setDocumentSession(target.session); workbench.setActiveTab('documents'); reveal(); }
    }
    setReceipt({ requestId: request.requestId, identity: context, status, targetId });
  }, [request, ready, active, owner?.workspaceId, owner?.conversationId]);
  useEffect(() => {
    if (!receipt || !request || pending.current?.requestId !== receipt.requestId || request.expiresAt <= Date.now()) return;
    const applied = receipt.status === 'source_tab_closed' ? !workbench.open : workbench.open
      && (request.context.resource.kind === 'directory' ? workbench.activeTab === 'files' && workbench.directorySessions[request.context.owner.workspaceId]?.source === request.context.resource.reference.path
        : workbench.activeTab === 'documents' && workbench.documentSession.activeTabId === receipt.targetId);
    if (!applied) return;
    acknowledge(request, receipt.status); pending.current = null; setRequest(null); setReceipt(null);
  }, [receipt, request, workbench.open, workbench.activeTab, workbench.documentSession.activeTabId, workbench.directorySessions]);
}
