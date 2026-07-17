import type { I18nRuntime } from '@peer-agent/i18n';
import { useAppearance } from './AppearanceProvider';
import { PALETTE_LABELS, PALETTE_SWATCHES } from './themePresets';
import { PaletteSelect } from './PaletteSelect';
import { AppearanceSlider } from './AppearanceSlider';
import {
  CODE_FONT_SIZE_MAX,
  CODE_FONT_SIZE_MIN,
  type CustomSchemeColors,
} from './appearanceTypes';

/**
 * AppearancePanel 负责切换：
 *   - mode: 浅 / 深 / 跟随系统
 *   - palette: 配色方案（从配色注册表派生，新增配色无需改本组件）
 *   - fontScale: 界面字体大小 小 / 中 / 大
 *
 * mode / palette / fontScale 是正交的外观轴：mode 决定明暗，palette 决定色相，
 * fontScale 决定根字号缩放。具体 token 值由 styles/tokens.css 固化，
 * 本面板只切换 <html dataset>。
 *
 * 视觉编排（借鉴 Codex 外观页分区）：按「主题模式 / 配色 / 字体大小」
 * 三个 .appearance-group 分组，组间留白区隔，组内字段紧凑。
 */

export function AppearancePanel({
  i18n,
  onBack,
}: {
  readonly i18n: I18nRuntime;
  readonly onBack?: () => void;
}) {
  const {
    settings,
    activeScheme,
    setMode,
    setPalette,
    setFontScale,
    setCustomColor,
    setCodeFontSize,
    setDiffMarkerMode,
    reset,
  } = useAppearance();
  const activePaletteLabel = PALETTE_LABELS[settings.palette];
  const swatches = PALETTE_SWATCHES[settings.palette][activeScheme];
  const isCustom = settings.palette === 'custom';

  // 自定义三色控件：浅/深各一组（accent/background/foreground）。
  const customColorKeys: readonly (keyof CustomSchemeColors)[] = [
    'accent',
    'background',
    'foreground',
  ];
  const customColorLabel: Record<keyof CustomSchemeColors, string> = {
    accent: i18n.t('appearance.accent'),
    background: i18n.t('appearance.background'),
    foreground: i18n.t('appearance.foreground'),
  };

  return (
    <div className="appearance-panel">
      {onBack ? (
        <header className="appearance-panel-header">
          <button type="button" onClick={onBack} aria-label={i18n.t('app.settings')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19 12H5" />
              <path d="m12 19-7-7 7-7" />
            </svg>
          </button>
          <div>
            <strong>{i18n.t('appearance.title')}</strong>
            <span>{activePaletteLabel}</span>
          </div>
        </header>
      ) : null}

      <section className="appearance-group">
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
      </section>

      <section className="appearance-group">
        <div className="appearance-field-label">{i18n.t('appearance.palette')}</div>
        <PaletteSelect
          value={settings.palette}
          onChange={setPalette}
          label={i18n.t('appearance.palette')}
        />

        <div className="appearance-field-label">{i18n.t('appearance.swatches')}</div>
        <div className="appearance-swatches" aria-label={i18n.t('appearance.swatches')}>
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
        </div>

        {/* 代码预览：用当前主题语义 token 近似映射语法高亮（参考 Catppuccin 风格指南），
            让用户切换/自定义配色时直观看到代码高亮的实际观感。纯展示，不新增高亮 token。 */}
        <div className="appearance-field-label">{i18n.t('appearance.codePreview')}</div>
        <pre
          className="appearance-code-preview"
          aria-label={i18n.t('appearance.codePreview')}
        >
          <code>
            <span className="appearance-code-line">
              <span className="appearance-code-ln">1</span>
              <span className="appearance-code-text">
                <span className="tok-comment">{'// theme config'}</span>
              </span>
            </span>
            <span className="appearance-code-line">
              <span className="appearance-code-ln">2</span>
              <span className="appearance-code-text">
                <span className="tok-keyword">const</span>
                {' '}
                <span className="tok-variable">theme</span>
                <span className="tok-punct">:</span>
                {' '}
                <span className="tok-type">ThemeConfig</span>
                {' '}
                <span className="tok-punct">=</span>
                {' '}
                <span className="tok-punct">{'{'}</span>
              </span>
            </span>
            <span className="appearance-code-line">
              <span className="appearance-code-ln">3</span>
              <span className="appearance-code-text">
                {'  '}
                <span className="tok-property">accent</span>
                <span className="tok-punct">:</span>
                {' '}
                <span className="tok-string">{'"#5d9cbf"'}</span>
                <span className="tok-punct">,</span>
              </span>
            </span>
            <span className="appearance-code-line">
              <span className="appearance-code-ln">4</span>
              <span className="appearance-code-text">
                {'  '}
                <span className="tok-property">contrast</span>
                <span className="tok-punct">:</span>
                {' '}
                <span className="tok-number">68</span>
                <span className="tok-punct">,</span>
              </span>
            </span>
            <span className="appearance-code-line">
              <span className="appearance-code-ln">5</span>
              <span className="appearance-code-text">
                <span className="tok-punct">{'}'}</span>
                <span className="tok-punct">;</span>
              </span>
            </span>
          </code>
        </pre>
      </section>

      <section className="appearance-group">
        <div className="appearance-field-label">{i18n.t('appearance.fontScale')}</div>
        <div className="appearance-segmented" role="group" aria-label={i18n.t('appearance.fontScale')}>
          {(['small', 'medium', 'large'] as const).map((fontScale) => (
            <button
              key={fontScale}
              type="button"
              className={settings.fontScale === fontScale ? 'active' : ''}
              onClick={() => setFontScale(fontScale)}
            >
              {i18n.t(`appearance.fontScale.${fontScale}`)}
            </button>
          ))}
        </div>
      </section>

      {isCustom ? (
        <section className="appearance-group">
          <div className="appearance-field-label">{i18n.t('appearance.custom')}</div>
          {(['light', 'dark'] as const).map((scheme) => (
            <div key={scheme} className="appearance-custom-scheme">
              <div className="appearance-custom-scheme-label">
                {i18n.t(`appearance.scheme.${scheme}`)}
              </div>
              <div className="appearance-custom-colors">
                {customColorKeys.map((key) => (
                  <label key={key} className="appearance-custom-color">
                    <input
                      type="color"
                      value={settings.customColors[scheme][key]}
                      onChange={(e) => setCustomColor(scheme, key, e.target.value)}
                      aria-label={`${i18n.t(`appearance.scheme.${scheme}`)} ${customColorLabel[key]}`}
                    />
                    <span className="appearance-custom-color-name">{customColorLabel[key]}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <section className="appearance-group">
        <div className="appearance-field-label">{i18n.t('appearance.codeFont')}</div>
        <div className="appearance-code-font">
          <AppearanceSlider
            min={CODE_FONT_SIZE_MIN}
            max={CODE_FONT_SIZE_MAX}
            step={1}
            value={settings.codeFontSize}
            onChange={setCodeFontSize}
            ariaLabel={i18n.t('appearance.codeFont')}
          />
          <input
            type="number"
            min={CODE_FONT_SIZE_MIN}
            max={CODE_FONT_SIZE_MAX}
            step={1}
            value={settings.codeFontSize}
            onChange={(e) => setCodeFontSize(Number(e.target.value))}
            aria-label={i18n.t('appearance.codeFont')}
          />
          <span className="appearance-code-font-unit">px</span>
        </div>
      </section>

      <section className="appearance-group">
        <div className="appearance-field-label">{i18n.t('appearance.diffMarker')}</div>
        <div
          className="appearance-segmented appearance-segmented--two"
          role="group"
          aria-label={i18n.t('appearance.diffMarker')}
        >
          {(['color', 'sign'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={settings.diffMarkerMode === mode ? 'active' : ''}
              onClick={() => setDiffMarkerMode(mode)}
            >
              {i18n.t(`appearance.diffMarker.${mode}`)}
            </button>
          ))}
        </div>
      </section>

      <button type="button" className="appearance-reset" onClick={reset}>
        {i18n.t('appearance.reset')}
      </button>
    </div>
  );
}
