import type { CSSProperties } from 'react';
import { useMotionAllowed } from '../../../app/hooks/useMotionAllowed';

const MOTE_LANES = [30, 72, 44, 80, 24, 64, 37, 76] as const;

/** Decorative presentation only; the native range remains the input and accessibility owner. */
export function EffortSliderVisual({ value, disabled }: { readonly value: number; readonly disabled: boolean }) {
  const motion = useMotionAllowed();
  const center = `calc(var(--effort-thumb) / 2 + (100% - var(--effort-thumb)) * ${value} / 100)`;
  return <>
    <div className="reasoning-effort-slider-track" aria-hidden="true">
      <div className="reasoning-effort-slider-fill" style={{ width: center }}>
        {motion && !disabled && value > 0 ? <svg className="reasoning-effort-slider-motes" width="100%" height="100%" aria-hidden="true" focusable="false">
          {MOTE_LANES.map((y, index) => <circle key={index} cx="0" cy={`${y}%`} r={index % 3 === 0 ? 1.5 : 1}
            style={{ '--effort-mote-delay': `calc(var(--effort-mote-duration) * -${index / MOTE_LANES.length})`,
              '--effort-mote-duration': `calc(var(--za-motion-slow) * ${6 + index % 3})` } as CSSProperties} />)}
        </svg> : null}
      </div>
    </div>
    <span className="reasoning-effort-slider-visual-thumb" style={{ left: center }} aria-hidden="true" />
  </>;
}
