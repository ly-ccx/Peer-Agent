import { MotionDetails } from '../../app/components/MotionDetails';
import { PeerIcon } from '../icons';
import type { I18nRuntime } from '@peer-agent/i18n';
import { useEditableResource } from '../forms/useEditableResource';
import { ResourceFeedback } from './ResourceFeedback';

/** Non-secret, session-retained edits. Ports retain ownership of versions and write receipts. */
export function ResourceEditor({ identity, initial, fields, read, write, i18n, onClose, onSaved }: {
  readonly identity: string; readonly initial: Record<string, string>;
  readonly fields: readonly { key: string; label: string; multiline?: boolean; maxLength?: number }[];
  readonly read: () => Promise<Record<string, string>>;
  readonly write: (draft: Record<string, string>, saved: Record<string, string>) => Promise<Record<string, string>>;
  readonly i18n: I18nRuntime; readonly onClose: () => void; readonly onSaved?: () => void;
}) {
  const editor = useEditableResource(identity, initial, { read, write, equal: (a, b) => fields.every(field => a[field.key] === b[field.key]) });
  return <div className="ui-editor-body">
    {fields.map(field => <label key={field.key}>{field.label}
      {field.multiline ? <textarea disabled={editor.saving} className="ui-input" value={editor.draft[field.key] ?? ''} maxLength={field.maxLength}
        onChange={event => editor.edit({ ...editor.draft, [field.key]: event.target.value })} />
        : <input disabled={editor.saving} className="ui-input" value={editor.draft[field.key] ?? ''} maxLength={field.maxLength}
          onChange={event => editor.edit({ ...editor.draft, [field.key]: event.target.value })} />}
    </label>)}
    <ResourceFeedback i18n={i18n} loading={editor.loading} error={editor.readError} onReload={editor.reload}
      action={{ pending: editor.saving, confirmed: editor.committed && !editor.dirty, error: false }} />
    {editor.saveError ? <div role="alert"><p>{i18n.t('resources.saveFailed')}</p><button type="button" className="ui-button" disabled={editor.loading || editor.saving} onClick={() => void editor.reload()}>{i18n.t('resources.retryRead')}</button></div> : null}
    {editor.stale ? <MotionDetails className="ui-saved-value"><summary><PeerIcon name="chevronRight" size={14} />{i18n.t('forms.savedValue')}</summary>{fields.map(field => <p key={field.key}>{field.label}: {editor.saved[field.key]}</p>)}</MotionDetails> : null}
    {editor.dirty || editor.stale ? <p role="status">{i18n.t(editor.stale ? 'resources.staleDraft' : 'resources.draft')}</p> : null}
    <div className="ui-form-actions">
      <button type="button" className="ui-button" disabled={!editor.loaded || editor.loading || editor.saving || editor.readError || !editor.dirty || fields.some(field => !editor.draft[field.key]?.trim())}
        onClick={() => { void editor.save().then(saved => { if (saved) onSaved?.(); }); }}>{i18n.t('resources.save')}</button>
      <button type="button" className="ui-button" disabled={editor.saving} onClick={() => { editor.reset(); onClose(); }}>{i18n.t('resources.discard')}</button>
      <button type="button" className="ui-button" disabled={editor.saving} onClick={onClose}>{i18n.t('resources.closeEditor')}</button>
    </div>
  </div>;
}
