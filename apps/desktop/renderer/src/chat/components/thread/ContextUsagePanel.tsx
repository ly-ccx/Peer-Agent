import type { ContextUsageBreakdown } from '@peer-agent/protocol';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { formatTokenCount } from '../../state/format';
import { PeerIcon } from '../../../ui/icons/PeerIcon';
import { resolveContextUsagePanelModel } from './contextUsagePanelModel';

export function ContextUsagePanel({
  percent,
  usedTokens,
  contextWindow,
  breakdown,
  isZh,
  summaryLabel,
  degraded = false,
  footerLines = [],
  accountUsage,
}: {
  readonly percent: number | null;
  readonly usedTokens: number | null;
  readonly contextWindow: number | null | undefined;
  readonly breakdown: ContextUsageBreakdown | null | undefined;
  readonly isZh: boolean;
  readonly summaryLabel: string;
  readonly degraded?: boolean;
  readonly footerLines?: readonly string[];
  readonly accountUsage?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  const titleId = useId();
  const model = resolveContextUsagePanelModel({
    percent,
    usedTokens,
    contextWindow,
    breakdown,
    isZh,
  });
  const usedRatioTotal = model.rows.reduce((sum, row) => sum + row.tokens, 0);

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const rect = trigger.getBoundingClientRect();
      const panelWidth = panel.offsetWidth;
      const panelHeight = panel.offsetHeight;
      const gap = 8;
      const margin = 8;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let top = rect.top - panelHeight - gap;
      if (top < margin) {
        const below = rect.bottom + gap;
        top = below + panelHeight <= viewportHeight - margin
          ? below
          : Math.max(margin, Math.min(top, viewportHeight - panelHeight - margin));
      }

      const left = Math.max(
        margin,
        Math.min(rect.right - panelWidth, viewportWidth - panelWidth - margin),
      );
      setCoords({ left, top });
    };
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    if (panelRef.current) observer.observe(panelRef.current);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, model.rows.length, model.statusLabel]);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const panel = open
    ? createPortal(
        <div
          ref={panelRef}
          id={panelId}
          className="ctx-usage-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          style={coords ? { left: coords.left, top: coords.top, visibility: 'visible' } : undefined}
        >
          <div className="ctx-usage-panel-header">
            <h3 id={titleId}>{model.title}</h3>
            <button
              type="button"
              className="ctx-usage-panel-close"
              aria-label={isZh ? '关闭' : 'Close'}
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              <PeerIcon name="close" size={12} />
            </button>
          </div>
          <div className="ctx-usage-panel-summary">
            <span>{model.statusLabel}</span>
            <span>{model.tokenLabel}</span>
          </div>
          <div className="ctx-usage-panel-bar" aria-hidden="true">
            {model.rows.map((row) => {
              const ratio = usedRatioTotal > 0
                ? row.tokens / usedRatioTotal
                : 0;
              const width = `${((1 - model.unusedRatio) * ratio) * 100}%`;
              return (
                <span
                  key={row.id}
                  className="ctx-usage-panel-bar-seg"
                  style={{ width, background: row.color }}
                />
              );
            })}
            {model.unusedRatio > 0 ? (
              <span
                className="ctx-usage-panel-bar-seg is-unused"
                style={{ width: `${model.unusedRatio * 100}%` }}
              />
            ) : null}
          </div>
          {model.rows.length > 0 ? (
            <ul className="ctx-usage-panel-list">
              {model.rows.map((row) => (
                <li key={row.id}>
                  <span className="ctx-usage-panel-swatch" style={{ background: row.color }} />
                  <span className="ctx-usage-panel-label">{row.label}</span>
                  <span className="ctx-usage-panel-tokens">{formatTokenCount(row.tokens)} tokens</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="ctx-usage-panel-empty">
              {isZh ? '尚无已计量的上下文构成。' : 'No measured context composition yet.'}
            </p>
          )}
          {footerLines.length > 0 ? (
            <div className="ctx-usage-panel-notes">
              {footerLines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          ) : null}
          {accountUsage}
        </div>,
        document.body,
      )
    : null;

  return (
    <div ref={rootRef} className="ctx-usage-control">
      <button
        ref={triggerRef}
        type="button"
        className={`ctx-usage${open ? ' is-open' : ''}`}
        aria-label={summaryLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span
          className="ctx-ring"
          style={{ '--ctx-pct': percent ?? 0 } as CSSProperties}
          aria-hidden
        />
        <span className="ctx-pct">
          {percent == null ? '?' : `${Math.round(percent)}%`}
          {degraded ? '!' : ''}
        </span>
      </button>
      {panel}
    </div>
  );
}
