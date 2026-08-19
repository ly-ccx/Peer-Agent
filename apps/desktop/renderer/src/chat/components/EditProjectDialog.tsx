import { useMemo, useState } from 'react';
import { Overlay } from '../../app/components/Overlay';
import { clientApi } from '../../clientApi';
import { PeerIcon } from '../../ui/icons';
import { abbreviateWorkspacePath } from './workspacePathDisplay';

export interface ProjectFolder {
  path: string;
  name: string;
}

export interface ProjectWorkspace {
  path: string;
  name: string;
  addedAt: string;
  linkedFolders?: readonly ProjectFolder[];
}

export function EditProjectDialog({
  workspace,
  isZh,
  onClose,
  onChanged,
  onRemoveProject,
}: {
  readonly workspace: ProjectWorkspace;
  readonly isZh: boolean;
  readonly onClose: () => void;
  readonly onChanged: () => Promise<void> | void;
  readonly onRemoveProject: (path: string) => Promise<void> | void;
}) {
  const [name, setName] = useState(workspace.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const linkedFolders = workspace.linkedFolders ?? [];

  const folders = useMemo(
    () => [
      { path: workspace.path, name: workspace.name, primary: true },
      ...linkedFolders.map((folder) => ({ ...folder, primary: false })),
    ],
    [linkedFolders, workspace.name, workspace.path],
  );

  const persistName = async () => {
    const nextName = name.trim();
    if (!nextName || nextName === workspace.name) return;
    const result = await clientApi.workspaceUpdate({ path: workspace.path, name: nextName });
    if (!result.ok) {
      setError(isZh ? '无法保存项目名' : 'Could not save the project name');
      return;
    }
    await onChanged();
  };

  const handleAddFolder = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await clientApi.workspaceAddLinkedFolder({ path: workspace.path });
      if (!result.ok && result.reason !== 'cancelled') {
        setError(
          result.reason === 'other-project-primary'
            ? (isZh ? `该文件夹已是另一个项目的主文件夹（${result.name ?? result.path}）` : `That folder is already another project’s primary folder (${result.name ?? result.path})`)
            : result.reason === 'is-primary'
              ? (isZh ? '这个文件夹已经是当前项目的主文件夹' : 'That folder is already this project’s primary folder')
              : (isZh ? '无法添加文件夹' : 'Could not add the folder'),
        );
        return;
      }
      if (result.ok) await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveFolder = async (folderPath: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await clientApi.workspaceRemoveLinkedFolder({
        path: workspace.path,
        folderPath,
      });
      if (!result.ok) {
        setError(isZh ? '无法移除该文件夹' : 'Could not remove that folder');
        return;
      }
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const handleSetPrimary = async (folderPath: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await clientApi.workspaceSetPrimary({
        path: workspace.path,
        folderPath,
      });
      if (!result.ok) {
        setError(isZh ? '无法设为主要。会话仍留在原主文件夹。' : 'Could not set the primary folder. Chats stay with the previous primary folder.');
        return;
      }
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay onClose={onClose} ariaLabel={isZh ? '编辑项目' : 'Edit project'} panelClassName="edit-project-dialog">
      {({ requestClose }) => (
        <>
          <header className="edit-project-header">
            <h3>{isZh ? '编辑项目' : 'Edit project'}</h3>
            <button type="button" className="edit-project-close" onClick={requestClose} aria-label={isZh ? '关闭' : 'Close'}>
              <PeerIcon name="close" size={14} />
            </button>
          </header>

          <label className="edit-project-name">
            <span className="edit-project-folder-icon" aria-hidden="true" />
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => { void persistName(); }}
              disabled={busy}
            />
          </label>

          <div className="edit-project-sources">
            <div className="edit-project-sources-label">{isZh ? '源文件夹' : 'Source folders'}</div>
            <div className="edit-project-source-list">
              {folders.map((folder) => (
                <div key={folder.path} className="edit-project-source-row">
                  <span className="edit-project-folder-icon" aria-hidden="true" />
                  <span className="edit-project-source-meta">
                    <span className="edit-project-source-name">{folder.name}</span>
                    <span className="edit-project-source-path" title={folder.path}>
                      {abbreviateWorkspacePath(folder.path)}
                    </span>
                  </span>
                  {folder.primary ? (
                    <span className="edit-project-primary">{isZh ? '主要' : 'Primary'}</span>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="edit-project-set-primary"
                        disabled={busy}
                        onClick={() => { void handleSetPrimary(folder.path); }}
                      >
                        {isZh ? '设为主要' : 'Set primary'}
                      </button>
                      <button
                        type="button"
                        className="edit-project-remove-folder"
                        disabled={busy}
                        aria-label={isZh ? '移除文件夹' : 'Remove folder'}
                        onClick={() => { void handleRemoveFolder(folder.path); }}
                      >
                        <PeerIcon name="close" size={12} />
                      </button>
                    </>
                  )}
                </div>
              ))}
              <button
                type="button"
                className="edit-project-add-folder"
                disabled={busy}
                onClick={() => { void handleAddFolder(); }}
              >
                {isZh ? '添加文件夹' : 'Add folder'}
              </button>
            </div>
          </div>

          {error ? <p className="edit-project-error">{error}</p> : null}

          <footer className="edit-project-footer">
            <button
              type="button"
              className="edit-project-remove"
              disabled={busy}
              onClick={() => { void onRemoveProject(workspace.path); }}
            >
              {isZh ? '移除项目' : 'Remove project'}
            </button>
            <div className="edit-project-footer-actions">
              <button type="button" className="edit-project-cancel" onClick={requestClose}>
                {isZh ? '取消' : 'Cancel'}
              </button>
              <button
                type="button"
                className="edit-project-save"
                disabled={busy}
                onClick={() => { void persistName().then(requestClose); }}
              >
                {isZh ? '保存' : 'Save'}
              </button>
            </div>
          </footer>
        </>
      )}
    </Overlay>
  );
}
