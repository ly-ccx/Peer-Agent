import type { I18nRuntime } from '@peer-agent/i18n';
import type { LlmModelInfo, LlmModelListResult, LlmProviderConfigView } from '@peer-agent/protocol';
import { useEffect, useMemo, useState } from 'react';
import { Overlay } from './Overlay';
import {
  buildModelCatalog,
  filterModelCatalog,
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
}) {
  const zh = i18n.locale === 'zh-CN';
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [manualModel, setManualModel] = useState('');
  const [importedModels, setImportedModels] = useState<readonly LlmProviderConfigView[]>(configuredModels);
  const catalog = useMemo(() => buildModelCatalog(models, importedModels), [models, importedModels]);
  const visible = useMemo(() => filterModelCatalog(catalog, query), [catalog, query]);
  useEffect(() => setImportedModels(configuredModels), [configuredModels]);
  const selectable = catalog.filter((entry) => !entry.configured);
  const visibleSelectable = visible.filter((entry) => !entry.configured);
  const selectedModels = selectable.filter((entry) => selected.has(entry.model.id)).map((entry) => entry.model);

  const toggle = (id: string) => {
    setSelected((current) => {
      if (selectionMode === 'single') return current.has(id) ? new Set() : new Set([id]);
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const importSelected = async () => {
    if (selectedModels.length === 0) return;
    setImporting(true);
    setImportError(null);
    try {
      const imported = await onImport(selectedModels);
      if (imported) setImportedModels(imported);
      setSelected(new Set());
    } catch (error: unknown) {
      setImportError(error instanceof Error ? error.message : 'model_import_failed');
    } finally {
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
    <Overlay onClose={onClose} closeOnBackdrop={!importing} ariaLabel={zh ? '获取模型列表' : 'Import models'} panelClassName="llm-catalog-dialog">
      {({ requestClose }) => (
        <>
          <header className="llm-dialog-header">
            <div>
              <h3>{zh ? '获取模型列表' : 'Import models'}</h3>
              <p>{providerName} · {sourceLabel(source, zh)}</p>
            </div>
            <button type="button" className="llm-dialog-close" onClick={requestClose} aria-label={zh ? '关闭' : 'Close'}>✕</button>
          </header>

          <div className="llm-catalog-toolbar">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={zh ? '搜索 Model ID 或名称' : 'Search model ID or name'}
              autoFocus
            />
            <button type="button" onClick={onRefresh} disabled={loading}>{loading ? '…' : (zh ? '刷新目录' : 'Refresh')}</button>
          </div>

          {error ? <p className="llm-catalog-error">{error}</p> : null}
          {importError ? <p className="llm-catalog-error">{importError}</p> : null}
          <div className="llm-catalog-summary">
            <span>{zh ? `发现 ${catalog.length} 个模型` : `${catalog.length} models found`}</span>
            {selectionMode === 'multiple' ? (
              <button
                type="button"
                onClick={() => {
                  const visibleIds = new Set(visibleSelectable.map((entry) => entry.model.id));
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
                disabled={visibleSelectable.length === 0}
              >
                {visibleSelectable.length > 0 && visibleSelectable.every((entry) => selected.has(entry.model.id))
                  ? (zh ? '取消当前筛选' : 'Deselect filtered')
                  : (zh ? '选择当前筛选' : 'Select filtered')}
              </button>
            ) : null}
          </div>

          <div className="llm-catalog-list">
            {loading && catalog.length === 0 ? <div className="llm-catalog-empty">{zh ? '正在读取远程模型目录…' : 'Loading model catalog…'}</div> : null}
            {!loading && visible.length === 0 ? <div className="llm-catalog-empty">{zh ? '没有匹配的模型' : 'No matching models'}</div> : null}
            {visible.map(({ model, configured }) => {
              const checked = selected.has(model.id);
              const context = compactTokens(model.contextWindow);
              const output = compactTokens(model.maxOutputTokens);
              const hasMetadata = Boolean(context || output || model.supportsVision || model.supportsReasoning);
              return (
                <label key={model.id} className={`llm-catalog-item ${configured ? 'is-configured' : ''} ${checked ? 'is-selected' : ''}`}>
                  <input type="checkbox" checked={configured || checked} disabled={configured} onChange={() => toggle(model.id)} />
                  <span className="llm-catalog-item-main">
                    <strong>{model.label || model.id}</strong>
                    <code>{model.id}</code>
                    <small>
                      {hasMetadata
                        ? [context ? `${context} ctx` : null, output ? `${output} out` : null, model.supportsVision ? (zh ? '图像输入' : 'vision') : null, model.supportsReasoning ? (zh ? '推理' : 'reasoning') : null].filter(Boolean).join(' · ')
                        : (zh ? '远程接口仅返回 Model ID；导入后元数据待完善' : 'Only a model ID was returned; metadata needs review after import')}
                    </small>
                  </span>
                  <span className={`llm-catalog-status ${configured ? 'is-configured' : ''}`}>{configured ? (zh ? '已配置' : 'Configured') : (zh ? '新模型' : 'New')}</span>
                </label>
              );
            })}
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
            <button type="button" className="primary" onClick={() => void importSelected()} disabled={selectedModels.length === 0 || importing}>
              {importing ? '…' : (zh ? `导入选中的 ${selectedModels.length} 个模型` : `Import ${selectedModels.length} selected`)}
            </button>
          </footer>
        </>
      )}
    </Overlay>
  );
}
