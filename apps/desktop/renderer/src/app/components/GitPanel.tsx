import type { I18nRuntime } from '@peer-agent/i18n';
import { useId } from 'react';
import { DEFAULT_GIT_BRANCH_PREFIX, readGitBranchPrefixFromSettings, resolveGitBranchPrefix } from '../gitBranchPrefix';
import { SettingsGroup } from '../../ui/settings/SettingsGroup';
import { SettingsRow } from '../../ui/settings/SettingsRow';
import { FormFeedback } from '../../ui/forms/FormFeedback';
import { useEditableResource } from '../../ui/forms/useEditableResource';
import { useUnsavedChanges } from '../../ui/forms/UnsavedChanges';
import { isImeKey } from '../../chat/state/compositionGuard';
import { clientApi } from '../../clientApi';

export interface GitPanelProps {
  readonly i18n: I18nRuntime; readonly workspacePath: string | null;
  readonly onGitBranchPrefixChanged?: (value: string) => void;
}

export function GitPanel({ i18n, onGitBranchPrefixChanged }: GitPanelProps) {
  const statusId = useId();
  const form = useEditableResource('settings.git-prefix', readGitBranchPrefixFromSettings(clientApi.initialSettings), {
    read: async () => readGitBranchPrefixFromSettings(await clientApi.getSettings()),
    write: async draft => {
      const saved = readGitBranchPrefixFromSettings(await clientApi.updateSettings({ gitBranchPrefix: resolveGitBranchPrefix(draft) }));
      onGitBranchPrefixChanged?.(saved); return saved;
    },
  });
  useUnsavedChanges({ dirty: form.dirty, busy: form.saving, save: form.save, discard: form.reset });
  return <div className="general-panel">
    <header className="frost-page-heading"><h1>{i18n.t('settings.git')}</h1></header>
    <SettingsGroup title={i18n.t('settings.git.branchNaming')} className="general-card">
      <SettingsRow label={i18n.t('settings.git.branchPrefix')} description={i18n.t('settings.git.branchPrefix.description')}>
        {ids => <input {...ids} className="ui-input" type="text" value={form.draft} spellCheck={false} disabled={!form.loaded || form.saving} placeholder={DEFAULT_GIT_BRANCH_PREFIX}
          aria-describedby={`${ids['aria-describedby']} ${statusId}`} aria-invalid={form.saveError || undefined}
          onChange={event => form.edit(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !isImeKey(event)) { event.preventDefault(); void form.save(); } }} />}
      </SettingsRow>
      <div className="ui-editor-body">
        <FormFeedback id={statusId} i18n={i18n} {...form} onReload={form.reload} onRetry={form.save} />
        <div className="ui-form-actions">
          <button type="button" className="ui-button" disabled={!form.dirty || form.saving} onClick={form.reset}>{i18n.t('forms.reset')}</button>
          <button type="button" className="ui-button is-primary" disabled={!form.loaded || !form.dirty || form.saving} onClick={() => { void form.save(); }}>{i18n.t(form.saving ? 'forms.saving' : 'forms.save')}</button>
        </div>
      </div>
    </SettingsGroup>
  </div>;
}
