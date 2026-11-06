import { useEffect, useRef, type RefObject } from 'react';
import { motionAllowed, subscribeMotionEnvironment } from '../state/motionEnvironment';
import { PARTICLE_SHATTER_MAX_MS, resizeShatterCanvas, runParticleShatter, sampleElementParticles,
  type ParticleShatterHandle } from './particleShatter';

export type ParticleShatterOverlayProps = {
  readonly active: boolean;
  readonly targetRef: RefObject<HTMLElement | null>;
  readonly onDone?: () => void;
  readonly className?: string;
  readonly padX?: number;
  readonly padY?: number;
};
/** No capture or frame work when static; the real card stays visible until pixels can replace it. */
export function ParticleShatterOverlay({ active, targetRef, onDone, className, padX = 72, padY = 80 }: ParticleShatterOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const done = useRef(onDone); done.current = onDone;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(), target = targetRef.current, canvas = canvasRef.current;
    let live = true, completed = false, handle: ParticleShatterHandle | null = null;
    const restore = () => { target?.removeAttribute('data-peer-shatter-painted'); };
    const finish = () => { if (!live || completed) return; completed = true; done.current?.(); };
    if (!motionAllowed() || !target || !canvas || typeof requestAnimationFrame !== 'function') { finish(); return; }
    const stop = subscribeMotionEnvironment(() => {
      if (motionAllowed()) return;
      controller.abort(); handle?.stop(); restore(); finish();
    });
    void (async () => {
      try {
        const particles = await sampleElementParticles(target, { originX: padX, originY: padY, signal: controller.signal });
        if (!live || completed || controller.signal.aborted) return;
        if (!motionAllowed() || !particles.length) { finish(); return; }
        const rect = target.getBoundingClientRect();
        resizeShatterCanvas(canvas, rect.width, rect.height, padX, padY);
        if (!canvas.getContext('2d')) { finish(); return; }
        target.setAttribute('data-peer-shatter-painted', 'true');
        handle = runParticleShatter({ canvas, particles, maxDurationMs: PARTICLE_SHATTER_MAX_MS, onDone: finish });
      } catch { if (live) { restore(); finish(); } }
    })();
    return () => { live = false; stop(); controller.abort(); handle?.stop(); restore(); };
  }, [active, padX, padY, targetRef]);
  return <canvas ref={canvasRef} className={className ?? 'particle-shatter-canvas'} aria-hidden="true" />;
}
