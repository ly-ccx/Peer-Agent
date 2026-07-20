import { useMemo } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { useAppearance } from './AppearanceProvider';
import { PALETTE_LABELS, PALETTE_SWATCHES } from './themePresets';
import { PaletteSelect } from './PaletteSelect';
import { AppearanceSlider } from './AppearanceSlider';
import {
  CODE_FONT_SIZE_MAX,
  CODE_FONT_SIZE_MIN,
  type AppearanceMode,
  type AppearanceScheme,
} from './appearanceTypes';

/**
 * AppearancePanel —— 外观设置：
 *   - ThemeModeCards：主题模式缩略图（light / dark / system）
 *   - ThemeLivePreview：双栏实时预览（代码 + diff）
 *   - 预设配色选择 + 色板 swatch
 *   - 字号与差异标记统一 settings list
 */
export function AppearancePanel({
  i18n,
  onBack,
}: {
  readonly i18n: I18nRuntime;
  readonly onBack?: () => void;
}) {
  const {
    activeScheme,
    settings,
    setMode,
    setPalette,
    setFontScale,
    setCodeFontSize,
    setDiffMarkerMode,
    reset,
  } = useAppearance();

  const previewColors = useMemo(() => {
    const swatches = PALETTE_SWATCHES[settings.palette]?.[activeScheme] ?? [];
    const byLabel = Object.fromEntries(swatches.map((s) => [s.label, s.value]));
    return {
      accent: byLabel.Accent ?? 'var(--za-accent)',
      background: byLabel.Background ?? 'var(--za-bg)',
      foreground: byLabel.Text ?? byLabel.Foreground ?? 'var(--za-fg)',
    };
  }, [activeScheme, settings.palette]);

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
            <span>{PALETTE_LABELS[settings.palette] ?? i18n.t('appearance.subtitle')}</span>
          </div>
        </header>
      ) : null}

      {/* 1. 主题模式缩略图 */}
      <section className="appearance-group">
        <div className="appearance-field-label">{i18n.t('appearance.mode')}</div>
        <ThemeModeCards
          i18n={i18n}
          mode={settings.mode}
          onChange={setMode}
        />
      </section>

      {/* 2. 实时双栏预览 */}
      <section className="appearance-group">
        <div className="appearance-field-label">{i18n.t('appearance.preview')}</div>
        <ThemeLivePreview
          i18n={i18n}
          activeScheme={activeScheme}
          paletteLabel={PALETTE_LABELS[settings.palette] ?? settings.palette}
          previewColors={previewColors}
          diffMarkerMode={settings.diffMarkerMode}
        />
      </section>

      {/* 3. 预设配色 */}
      <section className="appearance-group">
        <div className="appearance-field-label">{i18n.t('appearance.palette')}</div>
        <PaletteSelect
          value={settings.palette}
          onChange={setPalette}
          label={i18n.t('appearance.palette')}
        />
        <div className="appearance-swatch-strip" aria-label={i18n.t('appearance.swatches')}>
          {(PALETTE_SWATCHES[settings.palette]?.[activeScheme] ?? []).slice(0, 6).map((swatch) => (
            <span
              key={swatch.label}
              className="appearance-swatch-dot"
              style={{ backgroundColor: swatch.value }}
              title={`${swatch.label} ${swatch.value}`}
            />
          ))}
        </div>
      </section>

      {/* 4. 统一 settings list：字号 / 代码字号 / 差异标记 */}
      <section className="appearance-group">
        <div className="appearance-field-label">{i18n.t('appearance.settingsList')}</div>
        <div className="appearance-settings-list appearance-settings-card">
          <div className="appearance-settings-row">
            <div className="appearance-settings-row-meta">
              <span className="appearance-settings-row-title">{i18n.t('appearance.fontScale')}</span>
            </div>
            <div
              className="appearance-segmented appearance-segmented--inline"
              role="group"
              aria-label={i18n.t('appearance.fontScale')}
            >
              {(['small', 'medium', 'large'] as const).map((scale) => (
                <button
                  key={scale}
                  type="button"
                  className={settings.fontScale === scale ? 'is-active' : undefined}
                  onClick={() => setFontScale(scale)}
                >
                  {i18n.t(`appearance.fontScale.${scale}`)}
                </button>
              ))}
            </div>
          </div>

          <div className="appearance-settings-row">
            <div className="appearance-settings-row-meta">
              <span className="appearance-settings-row-title">{i18n.t('appearance.codeFont')}</span>
              <span className="appearance-settings-row-value">{settings.codeFontSize}px</span>
            </div>
            <AppearanceSlider
              min={CODE_FONT_SIZE_MIN}
              max={CODE_FONT_SIZE_MAX}
              value={settings.codeFontSize}
              onChange={setCodeFontSize}
              ariaLabel={i18n.t('appearance.codeFont')}
            />
          </div>

          <div className="appearance-settings-row">
            <div className="appearance-settings-row-meta">
              <span className="appearance-settings-row-title">{i18n.t('appearance.diffMarker')}</span>
            </div>
            <div
              className="appearance-segmented appearance-segmented--inline"
              role="group"
              aria-label={i18n.t('appearance.diffMarker')}
            >
              {(['color', 'sign'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={settings.diffMarkerMode === mode ? 'is-active' : undefined}
                  onClick={() => setDiffMarkerMode(mode)}
                >
                  {i18n.t(`appearance.diffMarker.${mode}`)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <footer className="appearance-panel-footer">
        <button type="button" className="appearance-reset-btn" onClick={reset}>
          {i18n.t('appearance.reset')}
        </button>
      </footer>
    </div>
  );
}

export function ThemeModeCards({
  i18n,
  mode,
  onChange,
}: {
  readonly i18n: I18nRuntime;
  readonly mode: AppearanceMode;
  readonly onChange: (mode: AppearanceMode) => void;
}) {
  const cards: Array<{ id: AppearanceMode; title: string; hint: string }> = [
    { id: 'system', title: i18n.t('appearance.mode.system'), hint: 'A' },
    { id: 'light', title: i18n.t('appearance.mode.light'), hint: 'A' },
    { id: 'dark', title: i18n.t('appearance.mode.dark'), hint: 'A' },
  ];

  return (
    <div className="theme-mode-cards" role="radiogroup" aria-label={i18n.t('appearance.mode')}>
      {cards.map((card) => {
        const selected = mode === card.id;
        return (
          <button
            key={card.id}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`theme-mode-card theme-mode-card--${card.id}${selected ? ' is-selected' : ''}`}
            onClick={() => onChange(card.id)}
          >
            <span className="theme-mode-card-preview" aria-hidden="true">
              <span className="theme-mode-card-preview-sidebar" />
              <span className="theme-mode-card-preview-main">
                <span className="theme-mode-card-preview-line" />
                <span className="theme-mode-card-preview-line theme-mode-card-preview-line--short" />
              </span>
            </span>
            <span className="theme-mode-card-label">{card.title}</span>
          </button>
        );
      })}
    </div>
  );
}

export function ThemeLivePreview({
  i18n,
  activeScheme,
  paletteLabel,
  previewColors,
  diffMarkerMode,
}: {
  readonly i18n: I18nRuntime;
  readonly activeScheme: AppearanceScheme;
  readonly paletteLabel: string;
  readonly previewColors: {
    readonly accent: string;
    readonly background: string;
    readonly foreground: string;
  };
  readonly diffMarkerMode: 'color' | 'sign';
}) {
  const codeLines = [
    { text: `// ${paletteLabel} · ${activeScheme}`, tone: 'muted' as const },
    { text: 'const theme = {', tone: 'fg' as const },
    { text: `  accent: "${previewColors.accent}",`, tone: 'accent' as const },
    { text: `  background: "${previewColors.background}",`, tone: 'fg' as const },
    { text: `  foreground: "${previewColors.foreground}",`, tone: 'fg' as const },
    { text: '};', tone: 'fg' as const },
  ];

  const diffRows = [
    { kind: 'ctx' as const, text: ' export function render() {' },
    { kind: 'del' as const, text: '   return <OldTheme />;' },
    { kind: 'add' as const, text: '   return <NewTheme />;' },
    { kind: 'ctx' as const, text: ' }' },
  ];

  return (
    <div
      className="theme-live-preview"
      style={{
        // 预览区局部映射当前语义色，随 mode/palette 即时变化
        ['--preview-accent' as string]: previewColors.accent,
        ['--preview-bg' as string]: previewColors.background,
        ['--preview-fg' as string]: previewColors.foreground,
      }}
    >
      <div className="theme-live-preview-pane">
        <div className="theme-live-preview-pane-title">{i18n.t('appearance.preview')}</div>
        <pre className="theme-live-preview-code" aria-hidden="true">
          {codeLines.map((line) => (
            <code
              key={line.text}
              className={
                line.tone === 'accent'
                  ? 'is-accent'
                  : line.tone === 'muted'
                    ? 'is-muted'
                    : undefined
              }
            >
              {line.text}
            </code>
          ))}
        </pre>
      </div>
      <div className="theme-live-preview-pane">
        <div className="theme-live-preview-pane-title">{i18n.t('appearance.diffPreview')}</div>
        <div className="theme-live-preview-diff" aria-hidden="true">
          {diffRows.map((row, index) => {
            const sign =
              row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ';
            const showSign = diffMarkerMode === 'sign' || row.kind === 'ctx';
            return (
              <div
                key={`${row.kind}-${index}`}
                className={`theme-live-preview-diff-row is-${row.kind}`}
              >
                <span className="theme-live-preview-diff-sign">
                  {showSign ? sign : ' '}
                </span>
                <span className="theme-live-preview-diff-text">{row.text}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
