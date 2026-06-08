import type { I18nRuntime } from '@zeus-atlas/i18n';
import { useAppearance } from './AppearanceProvider';
import { ATLAS_VELLUM_NAME } from './themePresets';

/**
 * Atlas Vellum 设计语言下，AppearancePanel 只负责切换：
 *   - 浅 / 深 / 跟随系统
 *
 * 不再暴露：accent / background / foreground / 字体 / 半透明 / 对比度
 * 这些 token 是设计语言的固定契约，不再可调。
 *
 * 朱砂 / 墨 / 羊皮纸三层关系由 styles/tokens.css 固化（红线 §6）。
 */
export function AppearancePanel({
  i18n,
  onBack,
}: {
  readonly i18n: I18nRuntime;
  readonly onBack: () => void;
}) {
  const { settings, setMode, reset } = useAppearance();

  return (
    <div className="appearance-panel">
      <header className="appearance-panel-header">
        <button type="button" onClick={onBack} aria-label={i18n.t('app.settings')}>
          ←
        </button>
        <div>
          <strong>{i18n.t('appearance.title')}</strong>
          <span>Atlas Vellum · {ATLAS_VELLUM_NAME}</span>
        </div>
      </header>

      <div className="appearance-segmented" role="group" aria-label={i18n.t('appearance.mode')}>
        {(['light', 'dark', 'system'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className={settings.mode === mode ? 'active' : ''}
            onClick={() => setMode(mode)}
          >
            {i18n.t(`appearance.mode.${mode}`)}
          </button>
        ))}
      </div>

      <section className="appearance-preview" aria-label={i18n.t('appearance.preview')}>
        <div className="appearance-preview-sidebar">
          <span />
          <strong>{ATLAS_VELLUM_NAME}</strong>
          <small>v0.1</small>
        </div>
        <div className="appearance-preview-thread">
          <p>羊皮纸上的墨与印</p>
          <span>{i18n.t('appearance.previewTool')}</span>
        </div>
        <div className="appearance-preview-composer">
          <span>{i18n.t('appearance.previewComposer')}</span>
          <i>↑</i>
        </div>
      </section>

      <button type="button" className="appearance-reset" onClick={reset}>
        {i18n.t('appearance.reset')}
      </button>
    </div>
  );
}
