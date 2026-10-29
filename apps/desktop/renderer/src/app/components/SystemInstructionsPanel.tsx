import './settings-section-header.css';
import type { I18nRuntime } from '@peer-agent/i18n';
import { useId } from 'react';
import { clientApi } from '../../clientApi';
import { PeerIcon } from '../../ui/icons';
import { SettingsGroup } from '../../ui/settings/SettingsGroup';
import { FormFeedback } from '../../ui/forms/FormFeedback';
import { useEditableResource } from '../../ui/forms/useEditableResource';
import { useGuardedNavigation, useUnsavedChanges } from '../../ui/forms/UnsavedChanges';

function readSystemInstructions(settings: Record<string, unknown> | null | undefined): string {
  return typeof settings?.systemInstructions === 'string' ? settings.systemInstructions : '';
}

/** Editing only; System Context admission continues through the existing settings contract. */
export function SystemInstructionsPanel({ i18n, onBack, onSystemInstructionsChanged }: {
  readonly i18n: I18nRuntime; readonly onBack?: () => void; readonly onSystemInstructionsChanged?: (value: string) => void;
}) {
  const isZh = i18n.locale.startsWith('zh');
  const id = useId(), hintId = `${id}-hint`, statusId = `${id}-status`;
  const navigate = useGuardedNavigation();
  const form = useEditableResource('settings.instructions', readSystemInstructions(clientApi.initialSettings), {
    read: async () => { const saved = readSystemInstructions(await clientApi.getSettings()); onSystemInstructionsChanged?.(saved); return saved; },
    write: async draft => {
      const saved = readSystemInstructions(await clientApi.updateSettings({ systemInstructions: draft }));
      onSystemInstructionsChanged?.(saved); return saved;
    },
  });
  useUnsavedChanges({ dirty: form.dirty, busy: form.saving, save: form.save, discard: form.reset });
  return <div className="system-instructions-panel">
    {onBack ? <header className="llm-settings-header"><button type="button" className="ui-button is-icon" onClick={() => navigate(onBack)} aria-label={i18n.t('forms.back')}><PeerIcon name="back" size={18} /></button><strong>{isZh ? '个性化设置' : 'Personalization'}</strong></header>
      : <header className="frost-page-heading"><h1>{isZh ? '个性化' : 'Personalization'}</h1></header>}
    <SettingsGroup title={isZh ? '个性化设置' : 'Personalization'}>
      <div className="ui-editor-body" aria-busy={form.loading || form.saving}>
        <label htmlFor={id}>{isZh ? '回答偏好与项目约束' : 'Response preferences and project constraints'}</label>
        <p id={hintId}>{isZh ? '用于后续对话；保存不会改写正在进行的回复。' : 'Applies to future conversations; saving does not rewrite a running reply.'}</p>
        <textarea id={id} className="ui-input" rows={8} value={form.draft} disabled={!form.loaded || form.saving} aria-describedby={`${hintId} ${statusId}`} aria-invalid={form.saveError || undefined} onChange={event => form.edit(event.target.value)} />
        <FormFeedback id={statusId} i18n={i18n} {...form} onReload={form.reload} onRetry={form.save} />
        <div className="ui-form-actions">
          <button type="button" className="ui-button" disabled={!form.dirty || form.saving} onClick={form.reset}>{i18n.t('forms.reset')}</button>
          <button type="button" className="ui-button is-primary" disabled={!form.loaded || !form.dirty || form.saving} onClick={() => { void form.save(); }}>{i18n.t(form.saving ? 'forms.saving' : 'forms.save')}</button>
        </div>
      </div>
    </SettingsGroup>
  </div>;
}
