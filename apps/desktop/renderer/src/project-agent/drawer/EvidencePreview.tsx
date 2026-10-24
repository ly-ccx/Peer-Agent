import { useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { Drawer } from '../../app/components/Drawer';
import { EvidenceList } from '../conversation/EvidenceList';
import { EvidenceView } from './EvidenceView';

/** Reference-only navigation; bodies are read through the existing Evidence inspection boundary. */
export function EvidencePreview({ refs, i18n }: { readonly refs: readonly string[]; readonly i18n: I18nRuntime }) {
  const [selected, setSelected] = useState<string | null>(null);
  if (!refs.length) return null;
  return <>
    <EvidenceList refs={refs} i18n={i18n} onOpen={setSelected} />
    {selected ? <Drawer ariaLabel={i18n.t('resources.evidence')} onClose={() => setSelected(null)} panelClassName="bot-evidence-preview">
      {({ requestClose }) => <>
      <button type="button" className="ui-button" onClick={requestClose}>{i18n.t('resources.close')}</button>
      <EvidenceView key={selected} evidence={{ evidenceRef: selected }} i18n={i18n} />
      </>}
    </Drawer> : null}
  </>;
}
