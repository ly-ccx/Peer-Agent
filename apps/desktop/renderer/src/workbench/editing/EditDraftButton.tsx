import { useEffect, useRef, useState } from 'react';
import type { ResourceEditSource } from '@peer-agent/protocol';
import { validResourceEditText } from '@peer-agent/protocol';
import { PeerIcon } from '../../ui/icons';
import { resourceEditRegistry } from './resourceEditRegistry';
import { resourceEditMessage } from './resourceEditMessages';
import type { ResourceEditSession } from './resourceEditSession';
export function EditDraftButton({ source, text, active, isZh, onOpen }: {
  readonly source: ResourceEditSource | null; readonly text?: string; readonly active: boolean; readonly isZh: boolean;
  readonly onOpen: (session: ResourceEditSession) => void;
}) {
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const latest = useRef({ source, active, onOpen }); latest.current = { source, active, onOpen };
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const registry = resourceEditRegistry();
  if (!source || !registry || !validResourceEditText(text)) return null;
  return <><button type="button" className="ui-button is-compact resource-window-open" disabled={!active} aria-disabled={pending || !active} aria-busy={pending} onClick={async event => {
    if (busy.current) return; busy.current = true; setPending(true); setError(null);
    // Disabling the focused button would blur it and falsely look like a new user intent.
    const fingerprint = JSON.stringify(source), button = event.currentTarget;
    const session = await registry.openSource(source);
    busy.current = false;
    const stillHere = alive.current && latest.current.active && JSON.stringify(latest.current.source) === fingerprint;
    if (alive.current) setPending(false);
    if (!stillHere) { if (session && !registry.list().some(entry => entry.session === session && entry.uses > 0)) void session.close(); return; }
    if (!session) { setError(resourceEditMessage(registry.error() ?? 'RESOURCE_EDIT_SOURCE_UNAVAILABLE', isZh)); return; }
    // Opening the draft is the explicit navigation intent. A later host response must not take focus from a different action.
    if (document.activeElement !== button) { if (!registry.list().some(entry => entry.session === session && entry.uses > 0)) void session.close(); return; }
    latest.current.onOpen(session);
    void session.claim(false);
  }}><PeerIcon name="fileText" size={14} />{pending ? (isZh ? '打开草稿中…' : 'Opening draft…') : (isZh ? '编辑草稿' : 'Edit draft')}</button>
  {error ? <span className="resource-source-label" role="alert">{error}</span> : null}</>;
}
