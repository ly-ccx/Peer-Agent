import { useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { SessionCompletionReview } from '@peer-agent/protocol';
import { Drawer } from '../../app/components/Drawer';
import { MarkdownMessage } from '../../chat/components/markdown/MarkdownMessage';
import { PeerIcon } from '../../ui/icons';
import '../styles/bot-completion-review.css';

export function CompletionReview({ title, review, i18n }: {
  readonly title: string; readonly review: SessionCompletionReview; readonly i18n: I18nRuntime;
}) {
  const [open, setOpen] = useState(false);
  const hint = i18n.t(review.confirmed ? 'projectAgent.chat.completionRetryHint' : 'projectAgent.chat.completionHint');
  return <>
    <p className="bot-completion-title">{title}</p>
    <p className="bot-completion-hint">{hint}</p>
    <ul className="bot-completion-criteria">{review.criteria.map(criterion => <li key={criterion.id}>{criterion.description}</li>)}</ul>
    <button type="button" className="bot-completion-open" onClick={() => setOpen(true)}>
      {i18n.t('projectAgent.chat.reviewReport')}<PeerIcon name="arrowUpRight" size={13} />
    </button>
    {open ? <Drawer onClose={() => setOpen(false)} ariaLabel={i18n.t('projectAgent.chat.reviewReport')} panelClassName="bot-completion-drawer">
      {({ requestClose }) => <>
        <header><h2>{title}</h2><button type="button" aria-label={i18n.t('projectAgent.drawer.close')} onClick={requestClose}><PeerIcon name="close" size={16} /></button></header>
        <div className="bot-completion-report"><p className="bot-completion-hint">{hint}</p><MarkdownMessage content={review.report} /></div>
      </>}
    </Drawer> : null}
  </>;
}
