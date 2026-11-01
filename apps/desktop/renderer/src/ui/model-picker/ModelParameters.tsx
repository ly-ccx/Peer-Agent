import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isImeKey } from '../../chat/state/compositionGuard';
import { selectionNavigation } from '../../app/components/selectionNavigation';
import { PeerIcon } from '../icons/PeerIcon';
import { effortLabel, effortShortLabel, type EffortLevel } from '../../chat/state/preferences';
import { EffortSliderVisual } from './EffortSliderVisual';
import { effortIndexForLevel, effortIndexFromValue, effortLevelForDisplay, snapEffortValue } from './effortSlider';

export function EffortRange({
  effort,
  levels,
  isZh,
  disabled,
  onChange,
}: {
  readonly effort: EffortLevel;
  readonly levels: readonly EffortLevel[];
  readonly isZh: boolean;
  readonly disabled: boolean;
  readonly onChange: (level: EffortLevel) => void | Promise<unknown>;
}) {
  const selectedIndex = effortIndexForLevel(effort, levels);
  const selectedValue = levels.length > 1 ? (selectedIndex / (levels.length - 1)) * 100 : 0;
  const [dragValue, setDragValue] = useState(selectedValue);
  const [dirty, setDirty] = useState(false);
  const [dragging, setDragging] = useState(false);
  const pointerStart = useRef<number | null>(null);
  const committing = useRef(false), edited = useRef(false), cancelled = useRef(false);
  const sliderRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (committing.current) return;
    setDragValue(selectedValue);
    setDirty(false); edited.current = false; cancelled.current = false;
  }, [selectedValue]);

  useLayoutEffect(() => {
    const node = sliderRef.current;
    if (!node || dirty) return;
    const next = String(selectedValue);
    if (node.value !== next) node.value = next;
  }, [dirty, selectedValue]);

  const commit = (value: number) => {
    if (!edited.current || cancelled.current || committing.current || disabled) return;
    const snapped = snapEffortValue(value, levels.length);
    const next = levels[effortIndexFromValue(snapped, levels.length)];
    setDragValue(snapped);
    if (!next || next === effort) {
      setDirty(false); edited.current = false;
      return;
    }
    committing.current = true; edited.current = false;
    const settled = () => { committing.current = false; setDirty(false); edited.current = false; };
    // Keep the selected thumb while the owner waits for its actual save receipt.
    try { Promise.resolve(onChange(next)).then(settled, settled); }
    catch { settled(); }
  };

  const effectiveValue = dirty ? dragValue : selectedValue;
  const displayed = effortLevelForDisplay(effort, levels, effectiveValue, dirty);
  const displayLabel = effortShortLabel(displayed, isZh);
  const fullLabel = effortLabel(displayed, isZh);

  return (
    <>
      <div className="reasoning-effort-panel-heading">
        <span>{isZh ? '思考强度' : 'Reasoning effort'}</span>
        <strong>{displayLabel}</strong>
      </div>
      <div className="reasoning-effort-slider-shell is-animated" data-dragging={dragging}>
        <EffortSliderVisual value={effectiveValue} disabled={disabled} />
        {levels.map((level, index) => {
          const t = levels.length > 1 ? index / (levels.length - 1) : 0;
          const previewIndex = dirty
            ? effortIndexFromValue(effectiveValue, levels.length)
            : selectedIndex;
          return (
            <span
              key={level}
              className={`reasoning-effort-slider-tick${index <= previewIndex ? ' is-active' : ''}`}
              style={{ left: `calc(var(--effort-thumb) / 2 + (100% - var(--effort-thumb)) * ${t})` }}
              aria-hidden="true"
            />
          );
        })}
        <input
          ref={sliderRef}
          className="reasoning-effort-slider"
          type="range"
          min="0"
          max="100"
          step="1"
          disabled={disabled}
          defaultValue={selectedValue}
          aria-label={isZh ? '思考强度' : 'Reasoning effort'}
          aria-valuetext={fullLabel}
          onInput={(event) => {
            edited.current = true; cancelled.current = false; setDirty(true);
            setDragValue(Number(event.currentTarget.value));
          }}
          onChange={(event) => {
            edited.current = true; cancelled.current = false; setDirty(true);
            setDragValue(Number(event.currentTarget.value));
          }}
          onPointerDown={event => { pointerStart.current = event.clientX; }}
          onPointerMove={event => { if (pointerStart.current !== null && event.clientX !== pointerStart.current) setDragging(true); }}
          onPointerUp={(event) => { pointerStart.current = null; setDragging(false); commit(Number(event.currentTarget.value)); }}
          onPointerCancel={() => { pointerStart.current = null; setDragging(false); cancelled.current = true; edited.current = false; setDirty(false); setDragValue(selectedValue); }}
          onKeyDown={event => {
            if (event.key === 'Escape' && !isImeKey(event) && edited.current) { event.preventDefault(); event.stopPropagation(); cancelled.current = true; edited.current = false; setDirty(false); setDragValue(selectedValue); }
          }}
          onKeyUp={(event) => {
            if (isImeKey(event) || event.defaultPrevented) return;
            if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') {
              commit(Number(event.currentTarget.value));
            }
          }}
          onBlur={(event) => { pointerStart.current = null; setDragging(false); commit(Number(event.currentTarget.value)); }}
        />
      </div>
    </>
  );
}

export function RequestChannelToggle({
  fastMode,
  isZh,
  disabled,
  onChange,
}: {
  readonly fastMode: boolean;
  readonly isZh: boolean;
  readonly disabled: boolean;
  readonly onChange: (enabled: boolean) => void;
}) {
  return (
    <div className="reasoning-request-channel">
      <span className="reasoning-request-channel-label">{isZh ? '请求通道' : 'Request channel'}</span>
      <div className="reasoning-request-channel-options" role="radiogroup" onKeyDown={event => {
        if (isImeKey(event) || event.defaultPrevented) return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
        const next = selectionNavigation(buttons.map(button => ({ disabled: button.disabled })), buttons.indexOf(event.target as HTMLButtonElement), event.key, 'horizontal', getComputedStyle(event.currentTarget).direction === 'rtl');
        if (next !== null) { event.preventDefault(); buttons[next]?.focus(); }
      }} aria-label={isZh ? '请求通道' : 'Request channel'}>
        <button type="button" className={!fastMode ? 'is-active' : ''} role="radio" aria-checked={!fastMode} tabIndex={!fastMode ? 0 : -1} disabled={disabled} onClick={() => onChange(false)}>
          {isZh ? '正常' : 'Normal'}
        </button>
        <button type="button" className={fastMode ? 'is-active is-fast' : 'is-fast'} role="radio" aria-checked={fastMode} tabIndex={fastMode ? 0 : -1} disabled={disabled} onClick={() => onChange(true)}>
          <PeerIcon name="bolt" size={12} fill="currentColor" stroke="none" />
          {isZh ? '快速' : 'Fast'}
        </button>
      </div>
    </div>
  );
}
