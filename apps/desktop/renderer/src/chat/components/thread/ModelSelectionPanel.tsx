import './model-selection.css';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { InteractionLayerContext, useInteractionLayer } from '../../../app/hooks/useInteractionLayer';
import { isImeKey } from '../../state/compositionGuard';
import { selectionNavigation } from '../../../app/components/selectionNavigation';
import type { LlmProviderConfigView } from '@peer-agent/protocol';
import { PeerIcon } from '../../../ui/icons/PeerIcon';
import { effortLabel, effortShortLabel, isEffortLevel, type EffortLevel } from '../../state/preferences';
import {
  effortIndexForLevel,
  effortIndexFromValue,
  effortLevelForDisplay,
  snapEffortValue,
} from './effortSlider';
import {
  enabledModelCount,
  findSelectionModel,
  groupProviderModels,
  modelEffortLevels,
  supportsComposerFastMode,
  type SelectionProviderGroup,
} from './modelSelection';

function EffortRange({
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
  const committing = useRef(false), edited = useRef(false), cancelled = useRef(false);

  useEffect(() => {
    if (committing.current) return;
    setDragValue(selectedValue);
    setDirty(false); edited.current = false; cancelled.current = false;
  }, [selectedValue]);

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
      <div className="reasoning-effort-slider-shell">
        <div className="reasoning-effort-slider-track" aria-hidden="true">
          <div
            className="reasoning-effort-slider-fill"
            style={{
              width: `calc(var(--effort-thumb) / 2 + (100% - var(--effort-thumb)) * ${effectiveValue} / 100)`,
            }}
          />
        </div>
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
          className="reasoning-effort-slider"
          type="range"
          min="0"
          max="100"
          step="1"
          disabled={disabled}
          value={effectiveValue}
          aria-label={isZh ? '思考强度' : 'Reasoning effort'}
          aria-valuetext={fullLabel}
          style={{ '--effort-progress': `${effectiveValue}%` } as CSSProperties}
          onInput={(event) => {
            edited.current = true; cancelled.current = false; setDirty(true);
            setDragValue(Number(event.currentTarget.value));
          }}
          onChange={(event) => {
            edited.current = true; cancelled.current = false; setDirty(true);
            setDragValue(Number(event.currentTarget.value));
          }}
          onPointerUp={(event) => { commit(Number(event.currentTarget.value)); }}
          onPointerCancel={() => { cancelled.current = true; edited.current = false; setDirty(false); setDragValue(selectedValue); }}
          onKeyDown={event => {
            if (event.key === 'Escape' && !isImeKey(event) && edited.current) { event.preventDefault(); event.stopPropagation(); cancelled.current = true; edited.current = false; setDirty(false); setDragValue(selectedValue); }
          }}
          onKeyUp={(event) => {
            if (isImeKey(event) || event.defaultPrevented) return;
            if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') {
              commit(Number(event.currentTarget.value));
            }
          }}
          onBlur={(event) => { commit(Number(event.currentTarget.value)); }}
        />
      </div>
    </>
  );
}

function RequestChannelToggle({
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

export function ModelSelectionPanel({
  groups,
  selectedModelId,
  effort,
  fastMode,
  isZh,
  disabled = false,
  embedded = false,
  resetToken = 0,
  feedback,
  onSelectModel,
  onEffortChange,
  onFastModeChange,
  onManageModels,
  onDismiss,
}: {
  readonly groups: readonly SelectionProviderGroup[];
  readonly selectedModelId: string;
  readonly effort: EffortLevel;
  readonly fastMode: boolean;
  readonly isZh: boolean;
  readonly disabled?: boolean;
  readonly embedded?: boolean;
  /** Changes when the panel is opened again, so browsing starts from the committed provider. */
  readonly resetToken?: number;
  readonly feedback?: ReactNode;
  readonly onSelectModel: (modelId: string) => void;
  readonly onEffortChange: (level: EffortLevel) => void | Promise<unknown>;
  readonly onFastModeChange?: (enabled: boolean) => void;
  readonly onManageModels?: () => void;
  readonly onDismiss?: () => void;
}) {
  const selected = findSelectionModel(groups, selectedModelId);
  const modelId = selectedModelId, effortValue = effort, fast = fastMode;
  const [browsedId, setBrowsedId] = useState(selected?.group.id ?? groups[0]?.id ?? '');
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [menuBelow, setMenuBelow] = useState(embedded);
  const [activeModelIndex, setActiveModelIndex] = useState(-1);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const providerButtonRef = useRef<HTMLButtonElement | null>(null);
  const listId = useId();

  useEffect(() => {
    const match = findSelectionModel(groups, selectedModelId);
    setBrowsedId(match?.group.id ?? groups.find((group) => !group.disabled)?.id ?? groups[0]?.id ?? '');
    setProviderMenuOpen(false);
    setActiveModelIndex(-1);
    // Browse state is local. Reset only when the committed model or a fresh open changes.
    // `groups` is read from this render; listing it would close the provider menu on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetToken, selectedModelId]);

  const browsed = groups.find((group) => group.id === browsedId) ?? selected?.group ?? groups[0];
  const activeModel = findSelectionModel(groups, modelId)?.model;
  const selectionVisible = Boolean(browsed && activeModel && browsed.models.some((model) => model.id === activeModel.id));
  const effortLevels = selectionVisible ? modelEffortLevels(activeModel) : [];
  const fastAvailable = selectionVisible && supportsComposerFastMode(activeModel?.authMethod) && Boolean(onFastModeChange);

  useLayoutEffect(() => {
    if (!providerMenuOpen || embedded) {
      setMenuBelow(embedded);
      return;
    }
    const rect = panelRef.current?.getBoundingClientRect();
    setMenuBelow(Boolean(rect && rect.left < 200));
  }, [embedded, providerMenuOpen]);

  const chooseProvider = (group: SelectionProviderGroup) => {
    if (group.disabled || disabled) return;
    setProviderMenuOpen(false);
    setActiveModelIndex(-1);
    setBrowsedId(group.id);
    providerButtonRef.current?.focus({ preventScroll: true });
  };

  const chooseModel = (nextId: string) => {
    if (disabled) return;
    const match = findSelectionModel(groups, nextId);
    if (!match || match.model.disabled || match.group.disabled) return;
    // The owner commits model + compatible effort together; browsing never writes.
    onSelectModel(nextId);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || isImeKey(event)) return;
    if (event.key === 'Escape' && providerMenuOpen) {
      event.preventDefault(); event.stopPropagation(); setProviderMenuOpen(false); providerButtonRef.current?.focus(); return;
    }
    if (disabled) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, .reasoning-request-channel, .model-selection-manage')) return;
    if (target === providerButtonRef.current && !providerMenuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setProviderMenuOpen(true); }
      return;
    }
    const items = providerMenuOpen ? groups : browsed?.models ?? [];
    const current = providerMenuOpen ? groups.findIndex(group => group.id === browsedId) : activeModelIndex;
    const index = selectionNavigation(items.map(item => ({ disabled: item.disabled || disabled })), current, event.key, 'vertical');
    if (index !== null) {
      event.preventDefault();
      if (providerMenuOpen) {
        setBrowsedId(groups[index].id);
        panelRef.current?.querySelector<HTMLElement>(`[data-provider-index="${index}"]`)?.focus({ preventScroll: true });
      } else {
        setActiveModelIndex(index);
        panelRef.current?.querySelector<HTMLElement>(`[data-model-index="${index}"]`)?.focus({ preventScroll: true });
      }
    }
  };

  return (
    <div
      ref={panelRef}
      className={`model-selection-panel${embedded ? ' is-embedded' : ''}${providerMenuOpen ? ' is-provider-open' : ''}`}
      role="dialog"
      aria-label={isZh ? '选择模型' : 'Choose model'}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <button
        ref={providerButtonRef}
        type="button"
        className="model-selection-provider"
        aria-haspopup="listbox"
        aria-expanded={providerMenuOpen}
        aria-controls={providerMenuOpen ? listId : undefined}
        disabled={disabled || groups.length === 0}
        onClick={() => setProviderMenuOpen((open) => !open)}
      >
        <span className="model-selection-provider-name">{browsed?.label || (isZh ? '选择提供商' : 'Choose a provider')}</span>
        <PeerIcon name="chevronRight" size={14} className="model-selection-provider-chevron" />
      </button>
      {providerMenuOpen ? (
        <div
          id={listId}
          className={`model-selection-provider-menu motion-enter-fade${menuBelow ? ' is-below' : ''}`}
          role="listbox"
          aria-label={isZh ? '提供商' : 'Provider'}
        >
          {groups.map((group, index) => {
            const selectedGroup = group.models.some((model) => model.id === modelId);
            return (
              <button
                key={group.id}
                type="button"
                role="option"
                data-provider-index={index}
                tabIndex={group.id === browsedId ? 0 : -1}
                aria-selected={selectedGroup}
                className={`model-selection-provider-option${group.id === browsedId ? ' is-active' : ''}${selectedGroup ? ' is-selected' : ''}`}
                disabled={group.disabled || disabled}
                onClick={() => chooseProvider(group)}
              >
                <span>{group.label}</span>
                {selectedGroup ? <PeerIcon name="check" size={14} /> : null}
              </button>
            );
          })}
          {onManageModels ? (
            <button type="button" className="model-selection-manage" onClick={onManageModels}>
              <PeerIcon name="settings" size={14} />
              <span>{isZh ? '管理模型' : 'Manage models'}</span>
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="model-selection-section-label">{isZh ? '模型' : 'Models'}</div>
      {!browsed?.models.some(model => !model.disabled) ? <p className="ui-form-feedback">{isZh ? '当前没有可选模型，请检查服务连接与模型范围。' : 'No model is available. Check the service connection and model scope.'}</p> : null}
      <div className="model-selection-models" role="listbox" aria-label={isZh ? '模型' : 'Models'}>
        {(browsed?.models ?? []).map((model, index) => {
          const selectedRow = model.id === modelId;
          return (
            <button
              key={model.id}
              type="button"
              role="option"
              data-model-index={index}
              tabIndex={(activeModelIndex >= 0 ? index === activeModelIndex : selectedRow || !browsed?.models.some(item => item.id === modelId && !item.disabled) && index === browsed?.models.findIndex(item => !item.disabled)) ? 0 : -1}
              onFocus={() => setActiveModelIndex(index)}
              aria-selected={selectedRow}
              className={`model-selection-model${selectedRow ? ' is-selected' : ''}${index === activeModelIndex ? ' is-active' : ''}`}
              disabled={model.disabled || disabled}
              onMouseEnter={() => { if (!model.disabled) setActiveModelIndex(index); }}
              onClick={() => chooseModel(model.id)}
            >
              <span className="model-selection-model-label">{model.label}</span>
              {model.supportsVision ? (
                <span className="model-selection-badge">{isZh ? '视觉' : 'Vision'}</span>
              ) : null}
              {selectedRow ? <PeerIcon name="check" size={14} className="model-selection-check" /> : null}
            </button>
          );
        })}
      </div>
      {effortLevels.length > 1 || fastAvailable ? (
        <div className="model-selection-effort">
          {effortLevels.length > 1 ? (
            <EffortRange
              effort={effortLevels.includes(effortValue) ? effortValue : effortLevels[0] ?? effortValue}
              levels={effortLevels}
              isZh={isZh}
              disabled={disabled}
              onChange={(level) => {
                return onEffortChange(level);
              }}
            />
          ) : null}
          {fastAvailable ? (
            <RequestChannelToggle
              fastMode={fast}
              isZh={isZh}
              disabled={disabled}
              onChange={(enabled) => {
                onFastModeChange?.(enabled);
              }}
            />
          ) : null}
        </div>
      ) : null}
      {feedback}
    </div>
  );
}

export function AnchoredModelSelectionMenu({
  groups,
  selectedModelId,
  effort,
  fastMode = false,
  isZh,
  disabled = false,
  selectionDisabled = false,
  busy = false,
  statusLabel,
  feedback,
  label,
  title,
  className,
  onSelectModel,
  onEffortChange,
  onFastModeChange,
  onManageModels,
}: {
  readonly groups: readonly SelectionProviderGroup[];
  readonly selectedModelId: string;
  readonly effort: EffortLevel;
  readonly fastMode?: boolean;
  readonly isZh: boolean;
  readonly disabled?: boolean;
  /** Keep the menu available for status/recovery while selection is locked. */
  readonly selectionDisabled?: boolean;
  readonly busy?: boolean;
  readonly statusLabel?: string;
  readonly feedback?: ReactNode;
  readonly label: string;
  readonly title?: string;
  readonly className?: string;
  readonly onSelectModel: (modelId: string) => void;
  readonly onEffortChange: (level: EffortLevel) => void | Promise<unknown>;
  readonly onFastModeChange?: (enabled: boolean) => void;
  readonly onManageModels?: () => void;
}) {
  const selected = findSelectionModel(groups, selectedModelId);
  const fastAvailable = supportsComposerFastMode(selected?.model.authMethod) && Boolean(onFastModeChange);
  const effortLevels = modelEffortLevels(selected?.model);
  const shortEffort = effortLevels.length > 1 && (effortLevels.includes(effort) || isEffortLevel(effort))
    ? effortShortLabel(effortLevels.includes(effort) ? effort : effortLevels[0], isZh)
    : '';
  const [open, setOpen] = useState(false);
  const [resetToken, setResetToken] = useState(0);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const rect = trigger.getBoundingClientRect();
      const gap = 6;
      const margin = 8;
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      let top = rect.top - height - gap;
      if (top < margin) top = Math.min(rect.bottom + gap, window.innerHeight - height - margin);
      const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin));
      setCoords((current) => current?.left === left && current.top === top ? current : { left, top });
    };
    updatePosition();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePosition);
    if (triggerRef.current) observer?.observe(triggerRef.current);
    if (panelRef.current) observer?.observe(panelRef.current);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  const layer = useInteractionLayer(open, { roots: [panelRef], trigger: triggerRef, outside: true, dismissOnTab: true, closeOnTriggerRemoval: true,
    onClose: () => setOpen(false),
    onEscape: () => {
      const provider = panelRef.current?.querySelector<HTMLElement>('.model-selection-provider[aria-expanded="true"]');
      if (!provider) return false;
      provider.click(); provider.focus({ preventScroll: true }); return true;
    },
    onEnter: () => {
      const panel = panelRef.current;
      (panel?.querySelector<HTMLElement>('.model-selection-model[aria-selected="true"]:not(:disabled)')
        ?? panel?.querySelector<HTMLElement>('button:not(:disabled)')
        ?? panel?.querySelector<HTMLElement>('.model-selection-panel'))?.focus({ preventScroll: true });
    },
  });

  return (
    <div ref={rootRef} className={className ?? 'model-selection-control composer-cascading-menu composer-model-dropdown'}>
      <button
        ref={triggerRef}
        type="button"
        className={`pa-cascading-trigger model-selection-trigger${open ? ' open' : ''}`}
        aria-disabled={disabled || undefined}
        aria-busy={busy || undefined}
        title={statusLabel ? `${title || label} · ${statusLabel}` : title}
        aria-label={[title || label, statusLabel].filter(Boolean).join(' · ')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          if (disabled) return;
          setOpen((value) => {
            if (!value) setResetToken((token) => token + 1);
            return !value;
          });
        }}
      >
        <span className="pa-cascading-value">
          {fastAvailable && fastMode ? (
            <PeerIcon name="bolt" size={12} className="model-selection-fast-mark" fill="currentColor" stroke="none" />
          ) : null}
          <span className="model-selection-trigger-label">{label}</span>
          {shortEffort ? <span className="model-selection-trigger-effort">{shortEffort}</span> : null}
        </span>
        {busy ? <PeerIcon name="loader" size={12} className="pa-cascading-caret motion-spin" /> : statusLabel
          ? <PeerIcon name="warning" size={12} className="pa-cascading-caret" />
          : <PeerIcon name="chevronDown" size={12} className={`pa-cascading-caret${open ? ' is-open' : ''}`} />}
      </button>
      {open ? createPortal(
        <InteractionLayerContext.Provider value={layer}><div id={panelId} ref={panelRef} className="model-selection-popover motion-enter-rise" style={coords ? { left: coords.left, top: coords.top, visibility: 'visible' } : undefined}>
          <ModelSelectionPanel
            groups={groups}
            selectedModelId={selectedModelId}
            effort={isEffortLevel(effort) ? effort : 'default'}
            fastMode={fastMode}
            isZh={isZh}
            disabled={disabled || selectionDisabled || busy}
            feedback={feedback}
            resetToken={resetToken}
            onSelectModel={onSelectModel}
            onEffortChange={onEffortChange}
            onFastModeChange={onFastModeChange}
            onManageModels={onManageModels ? () => { setOpen(false); onManageModels(); } : undefined}
            onDismiss={() => {
              setOpen(false);
            }}
          />
        </div></InteractionLayerContext.Provider>,
        document.body,
      ) : null}
    </div>
  );
}

export function ComposerModelMenu({
  providers,
  selectedModelId,
  effort,
  fastMode,
  isZh,
  disabled = false,
  title,
  onSelectModel,
  onEffortChange,
  onFastModeChange,
  onManageModels,
}: {
  readonly providers: readonly LlmProviderConfigView[];
  readonly selectedModelId: string | null;
  readonly effort: EffortLevel;
  readonly fastMode: boolean;
  readonly isZh: boolean;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly onSelectModel: (modelId: string) => void;
  readonly onEffortChange: (level: EffortLevel) => void | Promise<unknown>;
  readonly onFastModeChange?: (enabled: boolean) => void;
  readonly onManageModels?: () => void;
}) {
  const groups = useMemo(() => groupProviderModels(providers, isZh), [isZh, providers]);
  const selected = selectedModelId ? findSelectionModel(groups, selectedModelId) : null;
  const model = selected?.model;
  const effortLevels = modelEffortLevels(model);
  const fastAvailable = supportsComposerFastMode(model?.authMethod) && Boolean(onFastModeChange);
  const interactive = Boolean(model) && (enabledModelCount(groups) > 1 || effortLevels.length > 1 || fastAvailable);
  const label = model?.label || (isZh ? '选择模型' : 'Choose a model');
  const effortText = effortLevels.includes(effort) ? effortLabel(effort, isZh) : '';
  const tooltip = [selected?.group.label, model?.label, effortText].filter(Boolean).join(' · ') || title;
  if (!model) return null;
  if (!interactive) return <span className="token-usage-model" title={tooltip}>{label}</span>;
  return (
    <AnchoredModelSelectionMenu
      groups={groups}
      selectedModelId={selectedModelId ?? model.id}
      effort={effort}
      fastMode={fastMode}
      isZh={isZh}
      disabled={disabled}
      label={label}
      title={tooltip}
      onSelectModel={onSelectModel}
      onEffortChange={onEffortChange}
      onFastModeChange={onFastModeChange}
      onManageModels={onManageModels}
    />
  );
}
