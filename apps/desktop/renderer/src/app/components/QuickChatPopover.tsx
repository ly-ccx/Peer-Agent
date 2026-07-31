import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { effortIndexFromValue, snapEffortValue } from '../../chat/components/thread/effortSlider';
import { effortLabel, isEffortLevel } from '../../chat/state/preferences';
import type {
  QuickChatPopoverAnchorRect,
  QuickChatPopoverState,
} from '../../preload/contracts/bootstrapPreloadApi';
import {
  resolveQuickChatPopoverPosition,
  resolveQuickChatPopoverVisualSize,
} from './quickChatPopoverLayout.ts';

export type InlineQuickChatPopoverState = QuickChatPopoverState & {
  readonly anchorRect?: QuickChatPopoverAnchorRect;
};

interface QuickChatPopoverProps {
  readonly state: InlineQuickChatPopoverState;
  readonly onSelect: (value: string) => void;
  readonly onDismiss: () => void;
  /** host = independent BrowserWindow fills itself; inline = absolute under bar (legacy). */
  readonly layout?: 'host' | 'inline';
}

export {
  resolveQuickChatPopoverPosition,
  resolveQuickChatPopoverVisualSize,
} from './quickChatPopoverLayout.ts';

export function QuickChatPopover({ state, onSelect, onDismiss, layout = 'inline' }: QuickChatPopoverProps) {
  const shellRef = useRef<HTMLElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const previewFrameRef = useRef<number | null>(null);
  const pendingEffortValueRef = useRef(0);
  const selectedIndex = Math.max(0, state.items.findIndex((item) => item.value === state.selectedValue));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [previewIndex, setPreviewIndex] = useState(selectedIndex);

  const effortLevels = useMemo(
    () => state.items.map((item) => item.value).filter(isEffortLevel),
    [state.items],
  );
  const initialEffortValue = effortLevels.length <= 1 ? 0 : (selectedIndex / (effortLevels.length - 1)) * 100;
  const previewEffort = effortLevels[previewIndex]
    ?? (isEffortLevel(state.selectedValue) ? state.selectedValue : 'default');
  const size = resolveQuickChatPopoverVisualSize(state);
  // host window is already positioned by main; only inline layout needs DOM offsets.
  const position = layout === 'host' || !state.anchorRect
    ? { left: 0, top: 0 }
    : resolveQuickChatPopoverPosition({
        kind: state.kind,
        anchorRect: state.anchorRect,
        size,
      });
  const { left, top } = position;

  useEffect(() => {
    setActiveIndex(selectedIndex);
    setPreviewIndex(selectedIndex);
    pendingEffortValueRef.current = initialEffortValue;
    if (sliderRef.current) {
      sliderRef.current.value = String(initialEffortValue);
      sliderRef.current.style.setProperty('--effort-progress', `${initialEffortValue}%`);
    }
    const focusFrame = requestAnimationFrame(() => {
      (state.kind === 'effort' ? sliderRef.current : shellRef.current)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(focusFrame);
  }, [initialEffortValue, selectedIndex, state.kind]);

  useEffect(() => () => {
    if (previewFrameRef.current !== null) cancelAnimationFrame(previewFrameRef.current);
  }, []);

  const updateEffortPreview = (input: HTMLInputElement) => {
    pendingEffortValueRef.current = Number(input.value);
    if (previewFrameRef.current !== null) return;
    previewFrameRef.current = requestAnimationFrame(() => {
      previewFrameRef.current = null;
      const value = pendingEffortValueRef.current;
      input.style.setProperty('--effort-progress', `${value}%`);
      const nextIndex = effortIndexFromValue(value, effortLevels.length);
      setPreviewIndex((current) => current === nextIndex ? current : nextIndex);
    });
  };

  const selectEffortIndex = (index: number) => {
    const level = effortLevels[index];
    if (level) onSelect(level);
  };

  const shellStyle = (
    layout === 'host'
      ? { width: '100%', height: '100%', left: 0, top: 0, position: 'relative' }
      : { left, top, width: size.width, height: size.height }
  ) as CSSProperties;

  return (
    <main
      ref={shellRef}
      className={`quick-chat-popover-shell${layout === 'host' ? ' is-host' : ''}`}
      style={shellStyle}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onDismiss();
          return;
        }
        if (state.kind === 'effort') return;
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && state.items.length) {
          event.preventDefault();
          const direction = event.key === 'ArrowDown' ? 1 : -1;
          setActiveIndex((index) => (index + direction + state.items.length) % state.items.length);
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          const item = state.items[activeIndex];
          if (item) onSelect(item.value);
        }
      }}
    >
      {state.kind === 'effort' ? (
        <section className="quick-chat-effort-panel" aria-label="思考强度">
          <div className="quick-chat-effort-heading">
            <span>思考强度</span>
            <strong>{effortLabel(previewEffort, true)}</strong>
          </div>
          <input
            ref={sliderRef}
            type="range"
            className="quick-chat-effort-slider"
            min="0"
            max="100"
            step="0.01"
            defaultValue={initialEffortValue}
            style={{ '--effort-progress': `${initialEffortValue}%` } as CSSProperties}
            aria-label="思考强度"
            aria-valuetext={effortLabel(previewEffort, true)}
            onChange={(event) => updateEffortPreview(event.currentTarget)}
            onPointerUp={(event) => {
              const snapped = snapEffortValue(Number(event.currentTarget.value), effortLevels.length);
              event.currentTarget.value = String(snapped);
              event.currentTarget.style.setProperty('--effort-progress', `${snapped}%`);
              selectEffortIndex(effortIndexFromValue(snapped, effortLevels.length));
            }}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const currentIndex = effortIndexFromValue(Number(event.currentTarget.value), effortLevels.length);
              const nextIndex = event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? Math.max(0, effortLevels.length - 1)
                  : Math.min(
                    Math.max(0, effortLevels.length - 1),
                    Math.max(0, currentIndex + (event.key === 'ArrowRight' ? 1 : -1)),
                  );
              selectEffortIndex(nextIndex);
            }}
          />
        </section>
      ) : (
        <section className="quick-chat-popover-panel" role="listbox" aria-label="快速选择">
          {state.items.map((item, index) => {
            const selected = item.value === state.selectedValue;
            return (
              <button
                key={item.value}
                type="button"
                className={`quick-chat-popover-option${selected ? ' is-selected' : ''}${index === activeIndex ? ' is-active' : ''}`}
                role="option"
                aria-selected={selected}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => onSelect(item.value)}
              >
                <span className="quick-chat-popover-copy">
                  <strong>{item.label}</strong>
                  {item.detail ? <span>{item.detail}</span> : null}
                </span>
                {selected ? <span className="quick-chat-popover-check" aria-hidden="true">✓</span> : null}
              </button>
            );
          })}
        </section>
      )}
    </main>
  );
}
