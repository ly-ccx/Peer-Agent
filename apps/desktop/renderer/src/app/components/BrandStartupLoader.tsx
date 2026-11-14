import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../state/motionEnvironment';
import {
  CAT_ANCHOR_X_RATIO,
  CAT_ANCHOR_Y_RATIO,
  CAT_BOUNCE_DURATION_MS,
  CAT_REVEAL_DURATION_MS,
  CAT_SILHOUETTE_VIEWBOX,
  buildCatSilhouettePath,
  buildCutoutOverlayPath,
  computeRevealTargetScale,
  sampleRevealFrame,
} from './brandStartupReveal';

/** Sidebar brand marks — prewarm during startup so left-top logo is ready after transition. */
const SIDEBAR_LOGO_SRCS = ['./logo-light.png', './logo-dark.png'] as const;
const BASE_CAT_PATH = buildCatSilhouettePath();
const CAT_STROKE_BASE_PX = 1.6;

function preloadSidebarLogos(): void {
  if (typeof Image === 'undefined') return;
  for (const src of SIDEBAR_LOGO_SRCS) {
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
  }
}

export interface BrandStartupLoaderProps {
  /** True once main shell session is ready to reveal through the cat silhouette. */
  readonly ready?: boolean;
  /** Called once the zoom-through reveal finishes or is interrupted. */
  readonly onRevealComplete?: () => void;
}

/**
 * Branded kitten silhouette startup loader & perspective cutout reveal.
 *
 * Phase 1 (entrance & wait): centered kitten-head silhouette pops in with a
 *   bouncy squash-and-stretch spring, then breathes gently if bootstrap continues.
 * Phase 2 (reveal, once `ready` is true): cat head pulls back slightly and zooms
 *   outward as a crisp vector cutout portal, revealing the live app through it.
 */
export function BrandStartupLoader({
  ready = false,
  onRevealComplete,
}: BrandStartupLoaderProps = {}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const brandRef = useRef<HTMLDivElement | null>(null);
  const portalSvgRef = useRef<SVGSVGElement | null>(null);
  const scrimPathRef = useRef<SVGPathElement | null>(null);
  const veilCatRef = useRef<SVGPathElement | null>(null);
  const solidCatRef = useRef<SVGPathElement | null>(null);
  const rimCatRef = useRef<SVGPathElement | null>(null);

  const [introDone, setIntroDone] = useState(() => prefersReducedMotion());
  const completeRef = useRef(onRevealComplete);
  completeRef.current = onRevealComplete;
  const completedRef = useRef(false);

  const finishReveal = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    completeRef.current?.();
  }, []);

  // Second warm-up while the transition page is visible (HTML preload is the first).
  useLayoutEffect(() => {
    preloadSidebarLogos();
  }, []);

  // Bounded safety timer so introDone never stalls if CSS animationend is skipped.
  useEffect(() => {
    if (introDone) return;
    if (prefersReducedMotion()) {
      setIntroDone(true);
      return;
    }
    const timer = window.setTimeout(() => {
      setIntroDone(true);
    }, CAT_BOUNCE_DURATION_MS + 90);
    return () => window.clearTimeout(timer);
  }, [introDone]);

  // Under reduced motion, immediately release as soon as main shell is ready.
  useEffect(() => {
    if (!ready) return;
    if (prefersReducedMotion()) {
      finishReveal();
    }
  }, [ready, finishReveal]);

  // Interruptible reveal: user input or live reduced-motion change finishes at once.
  useEffect(() => {
    if (!ready) return;
    const onPointerOrKey = () => finishReveal();
    window.addEventListener('pointerdown', onPointerOrKey, { capture: true, passive: true });
    window.addEventListener('keydown', onPointerOrKey, { capture: true, passive: true });

    let media: MediaQueryList | null = null;
    try {
      media = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
    } catch {
      media = null;
    }
    const onMotionChange = () => {
      if (media?.matches) finishReveal();
    };
    media?.addEventListener?.('change', onMotionChange);

    return () => {
      window.removeEventListener('pointerdown', onPointerOrKey, { capture: true });
      window.removeEventListener('keydown', onPointerOrKey, { capture: true });
      media?.removeEventListener?.('change', onMotionChange);
    };
  }, [ready, finishReveal]);

  const revealing = ready && introDone && !prefersReducedMotion();

  useLayoutEffect(() => {
    if (!revealing) return;
    if (prefersReducedMotion()) {
      finishReveal();
      return;
    }

    const stage = stageRef.current;
    const brand = brandRef.current;
    const portalSvg = portalSvgRef.current;
    const scrimPath = scrimPathRef.current;
    const veilCat = veilCatRef.current;
    const solidCat = solidCatRef.current;
    const rimCat = rimCatRef.current;
    if (!stage || !brand || !portalSvg || !scrimPath || !veilCat || !solidCat || !rimCat) {
      finishReveal();
      return;
    }

    const stageRect = stage.getBoundingClientRect();
    const brandRect = brand.getBoundingClientRect();
    const initialWidth = stageRect.width;
    const initialHeight = stageRect.height;
    if (initialWidth <= 0 || initialHeight <= 0 || brandRect.width <= 0) {
      finishReveal();
      return;
    }

    const baseScale = brandRect.width / 200;
    const anchorOffsetX = (CAT_ANCHOR_X_RATIO - 0.5) * brandRect.width;
    const anchorOffsetY = (CAT_ANCHOR_Y_RATIO - 0.5) * brandRect.height;

    const applyFrame = (elapsedRatio: number) => {
      const currentRect = stage.getBoundingClientRect();
      const width = currentRect.width > 0 ? currentRect.width : initialWidth;
      const height = currentRect.height > 0 ? currentRect.height : initialHeight;
      const cx = width * 0.5 + anchorOffsetX;
      const cy = height * 0.5 + anchorOffsetY;
      const targetScale = computeRevealTargetScale({ width, height, cx, cy, baseScale });
      const frame = sampleRevealFrame(elapsedRatio, targetScale);
      const sx = baseScale * frame.scaleX;
      const sy = baseScale * frame.scaleY;

      portalSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      scrimPath.setAttribute(
        'd',
        buildCutoutOverlayPath({ width, height, cx, cy, scaleX: sx, scaleY: sy }),
      );
      scrimPath.style.opacity = String(frame.scrimOpacity);

      const catPath = buildCatSilhouettePath({ cx, cy, scaleX: sx, scaleY: sy });
      solidCat.setAttribute('d', catPath);
      solidCat.style.opacity = String(frame.solidOpacity);

      veilCat.setAttribute('d', catPath);
      veilCat.style.opacity = String(frame.veilOpacity);

      rimCat.setAttribute('d', catPath);
      rimCat.style.opacity = String(frame.rimOpacity);
      rimCat.style.strokeWidth = `${Math.max(1.2, CAT_STROKE_BASE_PX * Math.min(3.5, Math.sqrt(frame.scaleX)))}`;
    };

    // Paint frame 0 synchronously before revealing the portal layer so there is zero flash.
    applyFrame(0);
    stage.dataset.revealing = 'true';

    let rafId = 0;
    let startTime: number | null = null;
    let disposed = false;

    const step = (now: number) => {
      if (disposed) return;
      if (prefersReducedMotion()) {
        finishReveal();
        return;
      }
      if (startTime === null) startTime = now;
      const elapsedRatio = Math.min(1, (now - startTime) / CAT_REVEAL_DURATION_MS);
      applyFrame(elapsedRatio);
      if (elapsedRatio >= 1) {
        finishReveal();
        return;
      }
      rafId = window.requestAnimationFrame(step);
    };

    rafId = window.requestAnimationFrame(step);
    const hardStop = window.setTimeout(() => {
      if (!disposed) finishReveal();
    }, CAT_REVEAL_DURATION_MS + 180);

    return () => {
      disposed = true;
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(hardStop);
      delete stage.dataset.revealing;
    };
  }, [revealing, finishReveal]);

  return (
    <div
      ref={stageRef}
      className="brand-startup-loader"
      role="status"
      aria-label="Peer Agent is starting"
    >
      <div
        ref={brandRef}
        className={`brand-startup-loader__brand${introDone ? ' is-waiting' : ''}`}
        role="img"
        aria-label="Peer Agent"
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget && event.animationName === 'brand-startup-cat-bounce') {
            setIntroDone(true);
          }
        }}
      >
        <svg
          className="brand-startup-loader__lockup"
          viewBox={CAT_SILHOUETTE_VIEWBOX}
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
        >
          <path className="brand-startup-loader__cat-silhouette" d={BASE_CAT_PATH} />
        </svg>
      </div>

      <svg
        ref={portalSvgRef}
        className="brand-startup-loader__portal"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path ref={scrimPathRef} className="brand-startup-loader__scrim" fillRule="evenodd" />
        <path ref={veilCatRef} className="brand-startup-loader__portal-veil" />
        <path ref={solidCatRef} className="brand-startup-loader__portal-solid" />
        <path ref={rimCatRef} className="brand-startup-loader__portal-rim" />
      </svg>
    </div>
  );
}
