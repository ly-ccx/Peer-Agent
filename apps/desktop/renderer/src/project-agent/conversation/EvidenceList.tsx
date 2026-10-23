import { useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { clientApi } from '../../clientApi';
import { PeerIcon } from '../../ui/icons';
import { useResourceRead } from '../../ui/resources/useResourceState';
import { ResourceFeedback } from '../../ui/resources/ResourceFeedback';
import { evidenceLabel, evidenceTime } from '../drawer/EvidenceView';

export function EvidenceList({ refs, i18n, onOpen }: {
  readonly refs: readonly string[]; readonly i18n: I18nRuntime; readonly onOpen?: (ref: string) => void;
}) {
  const [window, setWindow] = useState({ key: '', count: 100 });
  const identity = JSON.stringify([...new Set(refs)]);
  const count = window.key === identity ? window.count : 100;
  const visible = [...new Set(refs)].slice(0, count);
  const key = JSON.stringify(visible);
  const sources = useResourceRead(key, async () => {
    const values = JSON.parse(key) as string[];
    const collected = [];
    // Source metadata is bounded to 100 references per host request.
    for (let start = 0; start < values.length; start += 100) {
      const result = await clientApi.projectAgentReadEvidence({ evidenceRefs: values.slice(start, start + 100) });
      if (!result.ok) throw Error(result.code);
      collected.push(...(result.items ?? []));
    }
    return collected;
  });
  const byRef = new Map((sources.value ?? []).map(source => [source.evidenceRef, source]));
  return <section aria-label={i18n.t('projectAgent.evidence.title')}>
    <h3>{i18n.t('projectAgent.evidence.title')}</h3>
    <p className="bot-evidence-help">{i18n.t('projectAgent.evidence.listHelp')}</p>
    <ResourceFeedback i18n={i18n} loading={sources.loading} error={sources.error} onReload={sources.reload} />
    <ol className="bot-evidence-list">{visible.map((ref, index) => {
      const source = byRef.get(ref), at = evidenceTime(source?.createdAt, i18n);
      return <li key={ref}><button type="button" disabled={!onOpen} onClick={() => onOpen?.(ref)} title={ref}>
        <PeerIcon name="fileText" size={14} /><span><strong>{evidenceLabel(source, i18n)}</strong>
          <small>{at || `${i18n.t('projectAgent.evidence.record')} ${index + 1}`}</small></span><PeerIcon name="arrowUpRight" size={12} />
      </button></li>;
    })}</ol>
    {count < new Set(refs).size ? <button type="button" className="ui-button" onClick={() => setWindow({ key: identity, count: count + 100 })}>{i18n.t('resources.more')}</button> : null}
  </section>;
}
