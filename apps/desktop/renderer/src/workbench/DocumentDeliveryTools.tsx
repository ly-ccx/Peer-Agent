import type { BotDocumentReference, EvidenceDeliveryBinding } from '@peer-agent/protocol';
import { MotionDetails } from '../app/components/MotionDetails';
import { clientApi } from '../clientApi';
import { useResourceRead } from '../ui/resources/useResourceState';
import { PeerIcon } from '../ui/icons';
import { confirmedDelivery } from './deliveryBindingState';
import { DeliveryHistory } from './DeliveryHistory';

export function DocumentDeliveryTools({ binding, reference, active, isZh }: {
  readonly binding: EvidenceDeliveryBinding; readonly reference: BotDocumentReference; readonly active: boolean; readonly isZh: boolean;
}) {
  const context = { workspaceId: reference.workspaceId, ...(reference.task ? { task: reference.task } : {}) };
  const resource = useResourceRead(JSON.stringify([context, binding]), () => clientApi.projectAgentReadEvidence({ evidenceRef: binding.evidenceRef, context }), active);
  const delivery = resource.error ? undefined : confirmedDelivery(resource.value, binding, reference);
  const at = resource.value?.source?.createdAt;
  return <MotionDetails className="resource-document-history resource-delivery-tools">
    <summary><PeerIcon name="chevronRight" size={12} />{isZh ? '关联的交付记录' : 'Linked delivery record'}</summary>
    {!resource.loaded && !resource.error ? <p role="status">{isZh ? '正在核对交付来源…' : 'Checking the delivery source…'}</p> : null}
    {delivery ? <><h3>{delivery.label}</h3>
      {at && Number.isFinite(Date.parse(at)) ? <time className="resource-source-label" dateTime={at}>{new Date(at).toLocaleString(isZh ? 'zh-CN' : 'en-US')}</time> : null}
      <DeliveryHistory delivery={delivery} isZh={isZh} />
      {resource.value?.summary ? <><p className="resource-source-label">{isZh ? '关联证据摘要' : 'Related evidence summary'}</p><pre>{resource.value.summary}</pre></> : null}
    </> : resource.loaded || resource.error ? <p role="status">{isZh ? '交付关联未确认。当前文件保留，未使用它补齐历史内容。' : 'The delivery association is unconfirmed. The current file is preserved and does not fill missing history.'}</p> : null}
    <button type="button" className="ui-button is-compact" disabled={resource.loading} onClick={() => void resource.reload()}>{isZh ? '重新核对关联' : 'Recheck association'}</button>
  </MotionDetails>;
}
