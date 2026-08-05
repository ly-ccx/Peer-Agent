import type { I18nRuntime } from '@peer-agent/i18n';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { clientApi } from '../clientApi';
import { Overlay } from '../app/components/Overlay';
import type {
  UsageDailyDay,
  UsageDailyRange,
  UsageDailySnapshot,
  UsageDayModelRow,
  UsageDaySnapshot,
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
                <td title={row.cacheWriteTokens > 0 ? formatCount(row.cacheWriteTokens) : undefined}>
                  {row.cacheWriteTokens > 0 ? formatTokenCount(row.cacheWriteTokens) : '—'}
                </td>
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
  selectedDate,
  onSelectDay,
  i18n,
}: {
  readonly days: readonly UsageDailyDay[];
  readonly maxTokens: number;
  readonly selectedDate: string | null;
  readonly onSelectDay: (date: string) => void;
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

  const density = days.length <= 31 ? 'short' : days.length <= 93 ? 'medium' : 'long';
  const cellSize = density === 'medium' ? 14 : 12;
  const columnTemplate = `repeat(${weeks.length}, var(--usage-heatmap-cell-size))`;

  // 短周期（7 天 / 1 个月）：单行日条，与下方趋势图左右边界对齐；
  // 日历矩阵只在长周期（3 个月及以上）保留。
  if (density === 'short') {
    return (
      <HeatmapDayStrip
        days={days}
        maxTokens={maxTokens}
        selectedDate={selectedDate}
        onSelectDay={onSelectDay}
        i18n={i18n}
      />
    );
  }

  return (
    <div className="usage-heatmap-viewport">
      <div
        className={`usage-heatmap usage-heatmap--${density}`}
        style={{ '--usage-heatmap-cell-size': `${cellSize}px` } as CSSProperties}
      >
      <div className="usage-heatmap__content">
        <div className="usage-heatmap__months" style={{ gridTemplateColumns: `28px ${columnTemplate}` }}>
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
          <div className="usage-heatmap__grid" style={{ gridTemplateColumns: columnTemplate }}>
            {weeks.map((week, weekIndex) =>
              week.map((day, dayIndex) => {
                if (!day) {
                  return <span key={`e-${weekIndex}-${dayIndex}`} className="usage-heatmap__cell usage-heatmap__cell--empty" />;
                }
                const level = intensityLevel(day.totalTokens, maxTokens);
                const selected = selectedDate === day.date;
                return (
                  <button
                    type="button"
                    key={day.date}
                    className={`usage-heatmap__cell usage-heatmap__cell--l${level}${selected ? ' usage-heatmap__cell--selected' : ''}`}
                    title={`${day.date}: ${formatTokenCount(day.totalTokens)} tokens · ${formatCount(day.requestCount)} req`}
                    onClick={() => onSelectDay(day.date)}
                  />
                );
              }),
            )}
          </div>
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
    </div>
  );
}

/**
 * 短周期（7 天 / 1 个月）热力图：一行等分日条，铺满整行，
 * 与下方趋势图左右边界对齐；跨月处标注月份刻度；hover 复用趋势图 tooltip 风格。
 */
function HeatmapDayStrip({
  days,
  maxTokens,
  selectedDate,
  onSelectDay,
  i18n,
}: {
  readonly days: readonly UsageDailyDay[];
  readonly maxTokens: number;
  readonly selectedDate: string | null;
  readonly onSelectDay: (date: string) => void;
  readonly i18n: I18nRuntime;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const count = days.length;
  const active = hoverIndex != null ? days[hoverIndex] : null;

  // 跨月刻度：找到每个月 1 号所在的格子索引，在其上方放一个小标记。
  const monthTicks = useMemo(() => {
    const ticks: Array<{ index: number; label: string }> = [];
    days.forEach((day, index) => {
      const d = parseLocalDate(day.date);
      if (d.getDate() !== 1) return;
      ticks.push({
        index,
        label: i18n.locale.startsWith('zh')
          ? `${d.getMonth() + 1}月`
          : d.toLocaleString(i18n.locale, { month: 'short' }),
      });
    });
    return ticks;
  }, [days, i18n.locale]);

  if (count === 0) return null;

  return (
    <div className="usage-heatmap-strip" onMouseLeave={() => setHoverIndex(null)}>
      <div className="usage-heatmap-strip__row">
        {days.map((day, index) => {
          const level = intensityLevel(day.totalTokens, maxTokens);
          const selected = selectedDate === day.date;
          return (
            <button
              type="button"
              key={day.date}
              className={`usage-heatmap-strip__cell usage-heatmap__cell--l${level}${selected ? ' usage-heatmap-strip__cell--selected' : ''}`}
              onMouseEnter={() => setHoverIndex(index)}
              onClick={() => onSelectDay(day.date)}
            />
          );
        })}
        {active && hoverIndex != null ? (
          <div
            className="usage-heatmap-strip__tooltip usage-trend__tooltip"
            style={{
              // 与趋势图一致：tooltip 水平居中于格子，并夹在 8%–92% 防止贴边溢出。
              left: `${Math.min(92, Math.max(8, ((hoverIndex + 0.5) / count) * 100))}%`,
            }}
          >
            <div className="usage-trend__tooltip-date">{active.date}</div>
            <div className="usage-trend__tooltip-row">
              <span>{formatTokenCount(active.totalTokens)}</span>
              <span>tokens</span>
            </div>
            <div className="usage-trend__tooltip-row">
              <span>{formatCount(active.requestCount)}</span>
              <span>req</span>
            </div>
          </div>
        ) : null}
      </div>
      {monthTicks.length > 0 ? (
        <div className="usage-heatmap-strip__ticks">
          {monthTicks.map((tick) => (
            <span
              key={`${tick.index}-${tick.label}`}
              className="usage-heatmap-strip__tick"
              style={{ left: `${(tick.index / count) * 100}%` }}
            >
              {tick.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TokenTrendChart({
  days,
  maxTokens,
  onSelectDay,
  i18n,
}: {
  readonly days: readonly UsageDailyDay[];
  readonly maxTokens: number;
  readonly onSelectDay: (date: string) => void;
  readonly i18n: I18nRuntime;
}) {
  const width = 720;
  const height = 180;
  const padX = 12;
  const padY = 16;
  const chartW = width - padX * 2;
  const chartH = height - padY * 2;
  const safeMax = Math.max(maxTokens, 1);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const points = useMemo(
    () =>
      days.map((day, index) => {
        const x = padX + (days.length <= 1 ? chartW / 2 : (index / (days.length - 1)) * chartW);
        const y = padY + chartH - (day.totalTokens / safeMax) * chartH;
        return { x, y, day };
      }),
    [chartH, chartW, days, padX, padY, safeMax],
  );

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
  const active = hoverIndex != null ? points[hoverIndex] : null;

  const resolveHoverIndex = useCallback(
    (clientX: number, target: SVGSVGElement) => {
      if (points.length === 0) {
        setHoverIndex(null);
        return;
      }
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0) {
        setHoverIndex(null);
        return;
      }
      const svgX = ((clientX - rect.left) / rect.width) * width;
      let nearest = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < points.length; i += 1) {
        const dist = Math.abs(points[i].x - svgX);
        if (dist < bestDist) {
          bestDist = dist;
          nearest = i;
        }
      }
      setHoverIndex(nearest);
    },
    [points, width],
  );

  return (
    <div className="usage-trend">
      <div className="usage-trend__chart">
        <svg
          className="usage-trend__svg"
          viewBox={`0 0 ${width} ${height}`}
          /* Stretch to container: default meet letterboxes and breaks hover/tooltip x mapping. */
          preserveAspectRatio="none"
          role="img"
          aria-label={i18n.t('settings.usage.trend')}
          onMouseMove={(event) => resolveHoverIndex(event.clientX, event.currentTarget)}
          onMouseLeave={() => setHoverIndex(null)}
          onClick={() => {
            if (hoverIndex != null && days[hoverIndex]) onSelectDay(days[hoverIndex].date);
          }}
        >
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
          {active ? (
            <>
              <line
                x1={active.x}
                y1={padY}
                x2={active.x}
                y2={padY + chartH}
                className="usage-trend__guide"
              />
              <circle
                cx={active.x}
                cy={active.y}
                r={4.5}
                className="usage-trend__dot"
              />
            </>
          ) : null}
          {/* 透明命中层：扩大可 hover 区域，避免必须精确点到折线 */}
          <rect
            x={padX}
            y={padY}
            width={chartW}
            height={chartH}
            className="usage-trend__hit"
          />
        </svg>
        {active ? (
          <div
            className="usage-trend__tooltip"
            style={{
              /* Clamp so edge points don't push the tooltip past the chart bounds. */
              left: `${Math.min(92, Math.max(8, (active.x / width) * 100))}%`,
              top: `${Math.max(8, (active.y / height) * 100 - 8)}%`,
            }}
          >
            <div className="usage-trend__tooltip-date">{active.day.date}</div>
            <div className="usage-trend__tooltip-row">
              <span>{formatTokenCount(active.day.totalTokens)}</span>
              <span>tokens</span>
            </div>
            <div className="usage-trend__tooltip-row">
              <span>{formatCount(active.day.requestCount)}</span>
              <span>req</span>
            </div>
          </div>
        ) : null}
      </div>
      <div className="usage-trend__xlabels">
        <span>{firstLabel}</span>
        <span>{midLabel}</span>
        <span>{lastLabel}</span>
      </div>
    </div>
  );
}

/**
 * 某一天的详情面板：汇总指标 + 按模型拆分表 + 24 小时分布。
 * 数据来自 main `usage:day`（usage-day.mjs）。
 */
function DayDetailPanel({
  detail,
  loading,
  error,
  onClose,
  i18n,
}: {
  readonly detail: UsageDaySnapshot | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly i18n: I18nRuntime;
}) {
  const [hoverHour, setHoverHour] = useState<number | null>(null);
  const totals = detail?.totals;
  const maxHourTokens = totals?.maxHourTokens || 1;
  const hoveredHour = hoverHour != null && detail ? detail.hours[hoverHour] : null;

  return (
    <div className="usage-day-detail">
      <div className="usage-day-detail__header">
        <div>
          <h3>{i18n.t('settings.usage.dayDetail')}</h3>
          {detail?.date ? <p className="usage-stats-note">{detail.date}</p> : null}
        </div>
        <button
          type="button"
          className="usage-day-detail__close"
          onClick={onClose}
          aria-label={i18n.t('settings.usage.dayDetail.close')}
        >
          ×
        </button>
      </div>

      {loading && !detail ? (
        <p className="settings-status">{i18n.t('settings.usage.loading')}</p>
      ) : error ? (
        <p className="settings-status settings-status--error">{error}</p>
      ) : detail && totals ? (
        detail.notes.emptyDay ? (
          <p className="usage-stats-note">{i18n.t('settings.usage.dayDetail.empty')}</p>
        ) : (
          <>
            <div className="usage-stats-summary-grid">
              <article className="settings-card usage-stats-metric">
                <span className="usage-stats-metric__label">{i18n.t('settings.usage.totalTokens')}</span>
                <strong className="usage-stats-metric__value">{formatTokenCount(totals.totalTokens)}</strong>
                {formatTokenYiApprox(totals.totalTokens) ? (
                  <span className="usage-stats-metric__yi">{formatTokenYiApprox(totals.totalTokens)}</span>
                ) : null}
              </article>
              <article className="settings-card usage-stats-metric">
                <span className="usage-stats-metric__label">{i18n.t('settings.usage.estimatedCost')}</span>
                <strong className="usage-stats-metric__value">{formatUsd(totals.estimatedCostUsd)}</strong>
              </article>
              <article className="settings-card usage-stats-metric">
                <span className="usage-stats-metric__label">{i18n.t('settings.usage.col.requests')}</span>
                <strong className="usage-stats-metric__value">{formatCount(totals.requestCount)}</strong>
              </article>
              <article className="settings-card usage-stats-metric">
                <span className="usage-stats-metric__label">{i18n.t('settings.usage.byModel')}</span>
                <strong className="usage-stats-metric__value">{formatCount(totals.modelCount)}</strong>
              </article>
            </div>

            <div className="usage-day-detail__section">
              <h4>{i18n.t('settings.usage.dayDetail.models')}</h4>
              {detail.byModel.length === 0 ? (
                <p className="usage-stats-note">{i18n.t('settings.usage.emptyGroup')}</p>
              ) : (
                <div className="usage-stats-table-wrap">
                  <table className="usage-stats-table">
                    <thead>
                      <tr>
                        <th>{i18n.t('settings.usage.col.model')}</th>
                        <th>{i18n.t('settings.usage.col.requests')}</th>
                        <th>{i18n.t('settings.usage.col.input')}</th>
                        <th>{i18n.t('settings.usage.col.output')}</th>
                        <th>{i18n.t('settings.usage.col.cacheRead')}</th>
                        <th>{i18n.t('settings.usage.col.cacheWrite')}</th>
                        <th>{i18n.t('settings.usage.col.total')}</th>
                        <th>{i18n.t('settings.usage.col.cost')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.byModel.map((model: UsageDayModelRow) => (
                        <tr key={model.key}>
                          <td>
                            <div className="usage-day-detail__model">
                              <span>{model.label}</span>
                              {model.providerName ? <small>{model.providerName}</small> : null}
                            </div>
                          </td>
                          <td>{formatCount(model.requestCount)}</td>
                          <td>{formatTokenCount(model.inputTokens)}</td>
                          <td>{formatTokenCount(model.outputTokens)}</td>
                          <td>{formatTokenCount(model.cacheReadTokens)}</td>
                          <td>{formatTokenCount(model.cacheWriteTokens)}</td>
                          <td>{formatTokenCount(model.totalTokens)}</td>
                          <td>{formatUsd(model.estimatedCostUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="usage-day-detail__section">
              <h4>{i18n.t('settings.usage.dayDetail.hours')}</h4>
              <div className="usage-hours">
                {hoveredHour ? (
                  <div className="usage-hours__tooltip">
                    {hoveredHour.hour}
                    {i18n.t('settings.usage.dayDetail.hour')} · {formatTokenCount(hoveredHour.totalTokens)} tokens ·{' '}
                    {formatCount(hoveredHour.requestCount)} req
                  </div>
                ) : null}
                <div className="usage-hours__bars" onMouseLeave={() => setHoverHour(null)}>
                  {detail.hours.map((hour) => {
                    const ratio = hour.totalTokens > 0 ? Math.max(0.04, hour.totalTokens / maxHourTokens) : 0;
                    return (
                      <button
                        type="button"
                        key={hour.hour}
                        className={`usage-hours__bar${hour.totalTokens === 0 ? ' usage-hours__bar--empty' : ''}${
                          hoverHour === hour.hour ? ' usage-hours__bar--active' : ''
                        }`}
                        style={{ height: `${ratio * 100}%` } as CSSProperties}
                        onMouseEnter={() => setHoverHour(hour.hour)}
                        title={`${hour.hour}:00 · ${formatTokenCount(hour.totalTokens)} tokens · ${formatCount(hour.requestCount)} req`}
                      />
                    );
                  })}
                </div>
                <div className="usage-hours__labels">
                  {[0, 6, 12, 18, 23].map((h) => (
                    <span key={h}>
                      {h}
                      {i18n.t('settings.usage.dayDetail.hour')}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </>
        )
      ) : null}
    </div>
  );
}

export function UsageStatsPanel({ i18n }: { readonly i18n: I18nRuntime }) {
  const [snapshot, setSnapshot] = useState<UsageStatsSnapshot | null>(null);
  const [daily, setDaily] = useState<UsageDailySnapshot | null>(null);
  const [range, setRange] = useState<UsageDailyRange>('1m');
  const [loading, setLoading] = useState(true);
  const [dailyLoading, setDailyLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dailyError, setDailyError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [dayDetail, setDayDetail] = useState<UsageDaySnapshot | null>(null);
  const [dayLoading, setDayLoading] = useState(false);
  const [dayError, setDayError] = useState<string | null>(null);

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

  const loadDay = useCallback(async (date: string) => {
    setDayLoading(true);
    setDayError(null);
    try {
      const next = await clientApi.usageGetDay({ date });
      setDayDetail(next);
    } catch (err) {
      setDayDetail(null);
      setDayError(err instanceof Error ? err.message : String(err));
    } finally {
      setDayLoading(false);
    }
  }, []);

  const handleSelectDay = useCallback((date: string) => {
    setSelectedDay(date);
    void loadDay(date);
  }, [loadDay]);

  const handleCloseDay = useCallback(() => {
    setSelectedDay(null);
    setDayDetail(null);
    setDayError(null);
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
                  write: totals.cacheWriteTokens > 0 ? formatTokenCount(totals.cacheWriteTokens) : '—',
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
                <p className="usage-stats-note">{i18n.t('settings.usage.dayDetail.hint')}</p>
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
                <TokenHeatmap
                  days={daily.days}
                  maxTokens={daily.totals.maxTokens}
                  selectedDate={selectedDay}
                  onSelectDay={handleSelectDay}
                  i18n={i18n}
                />

                <div className="usage-trend-block">
                  <div className="usage-trend-block__title">
                    <h3>{i18n.t('settings.usage.trend')}</h3>
                    <span className="usage-stats-note">{rangeLabel(range, i18n)}</span>
                  </div>
                  <TokenTrendChart
                    days={daily.days}
                    maxTokens={daily.totals.maxTokens}
                    onSelectDay={handleSelectDay}
                    i18n={i18n}
                  />
                </div>
              </>
            ) : null}
          </section>

          {selectedDay ? (
            <Overlay
              onClose={handleCloseDay}
              ariaLabel={i18n.t('settings.usage.dayDetail')}
              panelClassName="usage-day-modal"
            >
              {({ requestClose }) => (
                <DayDetailPanel
                  detail={dayDetail}
                  loading={dayLoading}
                  error={dayError}
                  onClose={requestClose}
                  i18n={i18n}
                />
              )}
            </Overlay>
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
