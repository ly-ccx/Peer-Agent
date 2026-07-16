import { useId, useLayoutEffect, useRef } from 'react';

const SUPPORT_GAP = 11;

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

  const inkGradientId = `brand-startup-ink-${id}`;
  const shineGradientId = `brand-startup-shine-${id}`;
  const edgeBlurId = `brand-startup-edge-${id}`;
  const fillMaskId = `brand-startup-mask-${id}`;

  return (
    <div className="brand-startup-loader" role="status" aria-label="Peer Agent is starting">
      <div className="brand-startup-loader__brand" role="img" aria-label="Peer Agent">
        <svg
          className="brand-startup-loader__lockup"
          viewBox="0 0 1000 220"
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id={inkGradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#497f9f" />
              <stop offset=".24" stopColor="#1a1d21" />
              <stop offset="1" stopColor="#111419" />
            </linearGradient>
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
              <rect className="brand-startup-loader__fill-mask" x="0" y="0" width="1000" height="224" fill="white" />
            </mask>
          </defs>

          <text ref={textRef} className="brand-startup-loader__wordmark brand-startup-loader__wordmark--ghost" x="500" y="164">
            Peer Agent
          </text>
          <text
            className="brand-startup-loader__wordmark brand-startup-loader__wordmark--fill"
            x="500"
            y="164"
            fill={`url(#${inkGradientId})`}
            mask={`url(#${fillMaskId})`}
          >
            Peer Agent
          </text>

          <g className="brand-startup-loader__liquid-edge" filter={`url(#${edgeBlurId})`}>
            <ellipse cx="500" cy="110" rx="420" ry="8" fill={`url(#${shineGradientId})`} />
          </g>
          <path
            className="brand-startup-loader__liquid-crest"
            d="M496 111 C496 98 498 91 500 88 C503 92 505 100 504 111 Z"
            fill="rgba(255,255,255,.88)"
          />
          <line ref={supportLineRef} className="brand-startup-loader__support" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}
