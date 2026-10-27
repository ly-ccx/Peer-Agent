import { returnBrowserSource } from './nativeBrowserPresentation';
import { useEffect, useRef, useState } from 'react';
import type { BrowserWindowReturnRequest, BrowserWindowReturnAck } from '@peer-agent/protocol';
import type { BrowserSessionState } from './browserSessionState';
/** Explicit native return only. A closed source tab returns to the conversation without recreating it. */
export function useBrowserWindowReturn({ conversationId, active, open, activeTab, session, setSession, setOpen, setActiveTab, setMaximized }: {
  readonly conversationId: string | null; readonly active: boolean; readonly open: boolean; readonly activeTab: string;
  readonly session: BrowserSessionState; readonly setSession: (update: (current: BrowserSessionState) => BrowserSessionState) => void;
  readonly setOpen: (open: boolean) => void; readonly setActiveTab: (tab: 'browser') => void; readonly setMaximized: (value: boolean) => void;
}) {
  const [request, setRequest] = useState<BrowserWindowReturnRequest | null>(null);
  const [status, setStatus] = useState<BrowserWindowReturnAck['status'] | null>(null);
  const pending = useRef<BrowserWindowReturnRequest | null>(null), applied = useRef('');
  const ack = (r: BrowserWindowReturnRequest, status: BrowserWindowReturnAck['status']) => {
    void window.peerAgent?.browserWindowAcknowledgeReturn?.({ requestId: r.requestId, identity: r.identity, status }).catch(() => {});
  };
  useEffect(() => {
    const stop = window.peerAgent?.onBrowserWindowReturn?.(r => {
      if (!r?.requestId || !r.identity || !Number.isFinite(r.expiresAt) || r.expiresAt <= Date.now()) return;
      // Only the matching visible scene can own this return. Other providers must not cancel it.
      setRequest(r); setStatus(null);
    });
    return () => { stop?.(); if (pending.current) ack(pending.current, 'cancelled'); pending.current = null; };
  }, []);
  useEffect(() => {
    if (!request || request.conversationId !== conversationId || !active || request.expiresAt <= Date.now() || applied.current === request.requestId) return;
    if (pending.current) ack(pending.current, 'cancelled');
    pending.current = request; applied.current = request.requestId; setMaximized(false);
    if (returnBrowserSource(session, request.browserTabId).status === 'returned') { setSession(s => returnBrowserSource(s, request.browserTabId).session); setActiveTab('browser'); setOpen(true); setStatus('returned'); }
    else { setOpen(false); setStatus('source_tab_closed'); }
  }, [request, conversationId, active, session.tabs, setSession, setActiveTab, setOpen, setMaximized]);
  useEffect(() => {
    if (!request || !status || !active || request.conversationId !== conversationId || pending.current?.requestId !== request.requestId) return;
    if (request.expiresAt <= Date.now()) { ack(request, 'cancelled'); pending.current = null; return; }
    if (status === 'returned' ? open && activeTab === 'browser' && session.activeTabId === request.browserTabId : !open) {
      ack(request, status); pending.current = null; setRequest(null); setStatus(null);
    }
  }, [request, status, open, activeTab, session.activeTabId, active, conversationId]);
  useEffect(() => {
    if (!request) return;
    const timer = setTimeout(() => {
      if (pending.current?.requestId === request.requestId) { ack(request, 'cancelled'); pending.current = null; }
      setRequest(current => current?.requestId === request.requestId ? null : current);
    }, Math.max(0, request.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [request]);
}
