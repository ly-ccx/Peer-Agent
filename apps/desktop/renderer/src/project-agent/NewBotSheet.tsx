import { useId, useRef } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { useCompositionGuard } from '../app/hooks/useCompositionGuard';
import { Overlay } from '../app/components/Overlay';
import { PeerIcon } from '../ui/icons';
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
  if (code === 'UNCONFIRMED') return i18n.t('forms.createUnconfirmed');
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

  const composition = useCompositionGuard();
  const hintId = `${titleId}-hint`, errorId = `${titleId}-error`;

  if (!open) return null;

  const invalid = checked?.ok === false;
  const message = errorLabel(i18n, invalid ? 'INVALID_NAME' : errorCode);
  const hint = checked?.ok && checked.name !== name.trim()
    ? i18n.t('projectAgent.list.nameWillUse', { name: checked.name })
    : '';

  return (
    <Overlay
      ariaLabel={i18n.t('projectAgent.list.newSheetTitle')}
      panelClassName="bot-sheet bot-new-sheet"
      closeOnBackdrop={!busy}
      onEscape={() => busy}
      onClose={onClose}
    >
      {({ requestClose }) => (
        <>
          <header className="bot-sheet-head">
            <h2 id={titleId}>{i18n.t('projectAgent.list.newSheetTitle')}</h2>
            <button
              type="button"
              className="bot-sheet-close ui-button is-icon"
              aria-label={i18n.t('projectAgent.list.close')}
              onClick={requestClose}
              disabled={busy}
            >
              <PeerIcon name="close" size={18} />
            </button>
          </header>
          <form
            className="bot-sheet-blank"
            aria-busy={busy}
            onKeyDown={event => { if (composition.keyDown(event.nativeEvent) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); } }}
            onKeyUp={event => composition.keyUp(event.nativeEvent)}
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy && checked?.ok && !composition.active()) onCreate();
            }}
          >
            <span className="bot-sheet-label">{i18n.t('projectAgent.list.blankBot')}</span>
            <span className="bot-sheet-copy">{i18n.t('projectAgent.list.blankBotHint')}</span>
            <input
              ref={nameRef}
              data-overlay-autofocus
              onCompositionStart={event => composition.start(event.currentTarget)}
              onCompositionEnd={event => composition.end(event.currentTarget)}
              aria-describedby={[hint ? hintId : null, message ? errorId : null].filter(Boolean).join(' ') || undefined}
              aria-invalid={invalid || Boolean(message) || undefined}
              className="bot-sheet-name ui-input"
              value={name}
              placeholder={i18n.t('projectAgent.list.namePlaceholder')}
              aria-label={i18n.t('projectAgent.list.namePlaceholder')}
              onChange={(event) => onName(event.target.value)}
              disabled={busy}
            />
            {hint ? <p id={hintId} className="bot-sheet-hint">{hint}</p> : null}
            {message ? <p id={errorId} className="bot-sheet-error" role="alert">{message}</p> : null}
            <span className="bot-sheet-hint" role="status">{busy ? i18n.t('projectAgent.list.creating') : ''}</span>
            <button type="submit" className="bot-sheet-submit ui-button is-primary" disabled={busy || !checked?.ok}>
              {busy ? i18n.t('projectAgent.list.creating') : i18n.t('projectAgent.list.create')}
            </button>
          </form>
          <button type="button" className="bot-sheet-choice" disabled={busy} onClick={onBind}>
            <span className="bot-sheet-label">{i18n.t('projectAgent.list.bindFolder')}</span>
            <span className="bot-sheet-copy">{i18n.t('projectAgent.list.bindFolderHint')}</span>
          </button>
        </>
      )}
    </Overlay>
  );
}
