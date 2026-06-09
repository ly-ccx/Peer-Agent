import { createI18n } from '@peer-agent/i18n';
import type { ClientToolCall, ClientToolResult, LocaleCode, LocalAccessLevel } from '@peer-agent/protocol';
import type { ReactNode } from 'react';

export function StatusBadge({ children, tone = 'neutral' }: { readonly children: ReactNode; readonly tone?: 'neutral' | 'good' | 'warn' }) {
  return <span className={`za-status-badge za-status-badge-${tone}`}>{children}</span>;
}

export function AccessLevelLabel({ value, locale }: { readonly value: LocalAccessLevel; readonly locale?: LocaleCode }) {
  const i18n = createI18n(locale);
  const accessKeys = {
    cloud_only: 'access.cloud_only',
    ask_before_local: 'access.ask_before_local',
    session_local: 'access.session_local',
    restricted_local: 'access.restricted_local',
    full_local: 'access.full_local',
  } as const;

  return <StatusBadge tone={value === 'ask_before_local' ? 'warn' : 'neutral'}>{i18n.t(accessKeys[value])}</StatusBadge>;
}

export function ToolCallCard({
  call,
  result,
  locale,
}: {
  readonly call: ClientToolCall;
  readonly result?: ClientToolResult;
  readonly locale?: LocaleCode;
}) {
  const i18n = createI18n(locale);

  return (
    <section className="za-card za-tool-card">
      <div className="za-card-row">
        <strong>{call.displayName}</strong>
        <StatusBadge tone={result ? 'good' : 'warn'}>{result ? result.status : i18n.t('tool.waitingReview')}</StatusBadge>
      </div>
      <p>{call.reason}</p>
      <div className="za-card-meta">
        <span>{call.capabilityId}</span>
        <span>{call.riskLevel}</span>
        <span>{call.dataLevel}</span>
      </div>
      {result ? <p className="za-muted">{result.evidence.summary}</p> : null}
    </section>
  );
}

export function ReviewCard({
  calls,
  onApprove,
  onReject,
  locale,
}: {
  readonly calls: readonly ClientToolCall[];
  readonly onApprove: () => void;
  readonly onReject?: () => void;
  readonly locale?: LocaleCode;
}) {
  const i18n = createI18n(locale);

  return (
    <section className="za-card za-review-card">
      <div className="za-card-row">
        <strong>{i18n.t(calls.length === 1 ? 'review.single' : 'review.multiple', { count: calls.length })}</strong>
        <StatusBadge tone="warn">{i18n.t('review.badge')}</StatusBadge>
      </div>
      {calls.map((call) => (
        <p key={call.toolCallId}>
          {call.displayName} · {call.reason}
        </p>
      ))}
      <button className="za-primary-button" type="button" onClick={onApprove}>
        {i18n.t('review.allow')}
      </button>
      {onReject ? (
        <button type="button" onClick={onReject}>
          {i18n.t('review.deny')}
        </button>
      ) : null}
    </section>
  );
}
