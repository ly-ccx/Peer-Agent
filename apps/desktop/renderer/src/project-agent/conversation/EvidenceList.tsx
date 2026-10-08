import { useEffect, useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { EvidenceSourceDescription } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';
import { PeerIcon } from '../../ui/icons';
import { evidenceLabel, evidenceTime } from '../drawer/EvidenceView';

export function EvidenceList({ refs, i18n, onOpen }: {
  readonly refs: readonly string[]; readonly i18n: I18nRuntime; readonly onOpen?: (ref: string) => void;
}) {
  const [sources, setSources] = useState<readonly EvidenceSourceDescription[]>([]);
  const key = JSON.stringify(refs.slice(0, 100));
  useEffect(() => {
    let current = true;
    setSources([]);
    void clientApi.projectAgentReadEvidence({ evidenceRefs: JSON.parse(key) as string[] }).then(result => {
      if (current && result.ok) setSources(result.items ?? []);
    }).catch(() => {});
    return () => { current = false; };
  }, [key]);
  const byRef = new Map(sources.map(source => [source.evidenceRef, source]));
  return <section aria-label={i18n.t('projectAgent.evidence.title')}>
    <h3>{i18n.t('projectAgent.evidence.title')}</h3>
    <p className="bot-evidence-help">{i18n.t('projectAgent.evidence.listHelp')}</p>
    <ol className="bot-evidence-list">{refs.map((ref, index) => {
      const source = byRef.get(ref), at = evidenceTime(source?.createdAt, i18n);
      return <li key={ref}><button type="button" onClick={() => onOpen?.(ref)}>
        <PeerIcon name="fileText" size={14} /><span><strong>{evidenceLabel(source, i18n)}</strong>
          <small>{at || `${i18n.t('projectAgent.evidence.record')} ${index + 1}`}</small></span><PeerIcon name="arrowUpRight" size={12} />
      </button></li>;
    })}</ol>
  </section>;
}
