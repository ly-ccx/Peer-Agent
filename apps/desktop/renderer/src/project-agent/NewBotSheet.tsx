import { useEffect, useId, useRef } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { Overlay } from '../app/components/Overlay';
import { validateManagedBotName } from './state/botListState';

interface NewBotSheetProps {
  readonly open: boolean;
  readonly busy: boolean;
  readonly name: string;
  readonly errorCode: string;
  readonly i18n: I18nRuntime;
  readonly onName: (value: string) => void;
  readonly onBind: () => void;
  readonly onCreate: () => void;
  readonly onClose: () => void;
}

function errorLabel(i18n: I18nRuntime, code: string): string {
  if (!code || code === 'CANCELLED') return '';
  if (code === 'INVALID_NAME') return i18n.t('projectAgent.list.nameInvalid');
  if (code === 'NAME_EXHAUSTED') return i18n.t('projectAgent.list.nameExhausted');
  return i18n.t('projectAgent.list.createFailed');
}

export function NewBotSheet({
  open,
  busy,
  name,
  errorCode,
  i18n,
  onName,
  onBind,
  onCreate,
  onClose,
}: NewBotSheetProps) {
  const titleId = useId();
  const nameRef = useRef<HTMLInputElement | null>(null);
  const checked = name.trim() ? validateManagedBotName(name) : null;

  useEffect(() => {
    if (!open) return undefined;
    const frame = window.requestAnimationFrame(() => nameRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  if (!open) return null;

  const message = errorLabel(i18n, errorCode);
  const hint = checked?.ok && checked.name !== name.trim()
    ? i18n.t('projectAgent.list.nameWillUse', { name: checked.name })
    : '';

  return (
    <Overlay
      ariaLabel={i18n.t('projectAgent.list.newSheetTitle')}
      panelClassName="bot-sheet"
      closeOnBackdrop={!busy}
      onEscape={() => busy}
      onClose={onClose}
    >
      {({ requestClose }) => (
        <>
          <div className="bot-sheet-head">
            <h2 id={titleId}>{i18n.t('projectAgent.list.newSheetTitle')}</h2>
            <button type="button" className="bot-sheet-close" onClick={requestClose} disabled={busy}>
              {i18n.t('projectAgent.list.close')}
            </button>
          </div>
          <button type="button" className="bot-sheet-choice" disabled={busy} onClick={onBind}>
            <strong>{i18n.t('projectAgent.list.bindFolder')}</strong>
            <span>{i18n.t('projectAgent.list.bindFolderHint')}</span>
          </button>
          <form
            className="bot-sheet-blank"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) onCreate();
            }}
          >
            <strong>{i18n.t('projectAgent.list.blankBot')}</strong>
            <span>{i18n.t('projectAgent.list.blankBotHint')}</span>
            <input
              ref={nameRef}
              className="bot-sheet-name"
              value={name}
              placeholder={i18n.t('projectAgent.list.namePlaceholder')}
              aria-label={i18n.t('projectAgent.list.namePlaceholder')}
              onChange={(event) => onName(event.target.value)}
              disabled={busy}
            />
            {hint ? <p className="bot-sheet-hint">{hint}</p> : null}
            {message ? <p className="bot-sheet-error" role="alert">{message}</p> : null}
            <button type="submit" className="bot-sheet-submit" disabled={busy || !name.trim()}>
              {busy ? i18n.t('projectAgent.list.creating') : i18n.t('projectAgent.list.create')}
            </button>
          </form>
        </>
      )}
    </Overlay>
  );
}
