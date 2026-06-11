import type { I18nRuntime } from '@peer-agent/i18n';
import { useAppearance } from './AppearanceProvider';
import { PALETTE_LABELS, PALETTE_SWATCHES } from './themePresets';
import { PaletteSelect } from './PaletteSelect';

/**
 * AppearancePanel 负责切换：
 *   - mode: 浅 / 深 / 跟随系统
 *   - palette: 配色方案（从配色注册表派生，新增配色无需改本组件）
 *
 * mode 与 palette 是两条正交的轴：mode 决定明暗，palette 决定色相。
 * 具体 token 值由 styles/tokens.css 固化，本面板只切换 <html dataset>。
 */

export function AppearancePanel({
  i18n,
  onBack,
}: {
  readonly i18n: I18nRuntime;
  readonly onBack?: () => void;
}) {
  const { settings, activeScheme, setMode, setPalette, reset } = useAppearance();
  const activePaletteLabel = PALETTE_LABELS[settings.palette];
  const swatches = PALETTE_SWATCHES[settings.palette][activeScheme];

  return (
    <div className="appearance-panel">
      {onBack ? (
        <header className="appearance-panel-header">
          <button type="button" onClick={onBack} aria-label={i18n.t('app.settings')}>
            ←
          </button>
          <div>
            <strong>{i18n.t('appearance.title')}</strong>
            <span>{activePaletteLabel}</span>
          </div>
        </header>
      ) : null}

      <div className="appearance-field-label">{i18n.t('appearance.mode')}</div>
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

      <div className="appearance-field-label">{i18n.t('appearance.palette')}</div>
      <PaletteSelect
        value={settings.palette}
        onChange={setPalette}
        label={i18n.t('appearance.palette')}
      />

      <div className="appearance-field-label">{i18n.t('appearance.swatches')}</div>
      <section className="appearance-swatches" aria-label={i18n.t('appearance.swatches')}>
        {swatches.map((swatch) => (
          <div key={swatch.label} className="appearance-swatch">
            <span
              className="appearance-swatch-chip"
              style={{ backgroundColor: swatch.value }}
              aria-hidden="true"
            />
            <span className="appearance-swatch-name">{swatch.label}</span>
            <span className="appearance-swatch-value">{swatch.value}</span>
          </div>
        ))}
      </section>

      <button type="button" className="appearance-reset" onClick={reset}>
        {i18n.t('appearance.reset')}
      </button>
    </div>
  );
}
