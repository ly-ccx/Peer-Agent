import type { I18nRuntime } from '@peer-agent/i18n';
import { useId, useState } from 'react';
import { PeerIcon } from '../../ui/icons';
import { CascadingMenu, type CascadingMenuGroup } from './CascadingMenu';
import { SettingsDisclosureContent } from './SettingsDisclosureContent';

/** A quiet persisted-model summary; the actual model picker is disclosed on demand. */
export function FallbackVisionSetting({ i18n, value, groups, saving, onChange }: {
  readonly i18n: I18nRuntime;
  readonly value: string;
  readonly groups: readonly CascadingMenuGroup[];
  readonly saving: boolean;
  readonly onChange: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const group = groups.find(item => item.items.some(model => model.id === value));
  const model = group?.items.find(item => item.id === value);
  const title = i18n.t('settings.fallbackVision');
  const summary = value
    ? model?.label ?? (i18n.locale === 'zh-CN' ? '模型不可用' : 'Model unavailable')
    : i18n.t('settings.fallbackVision.none');
  return (
    <section className="llm-fallback-vision" aria-label={title}>
      <button type="button" className="llm-fallback-vision-toggle" aria-expanded={expanded} aria-controls={contentId}
        onClick={() => setExpanded(open => !open)}>
        <span className="llm-fallback-vision-copy">
          <strong>{title}</strong>
          <span className="llm-fallback-vision-help">{i18n.t('settings.fallbackVision.description')}</span>
        </span>
        <span className="llm-fallback-vision-summary" aria-live="polite">
          <span className="llm-fallback-vision-model" title={summary}>{summary}</span>
          {value && group ? <span className="llm-fallback-vision-service">{group.label}</span> : null}
        </span>
        <PeerIcon name="chevronRight" size={16} className="llm-fallback-vision-caret" />
      </button>
      <SettingsDisclosureContent expanded={expanded} id={contentId}>
        <div className="llm-fallback-vision-select">
          <CascadingMenu className="llm-fallback-vision-menu" value={value || '__none__'} groups={groups}
            onChange={onChange} disabled={saving} ariaLabel={title}
            placeholder={i18n.t('settings.fallbackVision.none')}
            triggerLabel={value ? undefined : i18n.t('settings.fallbackVision.none')} menuPlacement="down" />
        </div>
      </SettingsDisclosureContent>
    </section>
  );
}
