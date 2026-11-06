import { useLayoutEffect, useRef, useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { useResourceWorkspace } from '../../workbench/ResourceWorkspaceContext';
import { PeerIcon } from '../../ui/icons';
import { Drawer } from '../../app/components/Drawer';
import { EvidenceList } from '../conversation/EvidenceList';
import { EvidenceView } from './EvidenceView';
import type { BotDocumentReference } from '@peer-agent/protocol';

/** Reference-only navigation; bodies are read through the existing Evidence inspection boundary. */
export function EvidencePreview({ refs, i18n, inline: requestedInline, workspaceId, task }: { readonly refs: readonly string[]; readonly i18n: I18nRuntime; readonly inline?: boolean; readonly workspaceId?: string; readonly task?: BotDocumentReference['task'] }) {
  const workspace = useResourceWorkspace();
  const inline = requestedInline ?? !!workspace;
  const [selected, setSelected] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null), triggerRef = useRef<HTMLElement | null>(null);
  const previous = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!inline) return;
    if (selected) closeRef.current?.focus({ preventScroll: true });
    else if (previous.current && triggerRef.current?.isConnected) triggerRef.current.focus({ preventScroll: true });
    previous.current = selected;
  }, [inline, selected]);
  if (!refs.length) return null;
  if (inline) return <div className="bot-inline-evidence">
    <div hidden={!!selected} inert={!!selected}><EvidenceList refs={refs} i18n={i18n} onOpen={ref => {
      triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setSelected(ref);
    }} /></div>
    {selected ? <section aria-label={i18n.t('resources.evidence')}>
      <button ref={closeRef} type="button" className="ui-button" onClick={() => setSelected(null)}><PeerIcon name="back" size={14} />{i18n.t('projectAgent.drawer.back')}</button>
      <EvidenceView key={selected} evidence={{ evidenceRef: selected }} i18n={i18n} workspaceId={workspaceId} task={task} />
    </section> : null}
  </div>;
  return <>
    <EvidenceList refs={refs} i18n={i18n} onOpen={setSelected} />
    {selected ? <Drawer ariaLabel={i18n.t('resources.evidence')} onClose={() => setSelected(null)} panelClassName="bot-evidence-preview">
      {({ requestClose }) => <>
      <button type="button" className="ui-button" onClick={requestClose}>{i18n.t('resources.close')}</button>
      <EvidenceView key={selected} evidence={{ evidenceRef: selected }} i18n={i18n} workspaceId={workspaceId} task={task} />
      </>}
    </Drawer> : null}
  </>;
}
