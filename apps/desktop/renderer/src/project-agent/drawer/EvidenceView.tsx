import { MotionDetails } from '../../app/components/MotionDetails';
import type { I18nRuntime } from '@peer-agent/i18n';
import { clientApi } from '../../clientApi';
import { useResourceRead } from '../../ui/resources/useResourceState';
import { ResourceFeedback } from '../../ui/resources/ResourceFeedback';
import type { EvidenceSourceDescription } from '@peer-agent/protocol';
import { PeerIcon } from '../../ui/icons';
import { toolPresentation, type BotEvidenceInspect } from './agentProcess';
import type { BotDocumentReference, ProjectAgentEvidenceReadResult } from '@peer-agent/protocol';
import { useResourceWorkspace } from '../../workbench/ResourceWorkspaceContext';
import { EvidenceDeliveries } from './EvidenceDeliveries';

export function evidenceLabel(source: EvidenceSourceDescription | undefined, i18n: I18nRuntime) {
  const key = source?.toolName ? toolPresentation(source.toolName).labelKey : 'projectAgent.evidence.record';
  return i18n.t(key === 'projectAgent.process.tool' ? 'projectAgent.evidence.record' : key);
}

export function evidenceTime(value: string | undefined, i18n: I18nRuntime) {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  return new Intl.DateTimeFormat(i18n.locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

/** Historical content and source metadata have separate, honest empty states. */
export function EvidenceView({ evidence: target, i18n, workspaceId: requestedOwner, task }: { readonly evidence: Pick<BotEvidenceInspect, 'evidenceRef'>; readonly i18n: I18nRuntime; readonly workspaceId?: string; readonly task?: BotDocumentReference['task'] }) {
  const workspace = useResourceWorkspace(), workspaceId = requestedOwner ?? workspace?.owner?.workspaceId;
  const context = workspaceId ? { workspaceId, ...(task ? { task } : {}) } : undefined;
  const resource = useResourceRead(JSON.stringify([target.evidenceRef, context]), async () => {
    const result = await clientApi.projectAgentReadEvidence({ evidenceRef: target.evidenceRef, ...(context ? { context } : {}) });
    if (!result || (!result.ok && !result.availability)) throw Error('READ_FAILED');
    return result;
  });
  const evidence: ProjectAgentEvidenceReadResult = resource.value ?? { ok: false, availability: 'unavailable', summary: '', truncated: false, code: '' };
  const label = evidenceLabel(evidence.source, i18n);
  const at = evidenceTime(evidence.source?.createdAt, i18n);
  const state = evidence.availability ?? (evidence.ok ? 'available' : 'unavailable');
  const message = state === 'metadata_only' ? 'projectAgent.evidence.bodyMissing'
    : state === 'not_found' ? 'projectAgent.evidence.notFound' : 'projectAgent.evidence.readFailed';
  let content = evidence.summary ?? '';
  if (evidence.kind === 'command') {
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed.stdout === 'string') content = [parsed.stdout, parsed.stderr].filter(Boolean).join('\n');
    } catch { /* Plain text snapshots remain readable. */ }
  }
  return <section className="bot-inspect bot-evidence-view" aria-label={label} data-availability={state}>
    <div className="bot-evidence-heading"><PeerIcon name={evidence.source?.toolName ? toolPresentation(evidence.source.toolName).icon : 'fileText'} size={18} />
      <h3>{label}</h3></div>
    {at ? <time className="bot-evidence-time" dateTime={evidence.source?.createdAt}>{at}</time> : null}
    <ResourceFeedback i18n={i18n} loading={resource.loading} error={resource.error} onReload={resource.reload} />
    {context && resource.loaded && evidence.deliveryStatus === undefined ? <p role="status" className="bot-evidence-help">{i18n.locale.startsWith('zh') ? '交付关联尚未确认。' : 'The delivery association has not been confirmed.'}</p> : null}
    {evidence.deliveryStatus === 'scope_denied' ? <p role="alert">{i18n.locale.startsWith('zh') ? '此证据不属于当前机器人或任务。' : 'This evidence does not belong to the current Bot or task.'}</p> : null}
    {evidence.deliveryStatus === 'available' && evidence.deliveries?.length ? <EvidenceDeliveries deliveries={evidence.deliveries} isZh={i18n.locale.startsWith('zh')} /> : null}
    {resource.loaded && evidence.ok ? <>
      <p className="bot-evidence-help">{i18n.t('projectAgent.evidence.historical')}</p>
      <div className="bot-evidence-content">{content || i18n.t('projectAgent.evidence.emptyOutput')}</div>
    </> : resource.loaded ? <div className="bot-evidence-empty"><PeerIcon name="info" size={18} />
      <div><h4>{i18n.t(message)}</h4><p>{i18n.t(state === 'unavailable' ? 'projectAgent.evidence.tryLater' : 'projectAgent.evidence.cannotVerify')}</p></div></div> : null}
    {resource.loaded && !evidence.ok && !resource.error ? <button type="button" className="ui-button" disabled={resource.loading} onClick={() => void resource.reload()}>{i18n.t('resources.retryRead')}</button> : null}
    {evidence.truncated ? <p className="bot-evidence-help">{i18n.t('projectAgent.process.truncated')}</p> : null}
    <MotionDetails className="bot-inspect-technical"><summary><PeerIcon name="chevronRight" size={12} />{i18n.t('projectAgent.process.technical')}</summary>
      <code>{target.evidenceRef}</code>{evidence.code ? <p>{evidence.code}</p> : null}
    </MotionDetails>
  </section>;
}
