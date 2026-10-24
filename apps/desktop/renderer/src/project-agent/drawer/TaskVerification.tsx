import { MotionDetails } from '../../app/components/MotionDetails';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { SessionVerificationDetail } from '@peer-agent/protocol';
import { EvidencePreview } from './EvidencePreview';
import { PeerIcon } from '../../ui/icons';

const verdictLabels = {
  passed: 'projectAgent.chat.verdict.passed', failed: 'projectAgent.chat.verdict.failed',
  partial: 'projectAgent.chat.verdict.partial', unverifiable: 'projectAgent.chat.verdict.unverifiable',
} as const;
const checkLabels = {
  leaves: 'projectAgent.drawer.task.verificationEvidence', leaf_evidence: 'projectAgent.drawer.task.verificationEvidence',
  independent_verifier: 'projectAgent.drawer.task.verificationIndependent',
} as const;

/** Task facts stay here; the main bot owns the explanation delivered to the user. */
export function TaskVerification({ detail, i18n }: { readonly detail: SessionVerificationDetail; readonly i18n: I18nRuntime }) {
  return <section className="bot-task-verification" aria-label={i18n.t('projectAgent.drawer.task.verification')} data-outcome={detail.outcome}>
    <h3>{i18n.t('projectAgent.drawer.task.verification')}</h3>
    <p>{i18n.t(verdictLabels[detail.outcome])}</p>
    <p className="bot-task-hint">{i18n.t('projectAgent.drawer.task.verificationScope')}</p>
    <dl aria-label={i18n.t('projectAgent.drawer.task.verificationChecks')}>
      {detail.checks.map((check, index) => <div key={`${check.name}-${index}`}>
        <dt>{i18n.t(checkLabels[check.name as keyof typeof checkLabels] || 'projectAgent.drawer.task.verificationOther')}</dt>
        <dd>{i18n.t(check.reason === 'missing' ? 'projectAgent.drawer.task.verificationMissing'
          : check.result === 'passed' ? 'projectAgent.drawer.task.verificationPassed' : 'projectAgent.drawer.task.verificationFailed')}</dd>
      </div>)}
    </dl>
    <EvidencePreview refs={[...new Set(detail.checks.flatMap(check => check.evidenceRefs).concat(detail.outputs.map(output => output.evidenceRef)))]} i18n={i18n} />
    {detail.outputs.length ? <MotionDetails><summary><PeerIcon name="chevronRight" size={13} />{i18n.t('resources.outputs')}</summary>
      {detail.outputs.map((output, index) => <section key={`${output.evidenceRef}-${index}`}><h4>{output.name}</h4><p>{output.summary}</p>
        {output.truncated ? <p>{i18n.t('projectAgent.process.truncated')}</p> : null}</section>)}
    </MotionDetails> : null}
    {detail.reviewAttempts.length > 0 && <MotionDetails>
      <summary><PeerIcon name="chevronRight" size={13} />{i18n.t('projectAgent.drawer.task.verificationHistory')}</summary>
      <p className="bot-task-hint">{i18n.t('projectAgent.drawer.task.verificationHistorical')}</p>
      {detail.reviewAttempts.map(attempt => <section key={attempt.verifierRunId}>
        <p>{i18n.t(attempt.status === 'passed' ? 'projectAgent.drawer.task.verificationPassed' : attempt.status === 'failed' ? 'projectAgent.drawer.task.verificationFailed' : 'projectAgent.chat.verificationPending')}</p>
        <p>{attempt.failureReason}</p>
        {[...attempt.failedCriteria, ...attempt.missingEvidence].map((item, index) => <p key={index}>{item.reason}</p>)}
      </section>)}
    </MotionDetails>}
  </section>;
}
