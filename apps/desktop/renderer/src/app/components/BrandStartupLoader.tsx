import { useId, useLayoutEffect, useRef } from 'react';

const SUPPORT_GAP = 11;
/** Deep ink black for the wordmark fill — stays solid black through intro and hold. */
const INK_BLACK = '#1a1d21';

export function BrandStartupLoader() {
  const id = useId().replace(/:/g, '');
  const textRef = useRef<SVGTextElement>(null);
  const supportLineRef = useRef<SVGLineElement>(null);

  useLayoutEffect(() => {
    const positionSupportLine = () => {
      const text = textRef.current;
      const line = supportLineRef.current;
      if (!text || !line) return;

      const bounds = text.getBBox();
      const y = bounds.y + bounds.height + SUPPORT_GAP;
      line.setAttribute('x1', String(bounds.x));
      line.setAttribute('x2', String(bounds.x + bounds.width));
      line.setAttribute('y1', String(y));
      line.setAttribute('y2', String(y));
    };

    positionSupportLine();
    void document.fonts?.ready.then(positionSupportLine);
  }, []);

  const shineGradientId = `brand-startup-shine-${id}`;
  const edgeBlurId = `brand-startup-edge-${id}`;
  const fillMaskId = `brand-startup-mask-${id}`;

  return (
    <div className="brand-startup-loader" role="status" aria-label="Peer Agent is starting">
      {/*
        Post-intro loading state: soft ink-wash pigment blots that bloom and diffuse
        behind the settled black wordmark (水墨颜料散开).
      */}
      <div className="brand-startup-loader__ink-wash" aria-hidden="true">
        <span className="brand-startup-loader__ink-blot brand-startup-loader__ink-blot--a" />
        <span className="brand-startup-loader__ink-blot brand-startup-loader__ink-blot--b" />
        <span className="brand-startup-loader__ink-blot brand-startup-loader__ink-blot--c" />
      </div>

      <div className="brand-startup-loader__brand" role="img" aria-label="Peer Agent">
        <svg
          className="brand-startup-loader__lockup"
          viewBox="0 0 1000 220"
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id={shineGradientId} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#9ecbe0" stopOpacity="0" />
              <stop offset=".2" stopColor="#9ecbe0" stopOpacity=".95" />
              <stop offset=".5" stopColor="#fff" />
              <stop offset=".78" stopColor="#9ecbe0" stopOpacity=".9" />
              <stop offset="1" stopColor="#9ecbe0" stopOpacity="0" />
            </linearGradient>
            <filter id={edgeBlurId} x="-10%" y="-100%" width="120%" height="300%">
              <feGaussianBlur stdDeviation="3" />
            </filter>
            <mask id={fillMaskId} maskUnits="userSpaceOnUse" x="0" y="0" width="1000" height="220">
              <rect className="brand-startup-loader__fill-mask" x="0" y="0" width="1000" height="220" fill="#fff" />
            </mask>
          </defs>

          <text
            ref={textRef}
            className="brand-startup-loader__wordmark brand-startup-loader__wordmark--ghost"
            x="500"
            y="150"
          >
            Peer Agent
          </text>
          {/* Solid deep-ink fill (black throughout intro; no spectrum). */}
          <text
            className="brand-startup-loader__wordmark brand-startup-loader__wordmark--ink"
            x="500"
            y="150"
            fill={INK_BLACK}
            mask={`url(#${fillMaskId})`}
          >
            Peer Agent
          </text>
          {/* Horizontal liquid-edge sheen only (no rising tip path). */}
          <rect
            className="brand-startup-loader__liquid-edge"
            x="120"
            y="104"
            width="760"
            height="12"
            rx="6"
            fill={`url(#${shineGradientId})`}
            filter={`url(#${edgeBlurId})`}
          />
          <line ref={supportLineRef} className="brand-startup-loader__support" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}
