import type { I18nRuntime } from '@peer-agent/i18n';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientApi } from '../clientApi';
import type {
  UsageDailyDay,
  UsageDailyRange,
  UsageDailySnapshot,
  UsageStatsGroupRow,
  UsageStatsSnapshot,
} from '../preload/contracts/bootstrapPreloadApi';
import { formatTokenCount, formatTokenYiApprox } from '../chat/state/format';

/** 设置分区：使用统计（跨会话汇总 + 请求日志热力图/趋势）。 */

const RANGE_OPTIONS: readonly UsageDailyRange[] = ['1y', '6m', '3m', '1m', '7d'];
const WEEKDAY_LABELS = ['一', '三', '五'] as const;

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

function rangeLabel(range: UsageDailyRange, i18n: I18nRuntime): string {
  switch (range) {
    case '7d':
      return i18n.t('settings.usage.range.7d');
    case '1m':
      return i18n.t('settings.usage.range.1m');
    case '3m':
      return i18n.t('settings.usage.range.3m');
    case '6m':
      return i18n.t('settings.usage.range.6m');
    case '1y':
    default:
      return i18n.t('settings.usage.range.1y');
  }
}

function parseLocalDate(dateKey: string): Date {
  const [y, m, d] = dateKey.split('-').map((part) => Number(part));
  return new Date(y, (m || 1) - 1, d || 1);
}

function intensityLevel(tokens: number, maxTokens: number): 0 | 1 | 2 | 3 | 4 {
  if (tokens <= 0 || maxTokens <= 0) return 0;
  const ratio = tokens / maxTokens;
  if (ratio <= 0.2) return 1;
  if (ratio <= 0.4) return 2;
  if (ratio <= 0.7) return 3;
  return 4;
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

function TokenHeatmap({
  days,
  maxTokens,
  i18n,
}: {
  readonly days: readonly UsageDailyDay[];
  readonly maxTokens: number;
  readonly i18n: I18nRuntime;
}) {
  const weeks = useMemo(() => {
    if (days.length === 0) return [] as Array<Array<UsageDailyDay | null>>;
    const first = parseLocalDate(days[0].date);
    // JS: 0=Sun ... 6=Sat → Monday-first offset
    const mondayOffset = (first.getDay() + 6) % 7;
    const cells: Array<UsageDailyDay | null> = Array.from({ length: mondayOffset }, () => null);
    for (const day of days) cells.push(day);
    while (cells.length % 7 !== 0) cells.push(null);

    const result: Array<Array<UsageDailyDay | null>> = [];
    for (let i = 0; i < cells.length; i += 7) {
      result.push(cells.slice(i, i + 7));
    }
    return result;
  }, [days]);

  const monthLabels = useMemo(() => {
    const labels: Array<{ weekIndex: number; label: string }> = [];
    let lastMonth = -1;
    weeks.forEach((week, weekIndex) => {
      const firstDay = week.find((d) => d != null);
      if (!firstDay) return;
      const month = parseLocalDate(firstDay.date).getMonth();
      if (month === lastMonth) return;
      lastMonth = month;
      labels.push({
        weekIndex,
        label: i18n.locale.startsWith('zh')
          ? `${month + 1}月`
          : parseLocalDate(firstDay.date).toLocaleString(i18n.locale, { month: 'short' }),
      });
    });
    return labels;
  }, [weeks, i18n.locale]);

  return (
    <div className="usage-heatmap">
      <div className="usage-heatmap__months" style={{ gridTemplateColumns: `28px repeat(${weeks.length}, 12px)` }}>
        <span />
        {weeks.map((_, weekIndex) => {
          const label = monthLabels.find((item) => item.weekIndex === weekIndex)?.label || '';
          return (
            <span key={`m-${weekIndex}`} className="usage-heatmap__month">
              {label}
            </span>
          );
        })}
      </div>
      <div className="usage-heatmap__body">
        <div className="usage-heatmap__weekdays">
          <span>{WEEKDAY_LABELS[0]}</span>
          <span />
          <span>{WEEKDAY_LABELS[1]}</span>
          <span />
          <span>{WEEKDAY_LABELS[2]}</span>
          <span />
          <span />
        </div>
        <div className="usage-heatmap__grid" style={{ gridTemplateColumns: `repeat(${weeks.length}, 12px)` }}>
          {weeks.map((week, weekIndex) =>
            week.map((day, dayIndex) => {
              if (!day) {
                return <span key={`e-${weekIndex}-${dayIndex}`} className="usage-heatmap__cell usage-heatmap__cell--empty" />;
              }
              const level = intensityLevel(day.totalTokens, maxTokens);
              return (
                <span
                  key={day.date}
                  className={`usage-heatmap__cell usage-heatmap__cell--l${level}`}
                  title={`${day.date}: ${formatTokenCount(day.totalTokens)} tokens · ${formatCount(day.requestCount)} req`}
                />
              );
            }),
          )}
        </div>
      </div>
      <div className="usage-heatmap__legend">
        <span>{i18n.t('settings.usage.heatmap.less')}</span>
        <span className="usage-heatmap__cell usage-heatmap__cell--l0" />
        <span className="usage-heatmap__cell usage-heatmap__cell--l1" />
        <span className="usage-heatmap__cell usage-heatmap__cell--l2" />
        <span className="usage-heatmap__cell usage-heatmap__cell--l3" />
        <span className="usage-heatmap__cell usage-heatmap__cell--l4" />
        <span>{i18n.t('settings.usage.heatmap.more')}</span>
      </div>
    </div>
  );
}

function TokenTrendChart({
  days,
  maxTokens,
  i18n,
}: {
  readonly days: readonly UsageDailyDay[];
  readonly maxTokens: number;
  readonly i18n: I18nRuntime;
}) {
  const width = 720;
  const height = 180;
  const padX = 12;
  const padY = 16;
  const chartW = width - padX * 2;
  const chartH = height - padY * 2;
  const safeMax = Math.max(maxTokens, 1);

  const points = days.map((day, index) => {
    const x = padX + (days.length <= 1 ? chartW / 2 : (index / (days.length - 1)) * chartW);
    const y = padY + chartH - (day.totalTokens / safeMax) * chartH;
    return { x, y, day };
  });

  const linePath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(' ');
  const areaPath =
    points.length === 0
      ? ''
      : `${linePath} L${points[points.length - 1].x.toFixed(2)},${(padY + chartH).toFixed(2)} L${points[0].x.toFixed(2)},${(padY + chartH).toFixed(2)} Z`;

  const firstLabel = days[0]?.date?.slice(5) || '';
  const midLabel = days[Math.floor(days.length / 2)]?.date?.slice(5) || '';
  const lastLabel = days[days.length - 1]?.date?.slice(5) || '';

  return (
    <div className="usage-trend">
      <svg className="usage-trend__svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={i18n.t('settings.usage.trend')}>
        <defs>
          <linearGradient id="usageTrendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--pa-accent, #3b82f6)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--pa-accent, #3b82f6)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line
          x1={padX}
          y1={padY + chartH}
          x2={padX + chartW}
          y2={padY + chartH}
          className="usage-trend__axis"
        />
        {areaPath ? <path d={areaPath} fill="url(#usageTrendFill)" /> : null}
        {linePath ? <path d={linePath} className="usage-trend__line" fill="none" /> : null}
      </svg>
      <div className="usage-trend__xlabels">
        <span>{firstLabel}</span>
        <span>{midLabel}</span>
        <span>{lastLabel}</span>
      </div>
    </div>
  );
}

export function UsageStatsPanel({ i18n }: { readonly i18n: I18nRuntime }) {
  const [snapshot, setSnapshot] = useState<UsageStatsSnapshot | null>(null);
  const [daily, setDaily] = useState<UsageDailySnapshot | null>(null);
  const [range, setRange] = useState<UsageDailyRange>('1y');
  const [loading, setLoading] = useState(true);
  const [dailyLoading, setDailyLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dailyError, setDailyError] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await clientApi.usageGetStats();
      setSnapshot(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDaily = useCallback(async (nextRange: UsageDailyRange) => {
    setDailyLoading(true);
    setDailyError(null);
    try {
      const next = await clientApi.usageGetDaily({ range: nextRange });
      setDaily(next);
    } catch (err) {
      setDailyError(err instanceof Error ? err.message : String(err));
    } finally {
      setDailyLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  useEffect(() => {
    void loadDaily(range);
  }, [loadDaily, range]);

  const totals = snapshot?.totals;
  const dailyTotals = daily?.totals;

  return (
    <div className="settings-panel usage-stats-panel">
      <header className="settings-panel__header">
        <div>
          <h2>{i18n.t('settings.usage')}</h2>
          <p>{i18n.t('settings.usage.description')}</p>
        </div>
        <button
          type="button"
          className="settings-btn"
          onClick={() => {
            void loadStats();
            void loadDaily(range);
          }}
          disabled={loading || dailyLoading}
        >
          {i18n.t('settings.usage.refresh')}
        </button>
      </header>

      {error ? <p className="settings-status settings-status--error">{error || i18n.t('settings.usage.loadFailed')}</p> : null}

      {loading && !snapshot ? (
        <p className="settings-status">{i18n.t('settings.usage.loading')}</p>
      ) : totals ? (
        <>
          <section className="usage-stats-summary-grid">
            <article className="settings-card usage-stats-metric">
              <span className="usage-stats-metric__label">{i18n.t('settings.usage.totalTokens')}</span>
              <strong className="usage-stats-metric__value" title={formatCount(totals.totalTokens)}>
                {formatTokenCount(totals.totalTokens)}
              </strong>
              {formatTokenYiApprox(totals.totalTokens) ? (
                <span className="usage-stats-metric__yi">{formatTokenYiApprox(totals.totalTokens)}</span>
              ) : null}
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
              {formatTokenYiApprox(totals.inputTokens) ? (
                <span className="usage-stats-metric__yi">{formatTokenYiApprox(totals.inputTokens)}</span>
              ) : null}
            </article>
            <article className="settings-card usage-stats-metric">
              <span className="usage-stats-metric__label">{i18n.t('settings.usage.outputTokens')}</span>
              <strong className="usage-stats-metric__value" title={formatCount(totals.outputTokens)}>
                {formatTokenCount(totals.outputTokens)}
              </strong>
              {formatTokenYiApprox(totals.outputTokens) ? (
                <span className="usage-stats-metric__yi">{formatTokenYiApprox(totals.outputTokens)}</span>
              ) : null}
            </article>
            <article className="settings-card usage-stats-metric">
              <span className="usage-stats-metric__label">{i18n.t('settings.usage.cacheTokens')}</span>
              <strong
                className="usage-stats-metric__value"
                title={`${formatCount(totals.cacheReadTokens)} / ${formatCount(totals.cacheWriteTokens)}`}
              >
                {formatTokenCount(totals.cacheReadTokens + totals.cacheWriteTokens)}
              </strong>
              {formatTokenYiApprox(totals.cacheReadTokens + totals.cacheWriteTokens) ? (
                <span className="usage-stats-metric__yi">
                  {formatTokenYiApprox(totals.cacheReadTokens + totals.cacheWriteTokens)}
                </span>
              ) : null}
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

          <section className="settings-card usage-stats-card usage-daily-card">
            <div className="usage-daily-card__header">
              <div>
                <h3>{i18n.t('settings.usage.heatmap')}</h3>
                <p className="usage-stats-note">
                  {i18n.t('settings.usage.heatmap.note')}
                  {daily ? ` · ${daily.startDate} → ${daily.endDate}` : ''}
                </p>
              </div>
              <div className="usage-range-tabs" role="tablist" aria-label={i18n.t('settings.usage.range')}>
                {RANGE_OPTIONS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="tab"
                    aria-selected={range === option}
                    className={`usage-range-tab${range === option ? ' is-active' : ''}`}
                    onClick={() => setRange(option)}
                  >
                    {rangeLabel(option, i18n)}
                  </button>
                ))}
              </div>
            </div>

            {dailyError ? (
              <p className="settings-status settings-status--error">{dailyError}</p>
            ) : dailyLoading && !daily ? (
              <p className="settings-status">{i18n.t('settings.usage.loading')}</p>
            ) : daily ? (
              <>
                <div className="usage-daily-summary">
                  <span>
                    {i18n.t('settings.usage.daily.totalTokens')}: {formatTokenCount(dailyTotals?.totalTokens || 0)}
                  </span>
                  <span>
                    {i18n.t('settings.usage.daily.requests')}: {formatCount(dailyTotals?.requestCount || 0)}
                  </span>
                  <span>
                    {i18n.t('settings.usage.daily.activeDays')}: {formatCount(dailyTotals?.activeDayCount || 0)}
                  </span>
                </div>
                {daily.notes.emptyLog ? (
                  <p className="usage-stats-note usage-stats-note--warn">{i18n.t('settings.usage.heatmap.empty')}</p>
                ) : null}
                <TokenHeatmap days={daily.days} maxTokens={daily.totals.maxTokens} i18n={i18n} />

                <div className="usage-trend-block">
                  <div className="usage-trend-block__title">
                    <h3>{i18n.t('settings.usage.trend')}</h3>
                    <span className="usage-stats-note">{rangeLabel(range, i18n)}</span>
                  </div>
                  <TokenTrendChart days={daily.days} maxTokens={daily.totals.maxTokens} i18n={i18n} />
                </div>
              </>
            ) : null}
          </section>

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
