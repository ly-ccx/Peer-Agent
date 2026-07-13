import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { clientApi } from '../../clientApi';
import { effortIndexForLevel, effortIndexFromValue, snapEffortValue } from '../../chat/components/thread/effortSlider';
import { effortLabel, isEffortLevel, type EffortLevel } from '../../chat/state/preferences';
import type { QuickChatPopoverState } from '../../preload/contracts/bootstrapPreloadApi';

const EMPTY_STATE: QuickChatPopoverState = {
  kind: 'workspace',
  items: [],
  selectedValue: '',
};

export function QuickChatPopover() {
  const [state, setState] = useState<QuickChatPopoverState>(EMPTY_STATE);
  const [activeIndex, setActiveIndex] = useState(0);
  const [effortValue, setEffortValue] = useState(0);

  useEffect(() => clientApi.onQuickChatPopoverState((next) => {
    setState(next);
    const nextIndex = Math.max(0, next.items.findIndex((item) => item.value === next.selectedValue));
    setActiveIndex(nextIndex);
    setEffortValue(next.items.length <= 1 ? 0 : (nextIndex / (next.items.length - 1)) * 100);
  }), []);

  const effortLevels = useMemo(
    () => state.items.map((item) => item.value).filter(isEffortLevel),
    [state.items],
  );
  const effortIndex = effortIndexFromValue(effortValue, effortLevels.length);
  const previewEffort = effortLevels[effortIndex] ?? (isEffortLevel(state.selectedValue) ? state.selectedValue : 'default');

  const select = (value: string) => {
    void clientApi.quickChatSelectPopoverValue(value);
  };

  return (
    <main
      className="quick-chat-popover-shell"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          void clientApi.quickChatHidePopover();
          return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const direction = event.key === 'ArrowDown' ? 1 : -1;
          setActiveIndex((index) => (index + direction + state.items.length) % state.items.length);
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          const item = state.items[activeIndex];
          if (item) select(item.value);
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
            type="range"
            className="quick-chat-effort-slider"
            min="0"
            max="100"
            step="0.01"
            value={effortValue}
            style={{ '--effort-progress': `${effortValue}%` } as CSSProperties}
            aria-label="思考强度"
            aria-valuetext={effortLabel(previewEffort, true)}
            onChange={(event) => setEffortValue(Number(event.currentTarget.value))}
            onPointerUp={(event) => {
              const snapped = snapEffortValue(Number(event.currentTarget.value), effortLevels.length);
              setEffortValue(snapped);
              const level = effortLevels[effortIndexFromValue(snapped, effortLevels.length)];
              if (level) select(level);
            }}
            onKeyUp={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
              const level = effortLevels[effortIndexForLevel(previewEffort as EffortLevel, effortLevels)];
              if (level) select(level);
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
              onClick={() => select(item.value)}
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
