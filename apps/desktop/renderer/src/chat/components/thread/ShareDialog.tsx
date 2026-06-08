import { useCallback, useEffect, useRef, useState } from 'react';
import type { I18nRuntime } from '@zeus-atlas/i18n';
import { StaffSelect } from './StaffSelect';

export type ShareMode = 'full_conversation' | 'message_selection';
export type ShareAccessKind = 'public' | 'acl';

export interface ShareConfirmPayload {
  mode: ShareMode;
  accessKind: ShareAccessKind;
  aclWhitelist: string;
}

interface ShareDialogProps {
  readonly open: boolean;
  readonly saving: boolean;
  readonly selectedCount?: number;
  readonly i18n: I18nRuntime;
  readonly onConfirm: (payload: ShareConfirmPayload) => void;
  readonly onCancel: () => void;
  readonly onStartSelection?: () => void;
}

export function ShareDialog({ open, saving, selectedCount = 0, i18n, onConfirm, onCancel, onStartSelection }: ShareDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<ShareMode>('full_conversation');
  const [accessKind, setAccessKind] = useState<ShareAccessKind>('public');
  const [aclWhitelist, setAclWhitelist] = useState('');

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  useEffect(() => {
    if (open) {
      // 有已选消息时保持 message_selection，不重置
      if (selectedCount > 0) {
        setMode('message_selection');
      }
      setAccessKind('public');
      setAclWhitelist('');
    }
  }, [open, selectedCount]);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const handler = () => onCancel();
    el.addEventListener('cancel', handler);
    return () => el.removeEventListener('cancel', handler);
  }, [onCancel]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === dialogRef.current) onCancel();
    },
    [onCancel],
  );

  const aclInputReady = accessKind === 'public' || aclWhitelist.trim().length > 0;
  const selectionReady = mode === 'full_conversation' || selectedCount > 0;
  const canConfirm = aclInputReady && selectionReady;

  return (
    <dialog ref={dialogRef} className="share-dialog" onClick={handleBackdropClick}>
      <div className="share-dialog-content" onClick={(e) => e.stopPropagation()}>
        <h3>{i18n.t('share.title')}</h3>
        <p className="share-dialog-desc">{i18n.t('share.description')}</p>

        {/* 分享模式 */}
        <div className="share-section">
          <div className="share-section-label">{i18n.t('share.sectionMode')}</div>
          <div className="share-mode-group">
            <label className={`share-mode-option ${mode === 'full_conversation' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="share-mode"
                checked={mode === 'full_conversation'}
                onChange={() => setMode('full_conversation')}
              />
              <div>
                <strong>{i18n.t('share.modeFull')}</strong>
                <span>{i18n.t('share.modeFullDesc')}</span>
              </div>
            </label>
            <label className={`share-mode-option ${mode === 'message_selection' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="share-mode"
                checked={mode === 'message_selection'}
                onChange={() => {
                  setMode('message_selection');
                  onStartSelection?.();
                }}
              />
              <div>
                <strong>{i18n.t('share.modeSelect')}</strong>
                <span>
                  {selectedCount > 0
                    ? `${i18n.t('share.modeSelectDesc')}（已选 ${selectedCount} 条）`
                    : i18n.t('share.modeSelectDesc')}
                </span>
              </div>
            </label>
          </div>
        </div>

        {/* 访问权限 */}
        <div className="share-section">
          <div className="share-section-label">{i18n.t('share.sectionAccess')}</div>
          <div className="share-mode-group">
            <label className={`share-mode-option ${accessKind === 'public' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="share-access"
                checked={accessKind === 'public'}
                onChange={() => setAccessKind('public')}
              />
              <div>
                <strong>{i18n.t('share.accessPublic')}</strong>
                <span>{i18n.t('share.accessPublicDesc')}</span>
              </div>
            </label>
            <label className={`share-mode-option ${accessKind === 'acl' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="share-access"
                checked={accessKind === 'acl'}
                onChange={() => setAccessKind('acl')}
              />
              <div>
                <strong>{i18n.t('share.accessAcl')}</strong>
                <span>{i18n.t('share.accessAclDesc')}</span>
              </div>
            </label>
          </div>
        </div>

        {/* ACL 白名单 */}
        {accessKind === 'acl' ? (
          <div className="share-section">
            <div className="share-section-label">{i18n.t('share.aclWhitelist')}</div>
            <StaffSelect
              value={aclWhitelist}
              onChange={setAclWhitelist}
              placeholder={i18n.t('share.aclPlaceholder')}
            />
          </div>
        ) : null}

        <div className="share-dialog-footer">
          <button type="button" className="share-btn-cancel" onClick={onCancel} disabled={saving}>
            {i18n.t('share.cancel')}
          </button>
          <button
            type="button"
            className="share-btn-confirm"
            onClick={() => onConfirm({ mode, accessKind, aclWhitelist })}
            disabled={saving || !canConfirm}
          >
            {saving ? i18n.t('share.creating') : i18n.t('share.confirm')}
          </button>
        </div>
      </div>
    </dialog>
  );
}
