import type { EvidenceDelivery } from '@peer-agent/protocol';
import { MotionDetails } from '../../app/components/MotionDetails';
import { PeerIcon } from '../../ui/icons';
import { useResourceWorkspace } from '../../workbench/ResourceWorkspaceContext';
import { DeliveryHistory } from '../../workbench/DeliveryHistory';

export function EvidenceDeliveries({ deliveries, isZh }: { readonly deliveries: readonly EvidenceDelivery[]; readonly isZh: boolean }) {
  const workspace = useResourceWorkspace();
  if (!deliveries.length) return null;
  return <MotionDetails className="bot-inspect-technical resource-evidence-deliveries">
    <summary><PeerIcon name="chevronRight" size={12} />{isZh ? '本次交付' : 'Deliveries'}</summary>
    {deliveries.map(delivery => <article key={JSON.stringify([delivery.evidenceRef, delivery.artifactRef])}>
      <h4><PeerIcon name={delivery.kind === 'image' ? 'image' : 'fileText'} size={16} />{delivery.label}</h4>
      <DeliveryHistory delivery={delivery} isZh={isZh} />
      <button type="button" className="ui-button is-compact" disabled={!workspace?.ready || !delivery.reference} onClick={() => workspace?.openDelivery(delivery)}>
        {isZh ? '打开当前文件' : 'Open current file'}</button>
      {!delivery.reference ? <p className="resource-source-label">{isZh ? '未保存可核对的文件位置。' : 'No verifiable file location was saved.'}</p> : null}
    </article>)}
  </MotionDetails>;
}
