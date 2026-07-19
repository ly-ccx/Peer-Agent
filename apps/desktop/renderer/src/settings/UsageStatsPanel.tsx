import type { I18nRuntime } from '@peer-agent/i18n';
import { useCallback, useEffect, useState } from 'react';
import { clientApi } from '../clientApi';
import type { UsageStatsGroupRow, UsageStatsSnapshot } from '../preload/contracts/bootstrapPreloadApi';
import { formatTokenCount } from '../chat/state/format';

/** 设置分区标题：使用统计（精简跨会话汇总页）。 */

function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 100) return `$${value.toFixed(2)}`;
  if (Math.abs(value) >= 1) return `$${value.toFixed(3)}`;
  if (Math.abs(value) >= 0.01) return `$${value.toFixed(4)}`;
  if (value === 0) return '$0';
  return `$${value.toFixed(6)}`;
}

function formatCount(value: number | null | undefined): string {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString();
}

function GroupTable({
  title,
  rows,
  nameHeader,
  i18n,
}: {
  readonly title: string;
  readonly rows: readonly UsageStatsGroupRow[];
  readonly nameHeader: string;
  readonly i18n: I18nRuntime;
}) {
  if (rows.length === 0) {
    return (
      <section className="settings-card usage-stats-card">
        <h3>{title}</h3>
        <p className="settings-status">{i18n.t('settings.usage.emptyGroup')}</p>
      </section>
    );
  }

  return (
    <section className="settings-card usage-stats-card">
      <h3>{title}</h3>
      <div className="usage-stats-table-wrap">
        <table className="usage-stats-table">
          <thead>
            <tr>
              <th>{nameHeader}</th>
              <th>{i18n.t('settings.usage.col.conversations')}</th>
              <th>{i18n.t('settings.usage.col.input')}</th>
              <th>{i18n.t('settings.usage.col.output')}</th>
              <th>{i18n.t('settings.usage.col.cacheRead')}</th>
              <th>{i18n.t('settings.usage.col.cacheWrite')}</th>
              <th>{i18n.t('settings.usage.col.total')}</th>
              <th>{i18n.t('settings.usage.col.cost')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>
                  <div className="usage-stats-name">
                    <strong>{row.label || row.model || row.key}</strong>
                    {row.providerName && row.model ? (
                      <span className="usage-stats-sub">{row.providerName}</span>
                    ) : null}
                  </div>
                </td>
                <td>{formatCount(row.conversationCount)}</td>
                <td title={formatCount(row.inputTokens)}>{formatTokenCount(row.inputTokens)}</td>
                <td title={formatCount(row.outputTokens)}>{formatTokenCount(row.outputTokens)}</td>
                <td title={formatCount(row.cacheReadTokens)}>{formatTokenCount(row.cacheReadTokens)}</td>
                <td title={formatCount(row.cacheWriteTokens)}>{formatTokenCount(row.cacheWriteTokens)}</td>
                <td title={formatCount(row.totalTokens)}>{formatTokenCount(row.totalTokens)}</td>
                <td>{formatUsd(row.estimatedCostUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function UsageStatsPanel({ i18n }: { readonly i18n: I18nRuntime }) {
  const [snapshot, setSnapshot] = useState<UsageStatsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await clientApi.usageGetStats();
      setSnapshot(result);
    } catch (err) {
      setSnapshot(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = snapshot?.totals;

  return (
    <div className="settings-panel usage-stats-panel">
      <header className="settings-panel__header">
        <div>
          <h2>{i18n.t('settings.usage')}</h2>
          <p>{i18n.t('settings.usage.description')}</p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => void load()} disabled={loading}>
          {loading ? i18n.t('settings.usage.loading') : i18n.t('settings.usage.refresh')}
        </button>
      </header>

      {error ? (
        <p className="settings-status settings-status--error">
          {i18n.t('settings.usage.loadFailed')}: {error}
        </p>
      ) : null}

      {loading && !snapshot ? (
        <p className="settings-status">{i18n.t('settings.usage.loading')}</p>
      ) : null}

      {totals ? (
        <>
          <section className="usage-stats-summary-grid">
            <article className="settings-card usage-stats-metric">
              <span className="usage-stats-metric__label">{i18n.t('settings.usage.totalTokens')}</span>
              <strong className="usage-stats-metric__value" title={formatCount(totals.totalTokens)}>
                {formatTokenCount(totals.totalTokens)}
              </strong>
            </article>
            <article className="settings-card usage-stats-metric">
              <span className="usage-stats-metric__label">{i18n.t('settings.usage.estimatedCost')}</span>
              <strong className="usage-stats-metric__value">{formatUsd(totals.estimatedCostUsd)}</strong>
            </article>
            <article className="settings-card usage-stats-metric">
              <span className="usage-stats-metric__label">{i18n.t('settings.usage.conversations')}</span>
              <strong className="usage-stats-metric__value">{formatCount(totals.conversationCount)}</strong>
            </article>
            <article className="settings-card usage-stats-metric">
              <span className="usage-stats-metric__label">{i18n.t('settings.usage.inputTokens')}</span>
              <strong className="usage-stats-metric__value" title={formatCount(totals.inputTokens)}>
                {formatTokenCount(totals.inputTokens)}
              </strong>
            </article>
            <article className="settings-card usage-stats-metric">
              <span className="usage-stats-metric__label">{i18n.t('settings.usage.outputTokens')}</span>
              <strong className="usage-stats-metric__value" title={formatCount(totals.outputTokens)}>
                {formatTokenCount(totals.outputTokens)}
              </strong>
            </article>
            <article className="settings-card usage-stats-metric">
              <span className="usage-stats-metric__label">{i18n.t('settings.usage.cacheTokens')}</span>
              <strong
                className="usage-stats-metric__value"
                title={`${formatCount(totals.cacheReadTokens)} / ${formatCount(totals.cacheWriteTokens)}`}
              >
                {formatTokenCount(totals.cacheReadTokens + totals.cacheWriteTokens)}
              </strong>
              <span className="usage-stats-metric__hint">
                {i18n.t('settings.usage.cacheSplit', {
                  read: formatTokenCount(totals.cacheReadTokens),
                  write: formatTokenCount(totals.cacheWriteTokens),
                })}
              </span>
            </article>
          </section>

          <p className="usage-stats-note">{i18n.t('settings.usage.note')}</p>
          {(snapshot?.notes.unpricedConversationCount || 0) > 0 ? (
            <p className="usage-stats-note usage-stats-note--warn">
              {i18n.t('settings.usage.unpricedNote', {
                count: String(snapshot?.notes.unpricedConversationCount || 0),
              })}
            </p>
          ) : null}

          <GroupTable
            title={i18n.t('settings.usage.byProvider')}
            rows={snapshot?.byProvider || []}
            nameHeader={i18n.t('settings.usage.col.provider')}
            i18n={i18n}
          />
          <GroupTable
            title={i18n.t('settings.usage.byModel')}
            rows={snapshot?.byModel || []}
            nameHeader={i18n.t('settings.usage.col.model')}
            i18n={i18n}
          />
        </>
      ) : null}
    </div>
  );
}
