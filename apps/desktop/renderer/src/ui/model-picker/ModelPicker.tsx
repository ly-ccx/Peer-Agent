import './model-selection.css';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MotionSurface } from '../../app/components/MotionSurface';
import { InteractionLayerContext, useInteractionLayer } from '../../app/hooks/useInteractionLayer';
import { selectionNavigation } from '../../app/components/selectionNavigation';
import { isImeKey } from '../../chat/state/compositionGuard';
import { effortShortLabel, isEffortLevel, type EffortLevel } from '../../chat/state/preferences';
import { PeerIcon } from '../icons/PeerIcon';
import { useModelSelectionPosition } from './useModelSelectionPosition';
import { useModelSelectionTransition } from './useModelSelectionTransition';
import { EffortRange, RequestChannelToggle } from './ModelParameters';
import { findSelectionModel, modelEffortLevels, supportsComposerFastMode, type SelectionProviderGroup } from './modelSelection';

export function ModelSelectionPanel({
  groups,
  selectedModelId = '',
  selectedModelIds,
  effort = 'default',
  fastMode = false,
  isZh,
  disabled = false,
  selectionDisabled = false,
  embedded = false,
  resetToken = 0,
  feedback,
  emptyLabel,
  onSelectModel,
  onEffortChange,
  onFastModeChange,
  onManageModels,
  onDismiss,
}: {
  readonly groups: readonly SelectionProviderGroup[];
  readonly selectedModelId?: string;
  /** Supplying this collection enables controlled multi-selection. */
  readonly selectedModelIds?: readonly string[];
  readonly effort?: EffortLevel;
  readonly fastMode?: boolean;
  readonly isZh: boolean;
  readonly disabled?: boolean;
  /** Lock writes while preserving the current list and provider browsing. */
  readonly selectionDisabled?: boolean;
  readonly embedded?: boolean;
  /** Changes when the panel is opened again, so browsing starts from the committed provider. */
  readonly resetToken?: number;
  readonly feedback?: ReactNode;
  readonly emptyLabel?: string;
  readonly onSelectModel: (modelId: string) => void | Promise<unknown>;
  readonly onEffortChange?: (level: EffortLevel) => void | Promise<unknown>;
  readonly onFastModeChange?: (enabled: boolean) => void;
  readonly onManageModels?: () => void;
  readonly onDismiss?: () => void;
}) {
  const selected = findSelectionModel(groups, selectedModelId || selectedModelIds?.[0] || '');
  const modelId = selectedModelId, effortValue = effort, fast = fastMode;
  const multiple = selectedModelIds !== undefined;
  const checkedIds = new Set(selectedModelIds ?? [modelId]);
  const [browsedId, setBrowsedId] = useState(selected?.group.id ?? groups[0]?.id ?? '');
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [menuBelow, setMenuBelow] = useState(embedded);
  const [activeModelIndex, setActiveModelIndex] = useState(-1);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const providerButtonRef = useRef<HTMLButtonElement | null>(null);
  const listId = useId();

  useEffect(() => {
    const match = findSelectionModel(groups, selectedModelId || selectedModelIds?.[0] || '');
    setBrowsedId(match?.group.id ?? groups.find((group) => !group.disabled)?.id ?? groups[0]?.id ?? '');
    setProviderMenuOpen(false);
    setActiveModelIndex(-1);
    // Browse state is local. Reset only when the committed model or a fresh open changes.
    // `groups` is read from this render; listing it would close the provider menu on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetToken, selectedModelId]);

  const browsed = groups.find((group) => group.id === browsedId) ?? selected?.group ?? groups[0];
  const rows = browsed?.models ?? [];
  const rowsDisabled = disabled || browsed?.disabled === true;
  const firstSelected = rows.findIndex(item => checkedIds.has(item.id) && !item.disabled);
  const tabStop = activeModelIndex >= 0 ? activeModelIndex : firstSelected >= 0 ? firstSelected : rows.findIndex(item => !item.disabled);
  const activeModel = findSelectionModel(groups, modelId)?.model;
  const selectionVisible = Boolean(browsed && activeModel && browsed.models.some((model) => model.id === activeModel.id));
  const effortLevels = selectionVisible && !multiple && onEffortChange ? modelEffortLevels(activeModel) : [];
  const fastAvailable = selectionVisible && !multiple && supportsComposerFastMode(activeModel?.authMethod) && Boolean(onFastModeChange);
  useModelSelectionTransition(panelRef, bodyRef, browsed?.id, modelId, effortLevels.length, fastAvailable, embedded);

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
    if (!multiple && group.id !== selected?.group.id) {
      const firstModel = group.models.find((model) => !model.disabled);
      if (firstModel) chooseModel(firstModel.id);
    }
  };

  const chooseModel = (nextId: string) => {
    if (disabled || selectionDisabled) return;
    const match = findSelectionModel(groups, nextId);
    if (!match || match.model.disabled || match.group.disabled) return;
    // Explicit provider/model selection uses the same owner commit; keyboard browsing alone never writes.
    void onSelectModel(nextId);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || isImeKey(event)) return;
    if (event.key === 'Escape' && providerMenuOpen) {
      event.preventDefault(); event.stopPropagation(); setProviderMenuOpen(false); providerButtonRef.current?.focus(); return;
    }
    if (event.key === 'Escape' && onDismiss) {
      event.preventDefault(); event.stopPropagation(); onDismiss(); return;
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
    const index = selectionNavigation(items.map(item => ({ disabled: item.disabled || (providerMenuOpen ? disabled : rowsDisabled) })), current, event.key, 'vertical');
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
      aria-busy={selectionDisabled || undefined}
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
      <MotionSurface kind="fade">{providerMenuOpen ? (
        <div
          id={listId}
          className={`model-selection-provider-menu motion-enter-fade${menuBelow ? ' is-below' : ''}`}
          role="listbox"
          aria-label={isZh ? '提供商' : 'Provider'}
        >
          {groups.map((group, index) => {
            const selectedGroup = group.models.some((model) => checkedIds.has(model.id));
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
      ) : null}</MotionSurface>
      <div ref={bodyRef} className="model-selection-body">
      <div className="model-selection-section-label">{isZh ? '模型' : 'Models'}</div>
      {browsed?.disabled || !rows.some(model => !model.disabled) ? <p className="ui-form-feedback">{emptyLabel ?? (isZh ? '当前没有可选模型，请检查服务连接与模型范围。' : 'No model is available. Check the service connection and model scope.')}</p> : null}
      <div className="model-selection-models" role="listbox" aria-multiselectable={multiple || undefined} aria-label={isZh ? '模型' : 'Models'}>
        {rows.map((model, index) => {
          const selectedRow = checkedIds.has(model.id);
          return (
            <button
              key={model.id}
              type="button"
              role="option"
              data-model-index={index}
              tabIndex={index === tabStop ? 0 : -1}
              onFocus={() => setActiveModelIndex(index)}
              aria-selected={selectedRow}
              aria-disabled={selectionDisabled || undefined}
              className={`model-selection-model${selectedRow ? ' is-selected' : ''}${index === activeModelIndex ? ' is-active' : ''}`}
              disabled={model.disabled || rowsDisabled}
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
              disabled={disabled || selectionDisabled}
              onChange={(level) => {
                return onEffortChange?.(level);
              }}
            />
          ) : null}
          {fastAvailable ? (
            <RequestChannelToggle
              fastMode={fast}
              isZh={isZh}
              disabled={disabled || selectionDisabled}
              onChange={(enabled) => {
                onFastModeChange?.(enabled);
              }}
            />
          ) : null}
        </div>
      ) : null}
      </div>
      {feedback}
    </div>
  );
}

export function ModelPicker({
  groups,
  selectedModelId = '',
  selectedModelIds,
  effort = 'default',
  fastMode = false,
  isZh,
  disabled = false,
  selectionDisabled = false,
  busy = false,
  statusLabel,
  feedback,
  emptyLabel,
  label,
  title,
  className,
  variant = 'compact',
  ariaLabel,
  ariaDescribedBy,
  onSelectModel,
  onEffortChange,
  onFastModeChange,
  onManageModels,
}: {
  readonly groups: readonly SelectionProviderGroup[];
  readonly selectedModelId?: string;
  /** Supplying this collection enables controlled multi-selection. */
  readonly selectedModelIds?: readonly string[];
  readonly effort?: EffortLevel;
  readonly fastMode?: boolean;
  readonly isZh: boolean;
  readonly disabled?: boolean;
  /** Keep the menu available for status/recovery while selection is locked. */
  readonly selectionDisabled?: boolean;
  readonly busy?: boolean;
  readonly statusLabel?: string;
  readonly feedback?: ReactNode;
  readonly emptyLabel?: string;
  readonly label: string;
  readonly title?: string;
  readonly className?: string;
  readonly variant?: 'compact' | 'field';
  readonly ariaLabel?: string;
  readonly ariaDescribedBy?: string;
  readonly onSelectModel: (modelId: string) => void | Promise<unknown>;
  readonly onEffortChange?: (level: EffortLevel) => void | Promise<unknown>;
  readonly onFastModeChange?: (enabled: boolean) => void;
  readonly onManageModels?: () => void;
}) {
  const selected = findSelectionModel(groups, selectedModelId || selectedModelIds?.[0] || '');
  const fastAvailable = !selectedModelIds && supportsComposerFastMode(selected?.model.authMethod) && Boolean(onFastModeChange);
  const effortLevels = onEffortChange && !selectedModelIds ? modelEffortLevels(selected?.model) : [];
  const shortEffort = effortLevels.length > 1 && (effortLevels.includes(effort) || isEffortLevel(effort))
    ? effortShortLabel(effortLevels.includes(effort) ? effort : effortLevels[0], isZh)
    : '';
  const [open, setOpen] = useState(false);
  const [resetToken, setResetToken] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  const panelStyle = useModelSelectionPosition(open, triggerRef, panelRef);

  useLayoutEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

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
    <div ref={rootRef} className={`model-selection-control is-${variant} ${className ?? ''}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        className={`pa-cascading-trigger model-selection-trigger${open ? ' open' : ''}`}
        aria-disabled={disabled || undefined}
        aria-busy={busy || undefined}
        title={statusLabel ? `${title || label} · ${statusLabel}` : title}
        aria-label={[ariaLabel ? `${ariaLabel}: ${label}` : title || label, statusLabel].filter(Boolean).join(' · ')}
        aria-describedby={ariaDescribedBy}
        aria-haspopup={disabled ? undefined : 'dialog'}
        aria-expanded={disabled ? undefined : open}
        aria-controls={disabled ? undefined : panelId}
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
        {disabled ? null : busy ? <PeerIcon name="loader" size={12} className="pa-cascading-caret motion-spin" /> : statusLabel
          ? <PeerIcon name="warning" size={12} className="pa-cascading-caret" />
          : <PeerIcon name="chevronDown" size={12} className={`pa-cascading-caret${open ? ' is-open' : ''}`} />}
      </button>
      {createPortal(<InteractionLayerContext.Provider value={layer}><MotionSurface>{open ? (<div id={panelId} ref={panelRef} className="model-selection-popover" style={panelStyle}>
          <ModelSelectionPanel
            groups={groups}
            selectedModelId={selectedModelId}
            selectedModelIds={selectedModelIds}
            effort={isEffortLevel(effort) ? effort : 'default'}
            fastMode={fastMode}
            isZh={isZh}
            disabled={disabled}
            selectionDisabled={selectionDisabled || busy}
            feedback={feedback}
            emptyLabel={emptyLabel}
            resetToken={resetToken}
            onSelectModel={onSelectModel}
            onEffortChange={onEffortChange}
            onFastModeChange={onFastModeChange}
            onManageModels={onManageModels ? () => { setOpen(false); onManageModels(); } : undefined}
            onDismiss={() => {
              setOpen(false);
            }}
          />
        </div>) : null}</MotionSurface></InteractionLayerContext.Provider>, document.body)}
    </div>
  );
}
