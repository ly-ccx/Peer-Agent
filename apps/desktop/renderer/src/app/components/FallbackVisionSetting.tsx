import type { I18nRuntime } from '@peer-agent/i18n';
import { useId, useState } from 'react';
import { PeerIcon } from '../../ui/icons';
import { ModelPicker } from '../../ui/model-picker/ModelPicker';
import type { SelectionProviderGroup } from '../../ui/model-picker/modelSelection';
import { SettingsDisclosureContent } from './SettingsDisclosureContent';

/** A quiet persisted-model summary; the actual model picker is disclosed on demand. */
export function FallbackVisionSetting({ i18n, value, groups, saving, onChange }: {
  readonly i18n: I18nRuntime;
  readonly value: string;
  readonly groups: readonly SelectionProviderGroup[];
  readonly saving: boolean;
  readonly onChange: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const group = groups.find(item => item.models.some(model => model.id === value));
  const model = group?.models.find(item => item.id === value);
  const title = i18n.t('settings.fallbackVision');
  const rowLabel = i18n.locale === 'zh-CN' ? '备用视觉模型' : 'Fallback vision model';
  const summary = value
    ? model?.label ?? (i18n.locale === 'zh-CN' ? '模型不可用' : 'Model unavailable')
    : i18n.t('settings.fallbackVision.none');
  return (
    <section className="llm-connected-group llm-fallback-vision" aria-label={title}>
      <header className="llm-connected-band">
        <h2>{title}</h2>
      </header>
      <button type="button" className="llm-fallback-vision-toggle" aria-expanded={expanded} aria-controls={contentId}
        onClick={() => setExpanded(open => !open)}>
        <span className="llm-fallback-vision-copy">
          <strong>{rowLabel}</strong>
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
          <ModelPicker className="llm-fallback-vision-menu" variant="field"
            selectedModelId={value || '__none__'} groups={groups} onSelectModel={onChange}
            selectionDisabled={saving} busy={saving} ariaLabel={title} label={summary}
            isZh={i18n.locale.startsWith('zh')} />
        </div>
      </SettingsDisclosureContent>
    </section>
  );
}
