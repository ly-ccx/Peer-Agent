import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { effortLabel, type EffortLevel } from '../../state/preferences';
import { effortIndexForLevel, effortIndexFromValue, effortLevelForDisplay, snapEffortValue } from './effortSlider';

export function ReasoningEffortSlider({
  effort,
  effortLevels,
  fastAvailable,
  fastMode,
  isZh,
  disabled,
  onEffortChange,
  onFastModeChange,
}: {
  readonly effort: EffortLevel;
  readonly effortLevels: readonly EffortLevel[];
  readonly fastAvailable: boolean;
  readonly fastMode: boolean;
  readonly isZh: boolean;
  readonly disabled: boolean;
  readonly onEffortChange: (level: EffortLevel) => void;
  readonly onFastModeChange: (enabled: boolean) => void;
}) {
  const selectedIndex = effortIndexForLevel(effort, effortLevels);
  const selectedValue = effortLevels.length > 1 ? (selectedIndex / (effortLevels.length - 1)) * 100 : 0;
  const [open, setOpen] = useState(false);
  const [dragValue, setDragValue] = useState(selectedValue);
  const [dirty, setDirty] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  useEffect(() => {
    setDragValue(selectedValue);
    setDirty(false);
  }, [selectedValue]);

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const rect = trigger.getBoundingClientRect();
      const panelWidth = panel.offsetWidth;
      const panelHeight = panel.offsetHeight;
      const gap = 6;
      const margin = 8;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      // Prefer above the trigger; flip below when there is not enough room.
      let top = rect.top - panelHeight - gap;
      if (top < margin) {
        const below = rect.bottom + gap;
        if (below + panelHeight <= viewportHeight - margin) {
          top = below;
        } else {
          top = Math.max(margin, Math.min(top, viewportHeight - panelHeight - margin));
        }
      }

      // Prefer left-aligned with the trigger; clamp horizontally to the viewport.
      const left = Math.max(
        margin,
        Math.min(rect.left, viewportWidth - panelWidth - margin),
      );

      setCoords({ left, top });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
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

  const commit = (value: number) => {
    if (!dirty) return;
    const snapped = snapEffortValue(value, effortLevels.length);
    const next = effortLevels[effortIndexFromValue(snapped, effortLevels.length)];
    setDragValue(snapped);
    setDirty(false);
    if (next) onEffortChange(next);
  };

  const effectiveValue = dirty ? dragValue : selectedValue;
  const displayedLevel = effortLevelForDisplay(effort, effortLevels, effectiveValue, dirty);
  const displayLabel = effortLabel(displayedLevel, isZh);
  const label = effortLabel(effort, isZh);
  const panel = open
    ? createPortal(
        <div
          ref={panelRef}
          id={panelId}
          className="reasoning-effort-panel"
          style={coords ? { left: coords.left, top: coords.top, visibility: 'visible' } : undefined}
        >
          <div className="reasoning-effort-panel-heading">
            <span>{isZh ? '思考强度' : 'Reasoning effort'}</span>
            <strong>{displayLabel}</strong>
          </div>
          <div className="reasoning-effort-slider-shell">
            {/*
              几何契约（与 WebKit/Firefox range 拇指圆心一致）：
              centerX = thumb/2 + (100% - thumb) * t
              轨道/刻度/填充必须共用此坐标系，不能再用 track 局部 0–100%。
            */}
            <div className="reasoning-effort-slider-track" aria-hidden="true">
              <div
                className="reasoning-effort-slider-fill"
                style={{
                  width: `calc(var(--effort-thumb) / 2 + (100% - var(--effort-thumb)) * ${effectiveValue} / 100)`,
                }}
              />
            </div>
            {effortLevels.map((level, index) => {
              const t = effortLevels.length > 1
                ? index / (effortLevels.length - 1)
                : 0;
              const previewIndex = dirty
                ? effortIndexFromValue(effectiveValue, effortLevels.length)
                : selectedIndex;
              const active = index <= previewIndex;
              return (
                <span
                  key={level}
                  className={`reasoning-effort-slider-tick${active ? ' is-active' : ''}`}
                  style={{
                    left: `calc(var(--effort-thumb) / 2 + (100% - var(--effort-thumb)) * ${t})`,
                  }}
                  aria-hidden="true"
                />
              );
            })}
            <input
              className="reasoning-effort-slider"
              type="range"
              min="0"
              max="100"
              step="1"
              value={effectiveValue}
              aria-label={isZh ? '思考强度' : 'Reasoning effort'}
              aria-valuetext={displayLabel}
              style={{ '--effort-progress': `${effectiveValue}%` } as CSSProperties}
              onInput={(event) => {
                setDirty(true);
                setDragValue(Number(event.currentTarget.value));
              }}
              onChange={(event) => {
                setDirty(true);
                setDragValue(Number(event.currentTarget.value));
              }}
              onPointerUp={(event) => commit(Number(event.currentTarget.value))}
              onKeyUp={(event) => {
                if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') {
                  commit(Number(event.currentTarget.value));
                }
              }}
              onBlur={(event) => commit(Number(event.currentTarget.value))}
            />
          </div>
          {fastAvailable ? (
            <div className="reasoning-request-channel">
              <span className="reasoning-request-channel-label">
                {isZh ? '请求通道' : 'Request channel'}
              </span>
              <div
                className="reasoning-request-channel-options"
                role="group"
                aria-label={isZh ? '请求通道' : 'Request channel'}
              >
                <button
                  type="button"
                  className={!fastMode ? 'is-active' : ''}
                  aria-pressed={!fastMode}
                  disabled={disabled}
                  onClick={() => onFastModeChange(false)}
                >
                  {isZh ? '正常' : 'Normal'}
                </button>
                <button
                  type="button"
                  className={fastMode ? 'is-active is-fast' : 'is-fast'}
                  aria-pressed={fastMode}
                  disabled={disabled}
                  onClick={() => onFastModeChange(true)}
                >
                  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M9.15 1.75 3.9 8.3h3.65L6.9 14.25l5.2-7.05H8.55l.6-5.45Z"
                      fill="currentColor"
                      stroke="currentColor"
                      strokeWidth="0.7"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {isZh ? '快速' : 'Fast'}
                </button>
              </div>
            </div>
          ) : null}
        </div>,
        document.body,
      )
    : null;

  return (
    <div ref={rootRef} className="reasoning-effort-control">
      <button
        ref={triggerRef}
        type="button"
        className={`reasoning-effort-trigger ${open ? 'open' : ''}`}
        disabled={disabled}
        title={isZh ? '思考强度' : 'Reasoning effort'}
        aria-label={`${isZh ? '思考强度' : 'Reasoning effort'}：${label}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="reasoning-effort-trigger-content" aria-hidden="true">
          {fastAvailable && fastMode ? (
            <svg className="reasoning-effort-channel-badge" viewBox="0 0 16 16" fill="none">
              <path
                d="M9.15 1.75 3.9 8.3h3.65L6.9 14.25l5.2-7.05H8.55l.6-5.45Z"
                fill="currentColor"
                stroke="currentColor"
                strokeWidth="0.7"
                strokeLinejoin="round"
              />
            </svg>
          ) : null}
          {label}
        </span>
      </button>
      {panel}
    </div>
  );
}
