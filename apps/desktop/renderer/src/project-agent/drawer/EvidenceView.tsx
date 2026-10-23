import type { I18nRuntime } from '@peer-agent/i18n';
import { clientApi } from '../../clientApi';
import { useResourceRead } from '../../ui/resources/useResourceState';
import { ResourceFeedback } from '../../ui/resources/ResourceFeedback';
import type { EvidenceSourceDescription } from '@peer-agent/protocol';
import { PeerIcon } from '../../ui/icons';
import { toolPresentation, type BotEvidenceInspect } from './agentProcess';

export function evidenceLabel(source: EvidenceSourceDescription | undefined, i18n: I18nRuntime) {
  const key = source?.toolName ? toolPresentation(source.toolName).labelKey : 'projectAgent.evidence.record';
  return i18n.t(key === 'projectAgent.process.tool' ? 'projectAgent.evidence.record' : key);
}

export function evidenceTime(value: string | undefined, i18n: I18nRuntime) {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  return new Intl.DateTimeFormat(i18n.locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

/** Historical content and source metadata have separate, honest empty states. */
export function EvidenceView({ evidence: target, i18n }: { readonly evidence: Pick<BotEvidenceInspect, 'evidenceRef'>; readonly i18n: I18nRuntime }) {
  const resource = useResourceRead(target.evidenceRef, async () => {
    const result = await clientApi.projectAgentReadEvidence({ evidenceRef: target.evidenceRef });
    if (!result || (!result.ok && (!result.availability || result.availability === 'unavailable'))) throw Error('READ_FAILED');
    return result;
  });
  const evidence = resource.value ?? { ok: false, availability: 'unavailable' as const, summary: '', source: undefined, kind: undefined, truncated: false, code: '' };
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
    {resource.loaded && evidence.ok ? <>
      <p className="bot-evidence-help">{i18n.t('projectAgent.evidence.historical')}</p>
      <div className="bot-evidence-content">{content || i18n.t('projectAgent.evidence.emptyOutput')}</div>
    </> : resource.loaded ? <div className="bot-evidence-empty"><PeerIcon name="info" size={18} />
      <div><h4>{i18n.t(message)}</h4><p>{i18n.t(state === 'unavailable' ? 'projectAgent.evidence.tryLater' : 'projectAgent.evidence.cannotVerify')}</p></div></div> : null}
    {resource.loaded && !evidence.ok && !resource.error ? <button type="button" className="ui-button" disabled={resource.loading} onClick={() => void resource.reload()}>{i18n.t('resources.retryRead')}</button> : null}
    {evidence.truncated ? <p className="bot-evidence-help">{i18n.t('projectAgent.process.truncated')}</p> : null}
    <details className="bot-inspect-technical"><summary><PeerIcon name="chevronRight" size={12} />{i18n.t('projectAgent.process.technical')}</summary>
      <code>{target.evidenceRef}</code>{evidence.code ? <p>{evidence.code}</p> : null}
    </details>
  </section>;
}
