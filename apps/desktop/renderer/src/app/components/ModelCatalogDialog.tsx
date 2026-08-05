import type { I18nRuntime } from '@peer-agent/i18n';
import type { LlmModelInfo, LlmModelListResult, LlmProviderConfigView } from '@peer-agent/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LlmBrandIcon } from './LlmBrandIcon';
import { Overlay } from './Overlay';
import {
  buildModelCatalog,
  calculateModelSelectionChanges,
  filterModelCatalog,
  modelContextWindowRange,
  type ModelMetadataSource,
} from './llmModelConfiguration';

function compactTokens(value: number | undefined): string | null {
  if (!value) return null;
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`;
  return String(value);
}

function sourceLabel(source: LlmModelListResult['source'], zh: boolean): string {
  if (source === 'builtin') return zh ? '内置目录' : 'Built-in catalog';
  if (source === 'local') return zh ? '本机目录' : 'Local catalog';
  if (source === 'fallback') return zh ? '兜底目录' : 'Fallback catalog';
  return zh ? '远程目录' : 'Remote catalog';
}

export function ModelCatalogDialog({
  i18n,
  providerName,
  models,
  configuredModels,
  source,
  loading,
  error,
  onRefresh,
  onImport,
  selectionMode = 'multiple',
  allowManualModel = false,
  onClose,
  onAppliedClose,
}: {
  readonly i18n: I18nRuntime;
  readonly providerName: string;
  readonly models: readonly LlmModelInfo[];
  readonly configuredModels: readonly LlmProviderConfigView[];
  readonly source?: LlmModelListResult['source'];
  readonly loading: boolean;
  readonly error?: string;
  readonly onRefresh: () => void;
  readonly onImport: (
    models: readonly LlmModelInfo[],
    sourceOverride?: ModelMetadataSource,
  ) => Promise<readonly LlmProviderConfigView[] | void>;
  readonly selectionMode?: 'single' | 'multiple';
  readonly allowManualModel?: boolean;
  readonly onClose: () => void;
  readonly onAppliedClose?: () => void;
}) {
  const zh = i18n.locale === 'zh-CN';
  const [query, setQuery] = useState('');
  const configuredIds = useMemo(
    () => new Set(configuredModels.map((model) => model.model)),
    [configuredModels],
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(configuredModels.map((model) => model.model)),
  );
  const [importing, setImporting] = useState(false);
  const [applyState, setApplyState] = useState<'idle' | 'applying' | 'success'>('idle');
  const appliedSuccessfullyRef = useRef(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [manualModel, setManualModel] = useState('');
  const [importedModels, setImportedModels] = useState<readonly LlmProviderConfigView[]>(configuredModels);
  const [showFetchComplete, setShowFetchComplete] = useState(false);
  const wasLoadingRef = useRef(loading);
  const catalog = useMemo(() => buildModelCatalog(models, importedModels), [models, importedModels]);
  const visible = useMemo(() => filterModelCatalog(catalog, query), [catalog, query]);
  const isInitialLoading = loading && catalog.length === 0;
  const isRefreshing = loading && catalog.length > 0;
  const fetchState = isInitialLoading ? 'initial-loading' : isRefreshing ? 'refreshing' : showFetchComplete ? 'complete' : 'idle';
  useEffect(() => {
    setImportedModels(configuredModels);
    setSelected(new Set(configuredModels.map((model) => model.model)));
  }, [configuredModels]);
  useEffect(() => {
    const justCompleted = wasLoadingRef.current && !loading && !error;
    wasLoadingRef.current = loading;
    if (!justCompleted) {
      if (loading || error) setShowFetchComplete(false);
      return undefined;
    }
    setShowFetchComplete(true);
    const timer = window.setTimeout(() => setShowFetchComplete(false), 1200);
    return () => window.clearTimeout(timer);
  }, [error, loading]);
  const catalogIds = new Set(catalog.map((entry) => entry.model.id));
  const selectedModels = [
    ...catalog.filter((entry) => selected.has(entry.model.id)).map((entry) => entry.model),
    ...configuredModels
      .filter((model) => selected.has(model.model) && !catalogIds.has(model.model))
      .map((model) => ({ id: model.model, label: model.modelLabel || model.model })),
  ];
  const selectionChanges = calculateModelSelectionChanges(selectedModels, importedModels);
  const hasSelectionChanges = selectionChanges.additions.length > 0
    || selectionChanges.updates.length > 0
    || selectionChanges.removals.length > 0;
  const wouldRemoveAll = configuredModels.length > 0 && selectedModels.length === 0;

  const toggle = (id: string) => {
    setSelected((current) => {
      if (selectionMode === 'single') return current.has(id) ? new Set() : new Set([id]);
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const importSelected = async (requestClose: () => void) => {
    if (wouldRemoveAll) {
      setImportError(zh ? '渠道至少需要保留一个模型。' : 'A provider must keep at least one model.');
      return;
    }
    if (!hasSelectionChanges) return;
    setImporting(true);
    setApplyState('applying');
    setImportError(null);
    try {
      const imported = await onImport(selectedModels);
      if (imported) setImportedModels(imported);
      appliedSuccessfullyRef.current = true;
      setApplyState('success');
      window.setTimeout(requestClose, 420);
    } catch (error: unknown) {
      setApplyState('idle');
      setImportError(error instanceof Error ? error.message : 'model_import_failed');
      setImporting(false);
    }
  };

  const importManualModel = async () => {
    const id = manualModel.trim();
    if (!id) return;
    setImporting(true);
    setImportError(null);
    try {
      const imported = await onImport([{ id, label: id }], 'manual');
      if (imported) setImportedModels(imported);
      setManualModel('');
    } catch (error: unknown) {
      setImportError(error instanceof Error ? error.message : 'model_import_failed');
    } finally {
      setImporting(false);
    }
  };

  return (
    <Overlay
      onClose={() => {
        if (appliedSuccessfullyRef.current) (onAppliedClose ?? onClose)();
        else onClose();
      }}
      closeOnBackdrop={!importing}
      ariaLabel={zh ? '获取模型列表' : 'Import models'}
      panelClassName={`llm-catalog-dialog is-${applyState}`}
    >
      {({ requestClose }) => (
        <>
          <header className="llm-dialog-header">
            <div>
              <h3>{zh ? '获取模型列表' : 'Import models'}</h3>
              <p>{providerName} · {sourceLabel(source, zh)}</p>
            </div>
            <button type="button" className="llm-dialog-close" onClick={requestClose} aria-label={zh ? '关闭' : 'Close'}>✕</button>
          </header>

          <div className="llm-catalog-toolbar" data-fetch-state={fetchState}>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={zh ? '搜索 Model ID 或名称' : 'Search model ID or name'}
              autoFocus
              disabled={isInitialLoading}
            />
            <button type="button" onClick={onRefresh} disabled={loading} aria-busy={loading}>
              {loading ? <span className="llm-catalog-fetch-spinner motion-spin" aria-hidden="true" /> : null}
              {isInitialLoading
                ? (zh ? '正在拉取' : 'Loading')
                : isRefreshing
                  ? (zh ? '正在刷新' : 'Refreshing')
                  : showFetchComplete
                    ? (zh ? '已更新' : 'Updated')
                    : (zh ? '刷新目录' : 'Refresh')}
            </button>
          </div>

          <div className="llm-catalog-fetch-status" role="status" aria-live="polite" data-fetch-state={fetchState}>
            {isRefreshing ? (zh ? '正在后台刷新，当前模型列表仍可浏览。' : 'Refreshing in the background; the current list remains available.') : null}
            {showFetchComplete ? (zh ? `模型目录已更新，共 ${catalog.length} 个模型。` : `Model catalog updated with ${catalog.length} models.`) : null}
          </div>

          {error ? <p className="llm-catalog-error">{error}</p> : null}
          {importError ? <p className="llm-catalog-error">{importError}</p> : null}
          <div className="llm-catalog-summary">
            <span>{zh ? `发现 ${catalog.length} 个模型` : `${catalog.length} models found`}</span>
            {selectionMode === 'multiple' ? (
              <button
                type="button"
                onClick={() => {
                  const visibleIds = new Set(visible.map((entry) => entry.model.id));
                  const allVisibleSelected = visibleIds.size > 0 && [...visibleIds].every((id) => selected.has(id));
                  setSelected((current) => {
                    const next = new Set(current);
                    for (const id of visibleIds) {
                      if (allVisibleSelected) next.delete(id);
                      else next.add(id);
                    }
                    return next;
                  });
                }}
                disabled={visible.length === 0}
              >
                {visible.length > 0 && visible.every((entry) => selected.has(entry.model.id))
                  ? (zh ? '取消当前筛选' : 'Deselect filtered')
                  : (zh ? '选择当前筛选' : 'Select filtered')}
              </button>
            ) : null}
          </div>

          <div className="llm-catalog-list" data-fetch-state={fetchState} aria-busy={loading}>
            {isInitialLoading ? (
              <div className="llm-catalog-initial-loading">
                <div className="llm-catalog-loading-title">
                  <span className="llm-catalog-fetch-spinner motion-spin" aria-hidden="true" />
                  <span>{zh ? '正在读取远程模型目录…' : 'Loading remote model catalog…'}</span>
                </div>
                <div className="llm-catalog-skeleton-list" aria-hidden="true">
                  {[0, 1, 2, 3].map((index) => (
                    <div className="llm-catalog-skeleton" key={index}>
                      <span />
                      <span />
                      <span />
                      <span />
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {!loading && visible.length === 0 ? <div className="llm-catalog-empty">{zh ? '没有匹配的模型' : 'No matching models'}</div> : null}
            {!isInitialLoading ? visible.map(({ model, configured }) => {
              const checked = selected.has(model.id);
              const contextRange = modelContextWindowRange(model);
              const context = compactTokens(contextRange.defaultContextWindow);
              const maxContext = compactTokens(contextRange.maxContextWindow);
              const contextSummary = context && maxContext && context !== maxContext
                ? (zh ? `默认 ${context} · 最高 ${maxContext}` : `Default ${context} · Up to ${maxContext}`)
                : context;
              const output = compactTokens(model.maxOutputTokens);
              const priceFactor = typeof model.priceFactor === 'number' && Number.isFinite(model.priceFactor)
                ? model.priceFactor
                : null;
              const originalPriceFactor = typeof model.originalPriceFactor === 'number' && Number.isFinite(model.originalPriceFactor)
                ? model.originalPriceFactor
                : null;
              const creditLabel = priceFactor == null
                ? null
                : (originalPriceFactor != null && originalPriceFactor !== priceFactor
                  ? `${originalPriceFactor.toFixed(2).replace(/\.?0+$/, '')}x→${priceFactor.toFixed(2).replace(/\.?0+$/, '')}x Credit`
                  : `${priceFactor.toFixed(2).replace(/\.?0+$/, '')}x Credit`);
              const hasMetadata = Boolean(contextSummary || output || model.supportsVision || model.supportsReasoning || creditLabel);
              return (
                <label key={model.id} className={`llm-catalog-item ${configured ? 'is-configured' : ''} ${checked ? 'is-selected' : ''}`}>
                  <input type="checkbox" checked={checked} disabled={selectionMode === 'single' && configured} onChange={() => toggle(model.id)} />
                  <LlmBrandIcon className="llm-brand-icon-model" providerName={providerName} modelId={model.id} />
                  <span className="llm-catalog-item-main">
                    <strong>{model.label || model.id}</strong>
                    <code>{model.id}</code>
                    <small>
                      {hasMetadata
                        ? [contextSummary ? `${contextSummary} ctx` : null, output ? `${output} out` : null, model.supportsVision ? (zh ? '图像输入' : 'vision') : null, model.supportsReasoning ? (zh ? '推理' : 'reasoning') : null, creditLabel].filter(Boolean).join(' · ')
                        : (zh ? '远程接口仅返回 Model ID；导入后元数据待完善' : 'Only a model ID was returned; metadata needs review after import')}
                    </small>
                  </span>
                  <span className={`llm-catalog-status ${configured ? 'is-configured' : ''}`}>{configured ? (zh ? '已配置' : 'Configured') : (zh ? '新模型' : 'New')}</span>
                </label>
              );
            }) : null}
          </div>

          {allowManualModel ? (
            <div className="llm-catalog-manual">
              <div>
                <strong>{zh ? '目录不可用？手动添加首个模型' : 'Catalog unavailable? Add the first model manually'}</strong>
                <small>{zh ? '仅保存你输入的 Model ID，其余元数据保持未知。' : 'Only the Model ID is saved; other metadata stays unknown.'}</small>
              </div>
              <div className="llm-catalog-manual-controls">
                <input value={manualModel} placeholder="Model ID" onChange={(event) => setManualModel(event.target.value)} />
                <button type="button" onClick={() => void importManualModel()} disabled={!manualModel.trim() || importing}>{zh ? '添加' : 'Add'}</button>
              </div>
            </div>
          ) : null}

          <footer className="llm-dialog-footer">
            <button type="button" onClick={requestClose}>{zh ? '取消' : 'Cancel'}</button>
            <button
              type="button"
              className="primary llm-catalog-apply-button"
              onClick={() => void importSelected(requestClose)}
              disabled={!hasSelectionChanges || wouldRemoveAll || importing}
              aria-live="polite"
              data-state={applyState}
            >
              {applyState === 'applying' ? (
                <><span className="llm-catalog-apply-spinner motion-spin" aria-hidden="true" />{zh ? '正在应用…' : 'Applying…'}</>
              ) : applyState === 'success' ? (
                <><span className="llm-catalog-apply-check" aria-hidden="true">✓</span>{zh ? '已应用' : 'Applied'}</>
              ) : (
                zh ? `应用选择（${selectedModels.length} 个模型）` : `Apply selection (${selectedModels.length} models)`
              )}
            </button>
          </footer>
        </>
      )}
    </Overlay>
  );
}
