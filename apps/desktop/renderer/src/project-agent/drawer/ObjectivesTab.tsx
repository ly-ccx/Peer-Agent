import type { I18nRuntime } from '@peer-agent/i18n';

export function ObjectivesTab({ i18n }: { readonly i18n: I18nRuntime }) {
  return <p className="bot-drawer-note">{i18n.t('projectAgent.drawer.objectives.body')}</p>;
}
