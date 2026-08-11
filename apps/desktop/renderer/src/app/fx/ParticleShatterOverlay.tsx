import { useEffect, useRef, type RefObject } from 'react';
import {
  PARTICLE_SHATTER_MAX_MS,
  resizeShatterCanvas,
  runParticleShatter,
  sampleElementParticles,
  type ParticleShatterHandle,
} from './particleShatter';

export type ParticleShatterOverlayProps = {
  /** 为 true 时对 target 采样并播放从右向左粉碎。 */
  readonly active: boolean;
  /** 被粉碎的整卡 DOM。 */
  readonly targetRef: RefObject<HTMLElement | null> | RefObject<HTMLDivElement | null>;
  /** 动画播完（或失败回退结束）后回调。 */
  readonly onDone?: () => void;
  readonly className?: string;
  readonly padX?: number;
  readonly padY?: number;
};

/**
 * 叠在卡片上层的 canvas 粉碎层。
 * 激活时：采样 target → 隐藏由父级 class 控制 → 播放粒子 → onDone。
 */
export function ParticleShatterOverlay({
  active,
  targetRef,
  onDone,
  className,
  padX = 72,
  padY = 80,
}: ParticleShatterOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handleRef = useRef<ParticleShatterHandle | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const playedForActiveRef = useRef(false);

  useEffect(() => {
    if (!active) {
      playedForActiveRef.current = false;
      handleRef.current?.stop();
      handleRef.current = null;
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
      }
      return;
    }

    if (playedForActiveRef.current) return;
    playedForActiveRef.current = true;

    let cancelled = false;
    const canvas = canvasRef.current;
    const target = targetRef.current;
    if (!canvas || !target) {
      onDoneRef.current?.();
      return;
    }

    const run = async () => {
      try {
        // 先采样可见卡片，再由父级把卡片 visibility:hidden
        const rect = target.getBoundingClientRect();
        resizeShatterCanvas(canvas, rect.width, rect.height, padX, padY);
        const particles = await sampleElementParticles(target, {
          originX: padX,
          originY: padY,
        });

        if (cancelled) return;

        // 把粒子坐标系对齐到 canvas（canvas 覆盖 target 外扩 pad）
        handleRef.current = runParticleShatter({
          canvas,
          particles,
          maxDurationMs: PARTICLE_SHATTER_MAX_MS,
          onDone: () => {
            if (!cancelled) onDoneRef.current?.();
          },
        });
      } catch {
        if (!cancelled) onDoneRef.current?.();
      }
    };

    void run();

    return () => {
      cancelled = true;
      handleRef.current?.stop();
      handleRef.current = null;
    };
  }, [active, padX, padY, targetRef]);

  return (
    <canvas
      ref={canvasRef}
      className={className ?? 'particle-shatter-canvas'}
      aria-hidden="true"
    />
  );
}
