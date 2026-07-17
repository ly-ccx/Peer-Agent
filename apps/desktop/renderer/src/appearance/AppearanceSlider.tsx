import { useId } from 'react';

/**
 * AppearanceSlider —— 品牌化自绘滑块。
 *
 * 设计取舍：底层仍用原生 <input type="range"> 承载交互与无障碍（键盘、
 * 屏幕阅读器、ARIA 值语义都免费获得），但用 CSS 完全接管 track / thumb 的
 * 外观：填充进度轨道用 `--slider-pct` 变量驱动，圆形 thumb + hover/focus 反馈
 * 由 appearance.css 统一定义，随主题 token（--za-accent 等）浅深自适应。
 *
 * 组件本身不持有状态，value / onChange 全由调用方受控，保证与设置双向同步不变。
 */
export function AppearanceSlider({
  value,
  min,
  max,
  step = 1,
  onChange,
  ariaLabel,
}: {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly onChange: (next: number) => void;
  readonly ariaLabel?: string;
}) {
  const id = useId();
  const span = max - min;
  const ratio = span > 0 ? (value - min) / span : 0;
  const pct = Math.min(100, Math.max(0, ratio * 100));

  return (
    <span
      className="appearance-slider"
      style={{ ['--slider-pct' as string]: `${pct}%` }}
    >
      <input
        id={id}
        className="appearance-slider-input"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={ariaLabel}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
      />
    </span>
  );
}
