import type { ReactNode } from 'react';
import { MotionDetails } from '../app/components/MotionDetails';
import { ChoiceStrip } from '../ui/forms/ChoiceStrip';
import { PeerIcon } from '../ui/icons';
import type { WorkbenchFileMode } from './documentSessionState';
import { adapterModeUnavailable } from './file-preview/documentAdapterState';
import { basename, detectFileKind, extension } from './file-preview/fileTypes';

/** Document identity and reading controls; reads, navigation and drafts stay with the owner. */
export function ResourceDocumentHeader({ path, relativePath, historical, mode, idPrefix, isZh, onModeChange, actions, history }: {
  readonly path: string; readonly relativePath?: string; readonly historical: boolean;
  readonly mode: WorkbenchFileMode; readonly idPrefix: string; readonly isZh: boolean;
  readonly onModeChange: (mode: WorkbenchFileMode) => void;
  readonly actions: ReactNode; readonly history: ReactNode;
}) {
  const type = extension(path).toUpperCase();
  const kind = detectFileKind(path);
  return <header className="resource-document-header">
    <div className="resource-document-identity">
      <span className="resource-document-file-icon"><PeerIcon name={kind === 'image' ? 'image' : 'fileText'} size={18} /></span>
      <div className="resource-document-title">
        <h2 title={path}>{basename(path)}</h2>
        <p>{historical ? (isZh ? '历史版本' : 'Historical version') : (isZh ? '当前文件' : 'Current file')}{type ? ` · ${type}` : ''}</p>
      </div>
      <div className="resource-document-actions">{actions}</div>
    </div>
    <MotionDetails className="resource-document-location">
      <summary title={path}><PeerIcon name="folder" size={13} /><span>{relativePath || path}</span><PeerIcon name="chevronDown" size={12} /></summary>
      <p>{path}</p>
    </MotionDetails>
    <div className="resource-document-controls">
      <ChoiceStrip value={mode} label={isZh ? '文档模式' : 'Document mode'} idPrefix={idPrefix} panelId={`${idPrefix}-panel`}
        className="resource-document-modes" itemClassName="ui-button is-compact" onChange={onModeChange}
        options={(['preview', 'source', 'diff'] as const).map(value => ({ value,
          label: value === 'preview' ? (isZh ? '正文' : 'Preview') : value === 'source' ? (isZh ? '源码' : 'Source') : 'Diff',
          disabled: adapterModeUnavailable(path, value) || historical && value === 'diff',
          title: value === 'preview' && adapterModeUnavailable(path, value) ? (isZh ? '此格式仅提供只读源码。' : 'Only read-only source is available for this format.')
            : kind === 'image' && value === 'source' ? (isZh ? '图片不提供文本源码。' : 'Images have no text source view.')
            : historical && value === 'diff' ? (isZh ? '历史正文只读；请从提交比较查看差异。' : 'Historical content is read-only. Use a commit comparison for differences.') : undefined,
        }))} />
      {history}
    </div>
  </header>;
}
