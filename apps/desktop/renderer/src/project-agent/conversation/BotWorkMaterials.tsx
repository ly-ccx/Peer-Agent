import { useRef, useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { Overlay } from '../../app/components/Overlay';
import { PeerIcon } from '../../ui/icons';
import { useResourceWorkspace } from '../../workbench/ResourceWorkspaceContext';
import type { BotWorkMaterial } from '../state/botWorkPanelState';

export function BotWorkMaterials({ materials, i18n, onOpenTask }: {
  readonly materials: readonly BotWorkMaterial[];
  readonly i18n: I18nRuntime;
  readonly onOpenTask: (sessionId: string) => void;
}) {
  const workspace = useResourceWorkspace();
  const [preview, setPreview] = useState<BotWorkMaterial | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const canOpen = (material: BotWorkMaterial) => Boolean(material.reference && workspace?.ready
    && workspace.owner?.workspaceId === material.reference.workspaceId);
  const open = (material: BotWorkMaterial, element: HTMLButtonElement) => {
    trigger.current = element;
    if (material.reference && !material.preview && canOpen(material)) workspace!.openReference(material.reference);
    else setPreview(material);
  };
  return <>
    <ul className="bot-work-panel-materials">
      {materials.map(material => <li key={material.id}><button type="button" className="bot-work-panel-material"
        title={material.reference?.path ?? material.label}
        onClick={event => open(material, event.currentTarget)}>
        {material.preview?.kind === 'image' ? <img className="bot-work-panel-thumbnail" src={material.preview.dataUrl} alt="" loading="lazy" />
          : <span className="bot-work-panel-material-icon"><PeerIcon name={material.kind === 'image' ? 'image' : material.kind === 'code' ? 'terminal' : 'fileText'} size={18} /></span>}
        <span className="bot-work-panel-material-copy"><strong>{material.label}</strong>
          <span>{i18n.t(`projectAgent.workPanel.${material.kind}`)} · {i18n.t(`projectAgent.workPanel.${material.source}`)}</span>
          {material.sourceLabel ? <span>{material.sourceLabel}</span> : null}
        </span><PeerIcon name="chevronRight" size={12} />
      </button></li>)}
    </ul>
    {preview ? <Overlay ariaLabel={preview.label} panelClassName="bot-work-material-preview" restoreFocusRef={trigger} onClose={() => setPreview(null)}>
      {({ requestClose }) => <>
        <header><h2>{preview.label}</h2><button type="button" className="ui-button is-icon" aria-label={i18n.t('resources.close')} onClick={requestClose}><PeerIcon name="close" size={16} /></button></header>
        {preview.sourceLabel ? <p>{i18n.t('projectAgent.workPanel.source', { name: preview.sourceLabel })}</p> : null}
        {preview.preview?.kind === 'image' ? <img src={preview.preview.dataUrl} alt={preview.label} />
          : preview.preview?.kind === 'code' ? <pre tabIndex={0}>{preview.preview.diffLines.join('\n')}</pre>
          : <p role="status">{i18n.t(preview.reference && !canOpen(preview) ? 'projectAgent.workPanel.scopeUnavailable' : 'projectAgent.workPanel.previewMissing')}</p>}
        <p>{i18n.t('resources.previewOnly')}</p>
        {preview.reference && canOpen(preview) ? <button type="button" className="ui-button" onClick={() => { workspace!.openReference(preview.reference!); setPreview(null); }}>{i18n.t('projectAgent.workPanel.currentFile')}</button> : null}
        {preview.sessionId ? <button type="button" className="ui-button" onClick={() => { onOpenTask(preview.sessionId!); setPreview(null); }}>{i18n.t('projectAgent.workPanel.sourceTask')}</button> : null}
      </>}
    </Overlay> : null}
  </>;
}
