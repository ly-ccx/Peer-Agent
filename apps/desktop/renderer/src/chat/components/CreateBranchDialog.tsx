import { useState } from 'react';
import { Dropdown } from '../../app/components/Dropdown';
import { Overlay } from '../../app/components/Overlay';
import type { DropdownOption, DropdownTab } from '../../app/components/dropdownMenu';
import {
  defaultComposerUpstreamSpec,
  isComposerEnvSentinel,
  isSafeComposerBranchName,
  parseComposerUpstreamSpec,
} from '../state/taskBoundBranch';

/** What the dialog hands back once the user confirms. */
export interface CreateBranchRequest {
  readonly name: string;
  readonly source: string;
  readonly push: boolean;
  readonly upstream: string | null;
}

export interface CreateBranchDialogProps {
  readonly isZh: boolean;
  /** Forkable branches, tagged with `tab: 'local' | 'remote'` so the picker can split them. */
  readonly sourceOptions: readonly DropdownOption[];
  /**
   * Pre-selected source. Comes from the composer's checked branch (or the workspace HEAD),
   * so the dialog opens on a sensible default while still letting the user change it here.
   */
  readonly initialSource: string;
  readonly onCancel: () => void;
  readonly onConfirm: (request: CreateBranchRequest) => void;
}

/**
 * Create-branch dialog: the source branch is chosen *here*, not in the capsule menu it was
 * opened from. The capsule menu's list highlight tracks the mouse, so deriving the source
 * from it meant "fork whichever row the pointer last crossed". Keeping the choice inside the
 * dialog — with its own local/remote picker — makes the source an explicit user decision.
 */
export function CreateBranchDialog({
  isZh,
  sourceOptions,
  initialSource,
  onCancel,
  onConfirm,
}: CreateBranchDialogProps) {
  const [source, setSource] = useState(initialSource);
  const [name, setName] = useState('');
  const [push, setPush] = useState(true);
  const [upstream, setUpstream] = useState('');

  const tabs: readonly DropdownTab[] = [
    { id: 'local', label: isZh ? '本地' : 'Local' },
    { id: 'remote', label: isZh ? '远程' : 'Remote' },
  ];

  const trimmedSource = source.trim();
  const sourceOk = Boolean(trimmedSource) && !isComposerEnvSentinel(trimmedSource);
  const nameOk = isSafeComposerBranchName(name);
  const upstreamSpec = push ? parseComposerUpstreamSpec(upstream, name) : null;
  const canConfirm = sourceOk && nameOk && (!push || upstreamSpec != null);

  return (
    <Overlay
      onClose={onCancel}
      ariaLabel={isZh ? '创建分支' : 'Create Branch'}
      panelClassName="pa-confirm-dialog"
    >
      {({ requestClose }) => {
        const confirmCreate = () => {
          if (!canConfirm) return;
          onConfirm({ name: name.trim(), source: trimmedSource, push, upstream });
          requestClose();
        };
        return (
          <div className="pa-confirm-body">
            <h2 className="pa-confirm-title">{isZh ? '创建分支' : 'Create Branch'}</h2>
            <label className="pa-confirm-field">
              <span className="pa-confirm-field-label">{isZh ? '源头分支' : 'Source branch'}</span>
              <Dropdown
                className="pa-confirm-source-dropdown"
                value={source}
                options={sourceOptions}
                onChange={setSource}
                tabs={tabs}
                tabsAriaLabel={isZh ? '源头分支范围' : 'Source branch scope'}
                searchable
                searchPlaceholder={isZh ? '搜索源头…' : 'Search source…'}
                emptyLabel={isZh ? '没有匹配的分支' : 'No matching branch'}
                ariaLabel={isZh ? '源头分支' : 'Source branch'}
              />
            </label>
            <p className="pa-confirm-message">
              {sourceOk
                ? (isZh ? `从 ${trimmedSource} 创建分支` : `Create a branch from ${trimmedSource}`)
                : (isZh ? '请先选择源头分支' : 'Pick a source branch first')}
            </p>
            <input
              className="pa-confirm-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={isZh ? '分支名' : 'Branch name'}
              autoFocus
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                confirmCreate();
              }}
            />
            <label className="pa-confirm-check">
              <input
                type="checkbox"
                checked={push}
                onChange={(event) => setPush(event.target.checked)}
              />
              <span>{isZh ? '创建后推送到远端（git push -u）' : 'Push to remote after creating (git push -u)'}</span>
            </label>
            {push ? (
              <label className="pa-confirm-field">
                <span className="pa-confirm-field-label">{isZh ? '跟踪到' : 'Track'}</span>
                <input
                  className="pa-confirm-input"
                  value={upstream}
                  onChange={(event) => setUpstream(event.target.value)}
                  placeholder={defaultComposerUpstreamSpec(name) || 'origin/branch'}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    confirmCreate();
                  }}
                />
              </label>
            ) : null}
            <div className="pa-confirm-actions is-spread">
              <button type="button" className="pa-confirm-btn ghost" onClick={requestClose}>
                {isZh ? '取消 Esc' : 'Cancel Esc'}
              </button>
              <button
                type="button"
                className="pa-confirm-btn primary"
                disabled={!canConfirm}
                onClick={confirmCreate}
              >
                {isZh ? '确认' : 'Confirm'}
              </button>
            </div>
          </div>
        );
      }}
    </Overlay>
  );
}
